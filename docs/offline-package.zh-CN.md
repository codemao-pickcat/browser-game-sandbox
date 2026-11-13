# 离线作品包运行时（0.3.2）

本入口不需要逐作品 HTTP 资源服务。宿主提供 manifest 与文件字节，SDK 在不透明 iframe 中创建 Blob 资源并执行作品。作品仍直接调用 `window.game`，不安装 SDK。

**这是原生浏览器的尽力网络限制，不是零联网承诺。** WebRTC/STUN、自身导航等出口不能获得绝对阻断保证；不提供任意 URL 宿主代理。CSP 及 iframe sandbox 是浏览器防御，包内 fetch 兼容层不是安全边界。

## 固定接口

```ts
import {
  SANDBOX_RUNTIME_VERSION, // "0.3.2"，与 package.json 一致
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
const prepared = await prepareSandboxPackage(input satisfies SandboxPackageInput);
const session = createSandboxPackageSession({
  container,
  package: prepared,
  storage, // 可选，宿主闭包绑定固定作用域
  onTerminate(reason) { /* 释放业务状态；不要将未过滤的 reason 插入 HTML */ },
});
await session.connected; // 可信 bootstrap 端口及原有 Host RPC 握手成功
await session.ready;     // 接收、重新校验、资源装载及初始脚本执行完成（含 module TLA）
// session.iframe 可用于布局；不要修改其 sandbox/src/srcdoc/allow。
session.terminate("player closed");
```

`prepareSandboxPackage` 同时支持 Node.js 24+ 与浏览器；使用 parse5、css-tree、Acorn 解析，**不引用浏览器 DOM、不执行作品代码、不访问网络**。它校验根入口、完整文件集、SHA-256、字节长度、路径与支持格式，并复制输入字节，后续修改输入不改变准备结果。返回的 `PreparedSandboxPackage` 是当前 JS realm 中的不可变句柄，不可 JSON 序列化/跨进程复用；服务端准备通过后，player 下载同一包并重新准备。

宿主需运行于 http(s) Origin（生产应使用 HTTPS）。普通 bundler 可使用包根入口；无 bundler 的可信 player 可同源托管 `@codemao-pickcat/browser-game-sandbox/package.runtime.js`，它是无外部依赖的 ESM bundle，包含可信 bootstrap 字符串。禁止从作品包中替换此运行时。`game.preload.js` 是旧跨源资源服务入口，离线包不依赖它。

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
- HTML/CSS/JS/SVG 必须为 UTF-8。二进制文件保证字节完整性及扩展名支持，不承诺解码器能播放任意损坏或浏览器不支持的媒体编码。

允许的扩展名：`html css js mjs json txt csv xml png jpg jpeg gif webp avif ico svg woff woff2 ttf otf mp3 ogg wav m4a mp4 webm bin`。只有根 `index.html` 可作为执行入口。其他 `.html`（如 `assets/template.html`）允许作为被动模板数据，仍校验 SHA-256、大小与 UTF-8；仅保留原始字节供包内相对 fetch 读取，不解析/改写模板、不生成 HTML Blob、不插入 DOM，也不提供次级文档或导航入口。`.wasm` 文件、压缩包及未知扩展名拒绝。内嵌在 JavaScript 的 WebAssembly 字节可通过 compile/instantiate 执行，主线程和 Worker 均支持；CSP 只增加 `wasm-unsafe-eval`，不放开 JavaScript eval/Function。ZIP 解包由平台负责，本 API 不解析 ZIP。

## 支持矩阵

