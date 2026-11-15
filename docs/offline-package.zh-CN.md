# 离线作品包运行时（0.5.3）

本入口不需要逐作品 HTTP 资源服务。宿主提供 manifest 与文件字节，SDK 在不透明 iframe 中创建 Blob 资源并执行作品。作品仍直接调用 `window.game`，不安装 SDK。

**这是原生浏览器的尽力网络限制，不是零联网承诺。** WebRTC/STUN、自身导航等出口不能获得绝对阻断保证；不提供任意 URL 宿主代理。CSP 及 iframe sandbox 是浏览器防御，包内 fetch 兼容层不是安全边界。

## 固定接口

```ts
import {
  SANDBOX_RUNTIME_VERSION, // "0.5.3"，与 package.json 一致
  prepareSandboxPackage,
  createSandboxPackageSession,
  type SandboxPackageInput,
  type SandboxStorageAdapter,
} from "@codemao-pickcat/browser-game-sandbox";

// input.manifest = {
//   formatVersion: 1, entrypoint: "index.html",
//   files: { "index.html": { sha256: "64位小写十六进制", size: 123 }, ... }
// }
// input.files = { "index.html": Uint8Array, ... }
// 浏览器预览建议使用 Worker 解析，并在离开页面时取消。
// Node 部署校验继续使用不带 options 的调用。
const controller = new AbortController();
const prepared = await prepareSandboxPackage(input satisfies SandboxPackageInput, {
  worker: true,
  signal: controller.signal,
});
const session = createSandboxPackageSession({
  container,
  package: prepared,
  permissions, // 可信 player 完成授权后显式传入；默认 []
  clipboard, // 可选 SandboxClipboardAdapter；同时要求 clipboardRead
  storage, // 可选，宿主闭包绑定固定作用域
  onTerminate(reason) { /* 释放业务状态；不要将未过滤的 reason 插入 HTML */ },
});
await session.connected; // 可信 bootstrap 端口及原有 Host RPC 握手成功
await session.ready;     // 接收、重新校验、资源装载及初始脚本执行完成（含 module TLA）
// session.iframe 可用于布局；不要修改其 sandbox/src/srcdoc/allow。
session.terminate("player closed");
```

`prepareSandboxPackage` 同时支持 Node.js 24+ 与浏览器；使用 parse5、css-tree、Acorn 解析，**不引用浏览器 DOM、不执行作品代码、不访问网络**。它校验根入口、完整文件集、SHA-256、字节长度、路径与已知格式的解析约束，并复制输入字节，后续修改输入不改变准备结果。返回的 `PreparedSandboxPackage` 是当前 JS realm 中的不可变句柄，不可 JSON 序列化/跨进程复用；服务端准备通过后，player 下载同一包并重新准备。

宿主需运行于 http(s) Origin（生产应使用 HTTPS）。普通 bundler 可使用包根入口；无 bundler 的可信 player 可同源托管 `@codemao-pickcat/browser-game-sandbox/package.runtime.js`，它是无外部依赖的 ESM bundle，包含可信 bootstrap 字符串。禁止从作品包中替换此运行时。`game.preload.js` 是旧跨源资源服务入口，离线包不依赖它。

MOSS 为使用 npm 的部署提供 `formatVersion: 2` 清单。`moduleAliases` 将 `npm:<包名>@<精确版本或 latest>` 映射到清单中 `__moss_npm__/<sha256>.mjs` 的已校验文件。宿主必须提供对应字节。多个别名指向同一文件时共享模块实例，作品 Worker 不支持这些别名。一般作品仍可使用 v1 清单。

## 作品可选权限

```ts
export type SandboxPackagePermission = "worker" | "wasm" | "pointerLock" | "eval" | "clipboardRead";
// 固定顺序、冻结的 tuple：
SANDBOX_PACKAGE_PERMISSIONS; // ["worker", "wasm", "pointerLock", "eval", "clipboardRead"]
declare function normalizeSandboxPackagePermissions(input: unknown): SandboxPackagePermission[];
// createSandboxPackageSession 新增：
// permissions?: readonly SandboxPackagePermission[]
// clipboard?: SandboxClipboardAdapter
```

normalize 拒绝非数组（包括 undefined/null）、稀疏数组、未知值及非字符串项，抛 TypeError；返回新数组，去重并按上述顺序排序，不改输入。`eval` 必须蕴含 `wasm`：浏览器 CSP 的 `unsafe-eval` 本身也放开 WASM。会话仅在省略 permissions 或其值为 undefined 时默认 `[]`；显式错误输入在创建 iframe 前失败。权限不写入 manifest，也不从代码或 prepare 结果推断。