| 模式 | 行为 |
| --- | --- |
| 根 HTML、普通布局与表单控件 | 仅根 `index.html` 编译为执行文档；支持布局与控件，不能提交表单 |
| 次级 HTML 模板（含嵌套路径） | 支持 `fetch("assets/template.html").text()`，GET/HEAD 返回原始字节及 `text/html` 类型；模板内容不作执行资源解析，其 script/meta/URL 只是数据，SDK 不激活它们 |
| 静态 `script src`、inline script | 支持；在完整 DOM 装载后按文档顺序执行；`async/defer` 归一为顺序执行 |
| `type="module"`（外部/内联） | 支持，含静态 import/export、循环引用、top-level await |
| `import("./literal.js")` | 支持；非 literal 动态 import、bare specifier、import attributes/JSON modules、module query/hash 变体明确拒绝 |
| `new URL("./asset", import.meta.url)` | 支持非 HTML literal 资源，重写为子文档创建的 Blob URL；动态参数与 HTML Blob 资源明确拒绝，HTML 模板请使用包内相对 fetch |
| stylesheet link、style、style 属性 | 支持；解析并重写 CSS `url()`、`@import`、`image-set()` URL，通过 CSS 字符串序列化保留引用和转义，包括 `#svgView(viewBox(...))` 等带括号 fragment；CSS Blob 依赖环拒绝 |
| 图片、字体、音频、视频的静态资源引用 | 支持包内文件；HTML `srcset/imagesrcset` 暂不支持，明确拒绝 |
| SVG | 仅自包含、无脚本/动画/外部 URL 的 SVG；不支持 style、foreignObject、image/use 等嵌入形式 |
| 静态引用带 query/fragment | HTML stylesheet/image/classic script、CSS url/import、literal `new URL` 只按包路径查找；query 不附加到 Blob，fragment 保留；不产生联网或独立 cache 版本，不适用于 ESM query/hash |
| `fetch("data.json")`、运行时计算包内相对路径 | 本地兼容层提供 GET/HEAD，返回原始包字节；query/hash 不改变读取的文件或字节，带 query 的 HTML 模板也一样；相对路径始终以根 index.html 为基准，不以调用脚本为基准 |
| `fetch(new URL("./data.json", import.meta.url))` | 支持重写后的本地 Blob 对应原始字节；不存在的文件/外部 URL/非 GET-HEAD 明确 TypeError，无网络回退 |
| `window.game.storageGet/Set/Delete` | 提供 adapter 时支持，严格对象 schema；不提供 adapter 时不暴露存储方法 |
| fragment anchor | 支持；其他静态链接导航拒绝 |
| 外部 URL、CDN、data URL 依赖 | 静态可识别的资源引用拒绝，不回退联网；请先打包成本地文件 |
| 动态 DOM `src/href/style`、运行时拼接 CSS、任意 URL 构造模式 | 不做透明改写；作者需改为静态引用或 literal `new URL(..., import.meta.url)`；相对 URL 不能自动访问包资源，浏览器策略会产生资源错误 |
| 独立 Worker | 支持子文档创建的 Blob Worker、literal 包内 `.js/.mjs` 路径及 `new Worker(new URL("./worker.js", import.meta.url), options)`；保留消息、transferable、classic/module 选项。模块 Worker 在 classic bootstrap 中通过 import 执行，初始化完成前排队消息（重放的 MessageEvent 为合成事件）；包内静态/动态 literal import 物化为 Blob 图，不支持循环依赖。最多 32 个直接存活 Worker，terminate 释放名额，会话销毁时终止；嵌套 Worker 和 CPU/内存不承诺硬配额。Worker 内不提供 `window.game` 或包内 fetch 兼容层，importScripts 不支持；动态 Blob 源需自包含，模块 import map 只存在于主文档。CSP 仅允许 Blob Worker，继续继承禁用外部连接的策略 |
| SharedWorker/ServiceWorker、XHR、eval/Function/importScripts | 不支持；可识别的直接构造/调用在 prepare 拒绝，另由 CSP/opaque Origin 尽力防御，不以删除全局函数宣称安全 |
| HTML 模板作为 script/module/stylesheet/iframe 或导航目标 | 明确拒绝；被动 HTML 数据不是可执行 JS/CSS，也不是额外入口 |
| 执行文档中的 iframe/object/embed/base/meta http-equiv、preload/prefetch、SRI/nomodule | 明确拒绝，不提供多文档或运行时引导兼容退路 |