**MOSS 可信 player 必须先完成授权，再调用 createSandboxPackageSession。** 创建会话立即进入执行流程，不是申请授权；SDK 不校验观看者是否同意，不能在等待授权期间先开默认提权的“临时会话”。变更授权应先 terminate 旧会话，再以新权限创建。

`buildOfflineBrowserPolicy(permissions = [])` 使用相同校验与归一化；始终保留 `allow-scripts`，永不加入 `allow-same-origin`。`worker` 将 `worker-src 'none'` 改为 `worker-src blob:`；`wasm` 为 script-src 加 `wasm-unsafe-eval`；`eval` 加 `unsafe-eval`（同时 WASM）；仅 `pointerLock` 添加 `allow-pointer-lock`。全部权限均不放开联网。不能替换成含 `allow-same-origin` 的通用 `buildBrowserPolicy`。

prepare 不执行代码，不再按直接 eval/new Function 静态拒绝；真正执行时由 CSP 校验，包括 Worker 继承的策略。未授权时在浏览器执行处失败。动态代码字符串保持不透明，其中的资源/import/Worker 引用不透明重写，也不视作已验证的包内引用。XHR、SharedWorker、importScripts 等原不支持策略保留；静态识别只是兼容性策略，不是不可绕过的 API 黑名单。Worker 包装仅用于兼容与清理，不是数量、CPU 或内存硬配额。

### 剪贴板只经 Host RPC

```ts
export interface SandboxClipboardAdapter {
  readText(signal: AbortSignal): Promise<string>;
}
// 仅 clipboardRead 授权且提供 adapter 时存在：
const text: string = await window.game.clipboardReadText({});
// 沿用已有可选 RPC 参数：
// game.clipboardReadText({}, { signal, timeoutMs })
```

输入是严格空对象，缺失/null/数组/额外字段拒绝。返回 string，最多 **8192 UTF-8 bytes**，不是字符数。复用已有 plugin/Host RPC schema、capability、取消和错误脱敏；最多一个进行中的读取，并发请求拒绝而非排队，Host 与默认客户端超时均 30 秒，调用方不能延长 Host 上限。adapter 在创建时绑定，接收当前请求的 AbortSignal；停止、取消、超时均 abort，迟到文本丢弃。即使 adapter 不响应取消，也保留其读取名额直至 settle，避免底层读取重叠；已开始的原生读取无法撤销。浏览器剪贴板权限与用户手势交由宿主/player 处理。不会为作品提供 navigator.clipboard 回退，也不授予原生权限：iframe allow 仍明确禁止 clipboard-read/write，浏览器策略同样保持禁用。

## 预算与文件格式

Node 准备、浏览器准备和子端传输共同使用 `SANDBOX_PACKAGE_LIMITS`：

- 最多 2000 个文件；每个路径最多 512 UTF-8 bytes。
- 单文件最多 25 MiB，总原始字节最多 50 MiB；解析文本上限也是 25 MiB。
- 编译后的资源计划最多 100 MiB；CSS/Blob 依赖图不得成环（ES module 环可用）。
- 相同 SHA 的多个逻辑路径可以共用输入 Uint8Array/ArrayBuffer；预算仍逐逻辑文件累计。SDK 不 transfer/detach 调用者输入 buffer。
- 包独立通道、256 KiB 传输分块、逐块确认；会话装载总超时 30s。初始 RPC 握手保持原有 5s 超时。
- 原有通用 RPC **仍为 64 KiB**，没有为传包调大；30 请求/秒、并发/请求 ID/取消/超时/销毁检查照常生效。
- 路径为规范的包相对路径，禁止空段、`.`/`..`、前导 `/`、反斜线、控制字符、空白、`% : ? #`。引用允许 `./`、`../`（不得越过包根）及 `/` 包根相对写法；先逐段解码并校验深度，再进行 URL 规范化，编码的 dot 段与 literal dot 段同义，越过包根一律拒绝而非 clamp。正常 Unicode/文件名 URL 编码可用；编码的 slash/backslash、双重编码及非法编码拒绝，query/hash 不参与路径深度判断。
- 普通静态资源引用允许 query（如 `img.png?v=1`）：查找只使用包路径，物化 Blob 时丢弃 query、保留完整 fragment（包括 fragment 内的 `?`）。不同 query 不代表不同网络资源或缓存版本，字节版本只由 manifest/SHA 决定；ES module 引用仍明确拒绝 query/hash。
- 已知 HTML/CSS/JS/SVG 必须为 UTF-8，原有解析与错误不降级为数据。二进制文件保证字节完整性，不承诺解码器能播放任意损坏或浏览器不支持的媒体编码。

已知扩展名及 MIME 保持不变：`html css js mjs json txt csv xml png jpg jpeg gif webp avif ico svg woff woff2 ttf otf mp3 ogg wav m4a mp4 webm bin`。扩展名只取末段文件名的最后一个实际点号之后的内容，大小写不敏感；目录中的点号不参与。无后缀 `js`、`json` 等不是脚本或 JSON；未知扩展名、无后缀及 `constructor`、`toString`、`__proto__` 等路径作为 fallback 原始数据保留，GET/HEAD MIME 为 `application/octet-stream`。

Fallback 数据（如 `.glb/.gltf/.data/.wasm/.exe/.zip/.htm`）不自动生成 Blob URL，不可作为 script/module/stylesheet、HTML 资源属性、CSS `url()`/`image-set()`、literal `new URL(..., import.meta.url)` 或自动 Worker 脚本引用；这些用途报 `UNSUPPORTED_REFERENCE`。读取请使用 `fetch("model.glb")`，不要用 literal `new URL` 包装。已知 JSON/TXT/CSV/XML/BIN 等保留已有 Blob、资源引用及 literal `new URL` 兼容行为，不能因为 `.bin` 与 fallback 的 MIME 相同就授予 fallback Blob 资格。

只有根 `index.html` 可作为执行入口。其他 `.html`（如 `assets/template.html`）允许作为被动模板数据，仍校验 SHA-256、大小与 UTF-8；仅保留原始字节供包内相对 fetch 读取，不解析/改写模板、不生成 HTML Blob、不插入 DOM，也不提供次级文档或导航入口。ZIP 解包由平台负责，本 API 不解析 ZIP，也不递归解包嵌套压缩文件；ZIP 内 `.htm` 为 fallback 数据，平台将单文件 HTM 封装成 `index.html` 的语义不变。

只读数据描述 SDK 自动装载行为，不是安全边界：作品仍可自行解释字节、构造 Blob，或在已有策略内将 WebAssembly 字节交给 compile/instantiate；主线程及 Worker 的 WASM、eval/Function，以及 Worker 创建本身，均只在显式授权时可用，默认禁用。文件类型放宽不增加执行器、导航、下载、联网或宿主调用权限。

## 支持矩阵