JS 文件采用现代 ES module 语法校验；即使以 classic script 引用，也不支持依赖 `with` 等 sloppy-only 语法。内联事件属性也做语法校验，不支持依赖顶层 `return` 的 handler。`document.write`、脚本流式解析时机、`document.currentScript`（module）、`location` 的原始 HTTP 路径、直接读取 `import.meta.url` 的原始文件路径、XHR/流式请求及动态加载任意文件都不保证兼容。初始文档已完成 bootstrap；SDK 在初始脚本完成后回放一次 `DOMContentLoaded`/`load` 供常见作品初始化。后续异步业务任务、媒体播放与应用自定义状态不属于 `ready` 的保证范围。

不支持任意 ZIP 透明兼容。`SandboxPackageError.code` 区分 `INVALID_MANIFEST/INVALID_PATH/INTEGRITY/PACKAGE_TOO_LARGE/INVALID_ENCODING/UNSUPPORTED_FORMAT`、缺失资源、HTML/CSS/JS/模块不兼容、资源环等错误；错误消息标明对应文件或模式。动态不支持的操作通过 TypeError、模块执行拒绝、资源 error 或 CSP 报告显式失败。准备成功不等于所有用户代码一定能成功运行；运行初始化失败会拒绝 `ready` 并销毁会话，不会 fake-ready。

## 存储

```ts
interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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

iframe 只启用 `allow-scripts`，不带 `allow-same-origin`；精确验证 `contentWindow`、`origin === "null"`、256-bit 一次性 token。子端核对实际父窗口、确切可信父 Origin 和 token，仅接受一次单端口 init。包传输与 RPC 使用不同 MessagePort，后者复用原 Host 安全机制；包不会混入普通 RPC 消息预算。用户脚本在认证、收齐/复核所有字节、创建全部 Blob 与 import map 之后才执行。没有父 Origin Blob 可供不透明子文档直接取用的假设。

Node/browser prepare 与子端接收前共享同一纯 manifest 元数据 validator（版本、根入口、路径、文件数、SHA 字符串格式与大小预算），但子端收齐后仍独立复核文件实际字节的 SHA-256 与格式，不以宿主检查替代子端验证。MIME 查表仅接受 allowlist 自有键，未知扩展名不能通过 Object 原型链别名进入。

包通道逐块确认并有独立预算/超时；ready 后关闭包通道。终止关闭端口、取消 Host 请求、移除监听器与 iframe，拒绝未完成 connected/ready，丢弃传输缓冲；子文档 pagehide/装载失败终止直接创建的 Worker 并撤销其 Blob URL。准备句柄本身可由调用者保留复用，它持有的已验证字节直到调用者释放该句柄才可回收。

`buildOfflineBrowserPolicy()` 公布 offline profile：阻断常规连接、远程资源、嵌套文档、远程 Worker、form/popup/top-navigation；策略声明不标注零网络 enforced。`navigate-to` 在部分浏览器不受支持，Host 对 bootstrap 之后的 iframe load 反应式终止，但可能已发出第一次导航请求（204/未替换文档的导航不一定产生 load）。WebRTC/STUN、导航、浏览器漏洞、CPU/内存饥饿和用户授权侧信道不获硬保证；普通页面不能代替 OS 级沙箱。需要严格零网络时，应另用具备网络隔离的执行环境。

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

浏览器测试使用真实本地 HTTP 接收端观测网络，不使用 route interception 伪装拒绝；另测不透明 Origin/握手伪造、单次端口、包内资源、ESM 环/TLA、存储作用域、取消清理与初始化失败。字体 fixture 为 ABeeZee（OFL，见同目录许可证）。这些测试不构成对所有浏览器所有出口的证明。