| 模式 | 行为 |
| --- | --- |
| 根 HTML、普通布局与表单控件 | 仅根 `index.html` 编译为执行文档；支持布局与控件，不能提交表单 |
| 次级 HTML 模板（含嵌套路径） | 支持 `fetch("assets/template.html").text()`，GET/HEAD 返回原始字节及 `text/html` 类型；模板内容不作执行资源解析，其 script/meta/URL 只是数据，SDK 不激活它们 |
| 静态 `script src`、inline script | 支持；在完整 DOM 装载后按文档顺序执行；`async/defer` 归一为顺序执行 |
| `type="module"`（外部/内联） | 支持，含静态 import/export、循环引用、top-level await |
| `import("./literal.js")` | 支持普通字符串和无插值模板字符串；含插值或计算表达式、bare specifier、import attributes/JSON modules、module query/hash 变体明确拒绝。静态 `import`/`export … from` 按 JavaScript 语法使用普通字符串 |
| `new URL(path, import.meta.url)` | 按模块文件目录解析已知非 HTML 资源，包括计算所得的字符串路径。内联模块以根 `index.html` 为基准。Worker 图及静态 Worker 脚本入口使用字面量 |
| `new URL(path)`、`new URL(path, document.baseURI)` | 作品文档中的字符串路径以根 `index.html` 为基准。查询参数从包内 Blob URL 去除，片段保留。支持时 `URL.parse` 和 `URL.canParse` 使用相同的路径解析；HTML 和 fallback 数据可用包内 `fetch(path)` 读取 |
| stylesheet link、style、style 属性 | 支持；解析并重写 CSS `url()`、`@import`、`image-set()` URL，通过 CSS 字符串序列化保留引用和转义，包括 `#svgView(viewBox(...))` 等带括号 fragment；CSS Blob 依赖环拒绝 |
| 图片、字体、音频、视频的静态资源引用 | 支持已知非 HTML 资源，fallback 数据不得作为自动资源引用。`srcset`/`imagesrcset` 候选按 URL 和描述符分别处理（如 `1.5x`、`100w`）；`background` 为单 URL。包内资源物化为 Blob，内联 `data:` 保留，外部 URL 报 `EXTERNAL_URL`。保留的 stylesheet 链接上的 `imagesrcset` 直接删除。字节有效不代表浏览器支持该编码 |
| `new Audio("./audio/loop.mp3")` | `Audio` 的包内路径字符串（含运行时拼接）从根 `index.html` 解析，已知媒体文件使用子 iframe 的 Blob URL，保留媒体片段。动态设置 `audio.src` 时可用字面量 `new URL("./loop.mp3", import.meta.url).href` 或自行创建 Blob URL。请在作品内部的真实点击或触摸中调用 `play()` |
| 内联 `data:` URL | `src`/`srcset`/`poster`/`background`、CSS `url()`/`image-set()` 和字面量 `new URL` 的非执行资源位置允许，保留原 URL，不解码为包内文件；`img-src`/`font-src`/`media-src` 允许 `data:`，浏览器在图片上下文渲染 SVG 时不执行脚本。脚本、模块、Worker、样式表（含 `@import`）与直接 `fetch()` 不接受 `data:`，报 `INLINE_RESOURCE`；链接导航仍拒绝 |
| SVG | 仅自包含、无脚本/动画/外部 URL 的 SVG。`style` 属性按 CSS 声明列表校验，与表现属性一样只允许规定属性引用文档内部 `url(#id)`，不接受无法解析的 CSS 或活跃协议；仍不支持 `<style>`、`foreignObject`、`image`/`use` 等嵌入形式 |
| 静态引用带 query/fragment | HTML stylesheet/image/classic script、CSS url/import、literal `new URL` 只按包路径查找；query 不附加到 Blob，fragment 保留；不产生联网或独立 cache 版本，不适用于 ESM query/hash |
| `fetch("data.json")`、`fetch("model.glb")`、运行时计算包内相对路径 | 本地兼容层从完整文件集提供 GET/HEAD，返回原始包字节；HEAD 保留 MIME/字节长度且无响应体，fallback MIME 为 `application/octet-stream`。query/hash 不改变读取的文件或字节；相对路径始终以根 index.html 为基准，不以调用脚本为基准 |
| `fetch(new URL("./data.json", import.meta.url))` | 支持重写后的本地 Blob 对应原始字节；不存在的文件/外部 URL/非 GET-HEAD 明确 TypeError，无网络回退 |
| `fetch(new URL(URL.createObjectURL(blob)))` | 支持作品文档用 `URL.createObjectURL` 创建且仍有效的 Blob，GET/HEAD 在 iframe 内直接返回字节或响应头。片段可用，查询参数按浏览器 Blob URL 规则处理 |
| `window.game.storageGet/Set/Delete` | 提供 adapter 时支持，严格对象 schema；不提供 adapter 时不暴露存储方法 |
| fragment anchor 与 `a[href]`/`area[href]` | 支持；`a`/`area` 的非 fragment `href` 直接放行，既不重写也不报错，因为运行期 `package-loader.ts` 的 `onLinkClick` 已在捕获阶段对所有 `a[href]`/`area[href]` 无条件 `preventDefault`，只处理 `#fragment`；`javascript:`/`data:`/`vbscript:` 仍拒绝 |
| 外部 URL 与 CDN 依赖 | 静态可识别的资源引用拒绝，不回退联网；请先打包成本地文件 |
| 动态 DOM `src/href/style`、运行时拼接 CSS、任意 URL 构造模式 | 不做透明改写；作者需改为静态引用或 literal `new URL(..., import.meta.url)`；相对 URL 不能自动访问包资源，浏览器策略会产生资源错误 |
| 独立 Worker（需 worker 授权） | 支持子文档创建的 Blob Worker、literal 包内 `.js/.mjs` 路径及 `new Worker(new URL("./worker.js", import.meta.url), options)`；保留消息、transferable、classic/module 选项。模块 Worker 在 classic bootstrap 中通过 import 执行，初始化完成前排队消息（重放的 MessageEvent 为合成事件）；包内静态/动态 literal import 物化为 Blob 图，不支持循环依赖。包装器对其第 33 个直接存活 Worker 做兼容性拒绝，terminate 释放名额，会话销毁时终止跟踪项；嵌套 Worker/其他 realm 可绕过，不能视为 Worker 数量或 CPU/内存硬配额。Worker 内不提供 `window.game`、包内 fetch 或 Web Storage 兼容层，importScripts 不支持；动态 Blob 源需自包含，模块 import map 只存在于主文档。CSP 仅允许 Blob Worker，继续继承禁用外部连接的策略 |
| eval / Function / WASM | prepare 只解析不执行，允许出现；真正执行需要 eval / wasm（eval 蕴含 wasm），动态字符串内引用不重写 |
| SharedWorker/ServiceWorker、XHR、importScripts | 仍不支持；可识别的直接 SharedWorker/XHR/importScripts 构造/调用在 prepare 拒绝，另由 CSP/opaque Origin 尽力防御，不以删除全局函数宣称安全 |
| HTML 模板作为 script/module/stylesheet/iframe | 明确拒绝；被动 HTML 数据不是可执行 JS/CSS，也不是额外入口。作为 `a`/`area` 的链接目标则放行：不重写不校验，点击由运行期 `onLinkClick` 取消，不会加载模板 |
| 执行文档中的 iframe/frame/frameset/object/embed/applet/portal/base、`meta http-equiv="refresh"` | 明确拒绝（`UNSUPPORTED_HTML_ELEMENT`），不提供多文档或运行时引导兼容退路 |
| 其他 `meta http-equiv="..."` | 整条 `meta` 元素丢弃：Blob/srcdoc 文档没有可供这些指令覆盖的 HTTP 响应头 |
| SRI 与其他惰性属性、`nomodule` | `integrity/ping/manifest/codebase/archive/srcdoc` 在任何元素上直接删除；classic `<script nomodule>` 整个元素从文档移除，其 `src` 不重写、不物化，也不参与模块解析（只保留字节供包内 fetch），被移除的 `nomodule` 内联代码同样丢弃；`nomodule` 对 module 脚本无意义，故 `type="module" nomodule` 的脚本继续执行，只删除该属性 |
| 表单提交（`action`/`formaction`） | 明确拒绝（`UNSUPPORTED_HTML_FORM`）；布局与控件仍可用 |
| `link rel=icon/preload/prefetch/modulepreload/manifest`、`preconnect/dns-prefetch` | 编译时删除，不校验也不重写 `href`，因此 `data:,` favicon、缺失文件和外部 URL 均不阻断准备 |
| `rel` 组合写法（如 `rel="stylesheet preload"`） | 不区分 token 大小写与顺序；与 `stylesheet` 组合时只保留 stylesheet，`href` 仍按样式表引用校验；未知 token（如 `shortcut`）仍拒绝（`UNSUPPORTED_HTML_LINK`） |

JS 文件采用现代 ES module 语法校验；即使以 classic script 引用，也不支持依赖 `with` 等 sloppy-only 语法。内联事件属性也做语法校验，不支持依赖顶层 `return` 的 handler。`document.write`、脚本流式解析时机、`document.currentScript`（module）、`location` 的原始 HTTP 路径、直接读取 `import.meta.url` 的原始文件路径、XHR/流式请求及动态加载任意文件都不保证兼容。初始文档已完成 bootstrap；SDK 在初始脚本完成后回放一次 `DOMContentLoaded`/`load` 供常见作品初始化。后续异步业务任务、媒体播放与应用自定义状态不属于 `ready` 的保证范围。

不支持任意 ZIP 透明兼容。`SandboxPackageError.code` 区分 `INVALID_MANIFEST/INVALID_PATH/INTEGRITY/PACKAGE_TOO_LARGE/INVALID_ENCODING/UNSUPPORTED_REFERENCE`、缺失资源、CSS/JS/模块不兼容与资源环等错误；被拒的 HTML 细分为 `UNSUPPORTED_HTML_ELEMENT`（base/iframe/frame/frameset/object/embed/applet/portal、`meta http-equiv="refresh"`、`a`/`area` 的 `javascript:`/`data:`/`vbscript:` href）、`UNSUPPORTED_HTML_SCRIPT`（不支持的 script type、带 `src` 的 JSON script 块）、`UNSUPPORTED_HTML_LINK`（不支持的 `rel` token、有 `href` 但缺 `rel`）、`UNSUPPORTED_HTML_FORM`（`action`/`formaction`）；错误消息标明对应文件或模式。动态不支持的操作通过 TypeError、模块执行拒绝、资源 error 或 CSP 报告显式失败。准备成功不等于所有用户代码一定能成功运行；运行初始化失败会拒绝 `ready` 并销毁会话，不会 fake-ready。

### 已知不兼容

- **用 query 给资源传配置。** `player.js?g=work.love` 用包内的 `player.js` 装载，Blob URL 只保留 fragment；脚本读不到 `g`。请把配置写入包内脚本或用包内相对 `fetch` 读取配置文件。
- **运行时插入 `<script>` 或 stylesheet `<link>`。** 运行时不会重写它们的 URL；请用入口中的静态标签或支持的字面量模块导入。
- **带动态 preload URL 的 Vite 分包产物。** `__vitePreload` 生成的 `new URL(dep, import.meta.url)` 无法静态解析。对单入口作品可关闭 [`build.modulePreload`](https://vite.dev/config/build-options.html#build-modulepreload) 并合并 JS chunk：Rollup 版 Vite 使用 [`build.rollupOptions.output.inlineDynamicImports: true`](https://rollupjs.org/configuration-options/#output-inlinedynamicimports)，Rolldown 版使用 [`build.rolldownOptions.output.codeSplitting: false`](https://vite.dev/guide/build.html#chunking-strategy)。Top-level await 本身受支持，但未完成的 await 会使初始加载最终超时。
- **XHR 型 i18n 后端。** SDK 按调用或构造器名称识别 `XMLHttpRequest`，即使是在不会执行的分支。请改用内联语言资源或包内相对 `fetch`。

## 浏览器加载响应

`worker: true` 将 HTML、CSS、JS 解析交给 SDK 私有 Blob Worker；异步 SHA-256 校验保留在调用端，兼容不提供 SubtleCrypto 的 opaque Blob Worker。宿主 CSP 需允许 `worker-src blob:`。传入的文件字节不会被 detach，返回值仍是当前 realm 内的不可伪造句柄；不提供跨 realm 导入任意编译计划的接口。

`worker: true` 是可信 player 的解析选项，**不是作品的 worker 授权**；二者独立。`signal` 取消时会终止准备 Worker 并回收 Blob URL。SDK 子文档二次校验在其自身线程上做纯解析，不创建 Worker，因此不需作品 worker 权限；作品代码的初始化和渲染仍由浏览器执行，不承诺任意作品的 CPU 或内存硬隔离。`ready` 仍表示初始模块执行完成。

## 存储

离线作品 iframe 的原生 Web Storage 若因不透明 Origin 抛出 `SecurityError`，SDK 会在初始脚本前提供 `localStorage` 和 `sessionStorage` 的内存实现。兼容 `getItem`、`setItem`、`removeItem`、`clear`、`key` 与 `length`，按字符串读写。属性下标和 Worker 内访问不在兼容范围内。

MOSS 在运行作品脚本前通过 `window.game.storageLocalLoad({})` 恢复 `localStorage`。同步方法立即更新当前页面的内存，SDK 合并修改后通过 `window.game.storageLocalApply` 异步提交。宿主在 IndexedDB 事务内把改动应用到最新存档，来自不同会话的不同键可合并，同一键以最后提交为准。`sessionStorage` 在每次播放时从空存储开始。未提供同步 adapter 或读取失败时，`localStorage` 仅保留本次会话数据。写入失败会输出控制台警告，关闭播放器时尚未提交的写入可能丢失。需要等待持久化确认时，请使用异步 `window.game.storageSet/Delete`。两套持久化键分开保存。

两份内存存储共享 1 MiB 累计 UTF-8 写入额度（含键和值），同步的 `localStorage` 最多 128 条、48 KiB（含桥接计量开销）。本地超限抛 `QuotaExceededError`。`indexedDB` 在作品端不可用。

```ts
interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  readonly localStorage?: {
    load(): Promise<[string, string][]>;
    update(
      apply: (entries: [string, string][]) => [string, string][],
      signal: AbortSignal,
    ): Promise<void>;
  };
}
```

作品调用：

```js
await game.storageSet({ key: "save", value: JSON.stringify(state) });
const raw = await game.storageGet({ key: "save" }); // string | null
await game.storageDelete({ key: "save" });
```

不接受 namespace、作品 ID、观看者 ID 或任意 JSON value。key 为非空、最多 128 UTF-8 bytes；value/get 返回最多 16 KiB UTF-8；单会话累计写入最多 1 MiB、最多 128 个不同写 key。读取并发最多 4，set/delete 各最多 1；每次 Host 执行上限 5s。所有操作通过已有 host-plugin composer/schema/capability 与 Host RPC 分发，错误不泄露 adapter 内部异常。

Adapter 的方法在会话创建时绑定，必须由宿主闭包绑定**固定作品与观看者作用域**，不能读取可变的“当前用户”全局变量。持久化总配额、跨标签页并发与权限由 adapter 所属平台管理。终止取消 RPC 并丢弃迟到响应，但无法撤销一个已被 adapter 接受且不支持取消的持久化写入；因此不得在旧请求期间将同一 adapter 切换到另一个作用域。

## 隔离与清理

iframe 保留 `allow-scripts`，仅 pointerLock 授权时追加 `allow-pointer-lock`，永不带 `allow-same-origin`；精确验证 `contentWindow`、`origin === "null"`、256-bit 一次性 token。子端核对实际父窗口、确切可信父 Origin 和 token，仅接受一次单端口 init。包传输与 RPC 使用不同 MessagePort，后者复用原 Host 安全机制；包不会混入普通 RPC 消息预算。用户脚本在认证、收齐/复核所有字节、创建已知可物化资源的 Blob 与 import map 之后才执行；fallback 不进入 Blob 计划，但仍计入全部路径、数量、字节、SHA-256 和传输校验。没有父 Origin Blob 可供不透明子文档直接取用的假设。

Node/browser prepare 与子端接收前共享同一纯 manifest 元数据 validator（版本、根入口、路径、文件数、SHA 字符串格式与大小预算），但子端收齐后仍独立复核文件实际字节的 SHA-256 与格式，不以宿主检查替代子端验证。MIME 已知识别仅接受表的自有键，未知扩展名不能通过 Object 原型链别名进入已知格式；manifest 不增加 MIME/类别/权限字段。包内 fetch 也仅查询文件集自有键，存在的原型键名路径可读，缺失的 `constructor` 等路径必须失败，没有网络回退。

包通道逐块确认并有独立预算/超时；ready 后关闭包通道。终止关闭端口、取消 Host 请求、移除监听器与 iframe，拒绝未完成 connected/ready，丢弃传输缓冲；子文档 pagehide/装载失败终止直接创建的 Worker 并撤销其 Blob URL。准备句柄本身可由调用者保留复用，它持有的已验证字节直到调用者释放该句柄才可回收。

`buildOfflineBrowserPolicy(permissions)` 公布 offline profile：阻断常规连接、远程资源、嵌套文档、远程 Worker、form/popup/top-navigation；策略声明不标注零网络 enforced。`navigate-to` 在部分浏览器不受支持，Host 对 bootstrap 之后的 iframe load 反应式终止，但可能已发出第一次导航请求（204/未替换文档的导航不一定产生 load）。WebRTC/STUN、导航、浏览器漏洞、CPU/内存饥饿和用户授权侧信道不获硬保证；普通页面不能代替 OS 级沙箱。需要严格零网络时，应另用具备网络隔离的执行环境。

## 验证与依赖

`npm run prepare` 只执行构建，无 Git 元数据读取、自动提交/合并/发布；git 依赖安装可生成 dist。平台应固定依赖 Git commit，不使用浮动分支替代不可重复的发布。

```bash
npm test
npm run check:types
npm run check:package
npm run test:browser
# Windows 已安装 Edge 时：
npx playwright test -c test/browser-edge.config.mjs test/browser/package-session.spec.mjs
```

浏览器测试使用真实本地 HTTP 接收端观测网络，不使用 route interception 伪装拒绝；另测不透明 Origin/握手伪造、单次端口、包内资源、fallback GET/HEAD 精确字节及无自动 Blob、引用拒绝、Node/browser/准备 Worker/子端一致性、ESM 环/TLA、32 种权限组合在文档及 Worker 中的允许/拒绝（包括 eval→wasm 与默认禁用）、pointer lock 实际请求及 token、剪贴板双门槛及 RPC 限制/取消/停止、独立 Worker/WASM、存储作用域、取消清理与初始化失败。字体 fixture 为 ABeeZee（OFL，见同目录许可证）。这些测试不构成对所有浏览器所有出口的证明。
