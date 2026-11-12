# 网页游戏裸沙箱使用手册

本文档只描述裸沙箱运行时本体，包括受信任宿主、非受信任游戏 iframe 和宿主桥接。不包含平台账号、发布、审核、房间、云存储或其他业务 API。

新增的**不透明离线包入口**（Node/browser 纯准备、字符串存储、支持矩阵及尽力网络限制）见[离线作品包运行时](./offline-package.zh-CN.md)。以下仍描述既有跨源 HTTP 资源模式，其 Origin 安全校验不变。

## 1. 运行时模型

```text
受信任的宿主页面
  └── 跨源 iframe
        └── 不可信游戏包
```

桥接分为两个阶段：

1. 使用 `window.postMessage` 完成初始握手。
2. 传递一个独立的 `MessageChannel`，后续请求、响应、事件、取消和终止都通过该端口完成。

平台预加载脚本持有内部游戏侧 MessageChannel client；内容只使用已配置的 `window.game` 方法，不自行建立桥接连接。宿主是安全校验方；预加载接口只是便利封装，不是安全边界。运行时协议消息使用严格的 Zod schema 校验；payload 大小估算和浏览器 origin 校验仍然是独立的运行时控制。

## 2. 平台安装与构建

以下命令用于运行时开发和受信任平台接入。内容开发者不安装本包，Vue 项目也不例外。

```bash
npm install
npm run build
```

运行协议测试：

```bash
npm test
```

运行真实 Chromium 集成测试：

```bash
npx playwright install chromium
npm run test:browser
```

运行全部测试：

```bash
npm run test:all
```

## 3. 宿主接入

宿主创建一个具有稳定、精确 origin 的 iframe。不要使用通配符 origin。

```html
<iframe
  id="game-frame"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

创建并启动宿主会话：

```ts
import { z } from "zod";
import {
  SandboxHostSession,
  defineMethod,
  defineSandboxPlugin,
  createHostPlugin,
  composeHostPlugins,
} from "@codemao-pickcat/browser-game-sandbox";

const echo = defineSandboxPlugin({
  id: "com.example.echo",
  version: "1.0.0",
  gameApi: { echo: "echo" }, // window.game.echo -> com.example.echo.echo
  methods: {
    echo: defineMethod({
      defaultTimeoutMs: 5000, // 可省略或传 undefined，自动使用 5000ms。
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});
const extensions = composeHostPlugins([
  createHostPlugin(echo, {
    echo(input, { signal }) {
      if (signal.aborted) throw new Error("请求已取消");
      return input;
    },
  }),
], { grantedCapabilities: ["com.example.echo"] });

const iframe = document.querySelector("#game-frame");
if (!(iframe instanceof HTMLIFrameElement)) {
  throw new Error("未找到游戏 iframe");
}

const session = new SandboxHostSession({
  window,
  iframe,
  gameOrigin: "https://game.example.test",
  capabilities: extensions.capabilities,
  methods: extensions.methods,
  onRequestClose(reason) {
    console.log("游戏请求关闭：", reason);
  },
});

session.start();
iframe.src = "https://game.example.test/index.html";
await session.connected;
```

先调用 `session.start()` 再设置 iframe 的 `src`，可以保证平台预加载脚本发起握手时宿主已开始监听。游戏资源服务器必须先完成第 4 节的预加载接入，再向内容提供游戏页面。

`gameOrigin` 必须是精确的 `http` 或 `https` origin，包含协议和必要的端口，并且必须与宿主页面跨源。不能使用路径、通配符、逗号、引号或 `*`。

### 游戏包入口与资源白名单

游戏资源服务器应把 `index.html` 作为唯一入口，并在每个请求上应用资源白名单。`createSandboxGamePackagePolicy` 只接受明确列出的包内路径，并拒绝路径穿越、编码路径、查询参数、片段、跨源 URL 和未声明资源：

```ts
import { createSandboxGamePackagePolicy } from "@codemao-pickcat/browser-game-sandbox";

const packagePolicy = createSandboxGamePackagePolicy({
  entry: "index.html",
  resources: [
    "index.html",
    "game.js",
    "styles/game.css",
    "assets/logo.png",
    "__sandbox/game.preload.js", // 平台保留资源，绝不是上传文件。
  ],
});

packagePolicy.assertEntryPath("/index.html");

function serveGameRequest(pathname: string): void {
  const path = packagePolicy.assertAllowedResourcePath(pathname);
  if (path === "/__sandbox/game.preload.js") {
    // 返回可信发布包中的 dist/game.preload.js，而非上传文件。
    return;
  }
  // 只从已校验的 path 读取游戏包文件。
  console.log("serve", path);
}
```

资源服务器仍然必须给每一个 HTML 文档发送同一套 CSP。宿主会监听 iframe 的顶层 `load`；初始文档之后再次触发 load 会终止会话，防止游戏在运行期间切换到未受控文档。资源白名单和导航监听需要同时保留，因为浏览器无法让跨源宿主直接读取 iframe 的当前 URL。

### 宿主配置项

| 配置项 | 默认值 | 含义 |
| --- | ---: | --- |
| `gameOrigin` | 必填 | 允许发起握手的精确 origin，必须与宿主 origin 不同 |
| `hostOrigin` | 自动推断 | 可显式指定宿主 origin；同源游戏配置会被拒绝 |
| `capabilities` | `[]` | 授予已注册宿主方法的能力名称 |
| `browserCapabilities` | `[]` | 声明浏览器能力 profile，必须与实际 iframe/CSP 策略一致 |
| `maxPayloadBytes` | `65536` | 估算后的结构化克隆数据最大大小 |
| `maxRequestsPerSecond` | `30` | 单个会话的请求速率限制 |
| `maxConcurrentRequests` | `64` | 最大未完成宿主处理器数量 |
| `maxRequestIds` | `10000` | 单个会话记忆的最大请求 ID 数量 |
| `requestIdTtlMs` | `60000` | 请求 ID 保留时间 |
| `handshakeTimeoutMs` | `5000` | 握手允许的最长时间 |

## 4. 游戏侧接入

### 平台自动预加载

平台必须按插件配置在游戏脚本执行前建立 `window.game`。内容开发者不安装沙箱包、不添加预加载 script，也不手动握手，只需：

```js
const result = await window.game.echo({ value: "hello" });
```

受信任插件通过 `gameApi` 显式声明扁平方法名到插件方法的映射，如第 3 节所示；未声明 `gameApi` 的插件不会自动暴露全局方法。`composeHostPlugins()` 返回冻结的「公开别名 → 方法绑定」映射，每个绑定也是冻结对象，含完整宿主方法名 `method` 和已补齐的 `defaultTimeoutMs`（插件省略或传 `undefined` 时为 5000ms）。本例的 `extensions.gameApi` 为 `{ echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 } }`；插件声明仍保持 `gameApi: { echo: "echo" }`。可信游戏资源渲染器必须使用与宿主同一部署版本的插件配置：

```ts
import { renderSandboxGamePreloadScript } from "@codemao-pickcat/browser-game-sandbox";

// extensions 来自第 3 节共享的受信任宿主契约组合结果。
const preloadTag = renderSandboxGamePreloadScript({
  src: "/__sandbox/game.preload.js",
  expectedHostOrigin: "https://host.example.test",
  methods: extensions.gameApi,
});
```

**平台必须完成以下接入，本库不包含 HTML 资源服务器，也不会从父页面跨源修改游戏 DOM：**

1. 把发布包的 `dist/game.preload.js` 精确挂载到游戏 origin 的保留路径 `/__sandbox/game.preload.js`；上传包不得覆盖此路径，不能开放整个目录。
2. 在可信 HTML 渲染器的 `<head>` 中、**所有游戏可控标记之前**输出 `preloadTag`，再输出游戏内容。标签是同步经典脚本，不可添加 `async`、`defer` 或 `type="module"`。不要用不可靠的字符串替换改写任意上传 HTML；平台须用自己的受控模板或 HTML 解析器完成整合。
3. 资源白名单同时列出 `index.html`、游戏资源和 `__sandbox/game.preload.js`，保留每个 HTML 响应的 CSP、Permissions-Policy 和导航限制。预加载包自包含，无需 import map、配置 fetch 或 `unsafe-inline`；`script-src 'self'`、`connect-src 'none'` 可保持不变。
4. 在导航到游戏前启动宿主会话。精确宿主 origin、方法映射来自可信启动配置，不来自上传包、referrer 或未经校验的请求参数；预加载配置不得含凭据，缓存不得混用不同宿主/插件版本的配置。

`window.game` 会同步建立为不可替换的冻结对象，且只包含显式映射的方法；名称冲突、已有全局、未知目标和 `then`/原型相关保留名会报错。方法始终返回 Promise，可传第二个参数 `{ signal, timeoutMs }`。插件方法的 `defaultTimeoutMs` 可省略或传 `undefined`，组合器会补成 5000ms；预加载方法绑定始终携带已补齐的有限正数。单次 `options.timeoutMs` 可覆盖该默认值，调用超时包含等待握手的时间；握手前最多等待 64 个调用、payload 默认上限 65536 字节。标签配置可用独立的 `handshakeTimeoutMs`、`maxPayloadBytes`、`maxQueuedCalls` 调整；`SandboxGamePreloadConfig` 不再支持统一 `defaultTimeoutMs` 字段。单次取消不取消共享握手，握手失败不自动重连。

映射只控制便利接口，**不是权限 allowlist**；游戏仍可自行构造桥接请求，最终授权、输入输出 Zod、限流和错误脱敏始终由宿主执行。冻结全局不构成游戏脚本之间的安全隔离，也不暴露宿主函数或窗口。

平台预加载是唯一受支持的内容接入方式。内部 client 向精确的 `targetOrigin` 发送就绪消息，校验父窗口的 source 和 origin，只接受一个传入端口，再通过端口完成握手。内容不提供宿主 origin，也不另建连接。`window.game` 只暴露已配置的插件方法，不提供通用 `call`、ready、事件订阅或连接管理接口。

### 4.1 无 SDK 的纯 HTML 游戏

上传的 HTML 只引用自身游戏脚本；平台单独在所有游戏可控标记之前插入预加载标签：

```html
<script src="/game.js" defer></script>
```

`game.js`：

```js
async function startGame() {
  const result = await window.game.echo({ value: "hello" });
  console.log(result.value);
}

startGame().catch((error) => {
  console.error("宿主调用失败", error.code, error.message);
});
```

不需要沙箱 import、SDK script、import map 或内容侧 Zod 依赖。游戏可立即发起调用，返回的 Promise 已包含等待平台握手的过程。

### 4.2 无 SDK 的 Vue 3 原生组件

Vue 仍是游戏自身的框架依赖。正常启动应用，不安装沙箱 Vue 插件，也不添加桥接配置模块：

```js
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

组件直接调用同一个原生全局对象：

```vue
<script setup>
import { ref } from "vue";

const message = ref("");

async function callHost() {
  try {
    const result = await window.game.echo({ value: "hello" });
    message.value = result.value;
  } catch (error) {
    message.value = `${error.code}: ${error.message}`;
  }
}
</script>

<template>
  <button @click="callHost">调用宿主</button>
  <p>{{ message }}</p>
</template>
```

无需注入 SDK、ready ref 或等待额外连接。TypeScript 内容可使用平台提供的本地 `Window.game` 声明；不应为此安装宿主运行时包。

### 4.3 破坏性迁移

迁移方法级超时：`defineMethod` / `SandboxMethodContract` 可添加顶层 `defaultTimeoutMs` 自定义超时；省略或传 `undefined` 自动使用 5000ms，显式值必须是有限正数。插件声明仍保持 `gameApi: { echo: "echo" }`；组合后的 `gameApi` 值由字符串改为冻结的 `{ method: "com.example.echo.echo", defaultTimeoutMs: 5000 }` 对象。`renderSandboxGamePreloadScript({ methods: extensions.gameApi, ... })` 调用不变；手写字符串绑定须改为对象并为每项提供必填的 `defaultTimeoutMs`，删除统一的 `SandboxGamePreloadConfig.defaultTimeoutMs`。游戏调用仍保持 `window.game.xxx(payload, { signal, timeoutMs })`。

内容侧 SDK（包括 Vue 支持）彻底移除，不保留兼容模式：

- 已移除包路径：`@codemao-pickcat/browser-game-sandbox/game`、`@codemao-pickcat/browser-game-sandbox/vue` 和 `game.global.js`（原 `dist/game.global.js` / `window.CodemaoSandboxGame`）。
- 根入口不再导出：`acceptSandboxBridge`、`SandboxBridgeClient`、`createSandboxSdk`、`connectSandboxHtmlSdk`、`installSandboxGameApi`。内容不得深层导入它们的内部替代实现。
- 删除 SDK import、script、Vue 插件安装、注入的 SDK/ready ref 和手动连接代码，改为直接调用已配置的 `window.game` 方法；取消和错误处理同样使用原生接口。
- 仅根宿主 API 与 `game.preload.js` 平台产物继续公开。平台须先完成上述预加载/资源服务器接入再迁移内容；没有内容侧回退模式，也没有自动替换旧订阅的事件 API。

内部 MessageChannel client、宿主安全校验和协议 v1 均保留。删除公开 SDK 不等于删除桥接运行时。

## 5. 调用宿主方法

```js
const echoed = await window.game.echo({ value: "hello" });
```

这里 `echo` 是 `com.example.echo.echo` 的已配置公开别名；内容没有枚举或调用任意宿主方法的通用 API。内部带命名空间的桥接方法名必须符合：

```text
^[a-z][A-Za-z0-9._-]*$
```

方法只有在以下条件全部满足时才会执行：

1. 宿主注册了该方法。
2. 方法声明的 capability 存在于宿主的 `capabilities` 中。
3. payload 通过方法校验器。
4. 请求通过大小、速率、并发和请求 ID 检查。

游戏 payload 内的字段不能自行授予 capability。

### 5.1 契约与校验

共享契约属于受信任宿主注册与预加载配置，不是内容侧 SDK。插件方法的 `defineMethod` 配置和 `SandboxMethodContract` 可包含顶层 `defaultTimeoutMs`；省略或传 `undefined` 时自动使用 5000ms，显式值必须是有限正数。原始方法契约不经 `defineMethod` 也适用，包括没有 `gameApi` 别名的方法。`createHostPlugin` 和 `composeHostPlugins` 保留宿主输入/输出 Zod 校验和处理器类型推导。预加载脚本检查传输限制，不向内容分发插件 schema。内容本地类型声明必须与已部署的别名和 payload 一致，但不能授予权限或替代宿主校验。

## 6. 取消和超时

```js
const controller = new AbortController();

const request = window.game.echo(
  { value: "hello" },
  { signal: controller.signal, timeoutMs: 2_000 },
);

controller.abort();
try {
  await request;
} catch (error) {
  if (error.code !== "CANCELLED") throw error;
}
```

游戏侧超时优先级为单次 `options.timeoutMs` > 方法默认 `defaultTimeoutMs`（插件省略时为 5000ms）；覆盖值可比默认值更短或更长。选定的超时覆盖等待握手和执行的总时长。`handshakeTimeoutMs` 单独限制共享握手，不受单次调用超时覆盖。

宿主可选的 `limits.timeoutMs` 是独立的宿主执行硬上限，不是游戏侧默认值；单次调用即使设置更长超时，也不能延长或禁用该硬上限。取消排队调用会释放队列位置，不会取消共享握手。请求已发出后，取消会继续传给宿主。

宿主处理器会收到 `AbortSignal`。宿主方法应在 signal 被取消后停止工作。取消是协作式的，JavaScript 无法强制终止任意 Promise。

## 7. 事件和终止

事件保留在平台内部运行时协议中，不是内容公共 API。`window.game` 没有事件订阅方法。宿主仍可发送协议事件，但内容没有受支持的监听接口；依赖旧订阅的产品须显式迁移，不应另建手动连接。

宿主侧协议事件：

```ts
session.emit("example.event", { value: "hello" });
```

终止沙箱：

```ts
session.terminate("宿主终止了沙箱");
```

终止会发送 `sandbox.terminated`，关闭端口，拒绝所有 pending 请求，移除宿主的 message listener，并在传入的 iframe 支持 `remove()` 时尽力移除它。它不会擦除 origin 持久化存储或注销 Service Worker；这些需要单独的清理策略。游戏代码不能阻止桥接清理。

## 8. 内置方法

核心宿主提供以下方法：

| 方法 | 结果 |
| --- | --- |
| `sandbox.ping` | `{ ok: true }` |
| `sandbox.getInfo` | `{ protocolVersion }` |
| `sandbox.getCapabilities` | `{ capabilities }` |
| `sandbox.getBrowserCapabilities` | `{ capabilities }` |
| `sandbox.requestClose` | 调用宿主的 `onRequestClose` 回调 |

这些是平台内部运行时生命周期方法，不是内容公共 API，也不是平台业务 API。它们不会自动暴露到 `window.game`；内容只使用显式映射的插件方法。

## 9. 安全要求

### origin 和 source 校验

宿主必须同时校验：

```ts
event.origin === gameOrigin
event.source === iframe.contentWindow
```

平台预加载脚本内部的私有 client 必须同时校验（内容不自行实现此握手）：

```ts
event.origin === expectedHostOrigin
event.source === window.parent
```

### 推荐 iframe 策略

从以下配置开始：

```html
sandbox="allow-scripts allow-same-origin"
```

除非有单独测试过的需求，不要增加以下权限：

```text
allow-popups
allow-top-navigation
allow-top-navigation-by-user-activation
allow-forms
allow-downloads
allow-modals
```

### 推荐游戏响应头

响应头必须由沙箱宿主生成，不能直接接受上传游戏内容中的响应头。一个基础策略如下：

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  connect-src 'none';
  worker-src blob:;
  object-src 'none';
  base-uri 'none';
  form-action 'none';
  frame-ancestors https://host.example.test;
```

某个游戏引擎可能需要放宽策略，但每次放宽都必须视为新的能力决策并单独测试。

### 浏览器能力声明

宿主可以把浏览器权限与插件 capability 分开声明：

```ts
new SandboxHostSession({
  // ...
  browserCapabilities: [
    "browser.worker.dedicated",
    "browser.storage.local",
  ],
});
```

内部运行时协议可通过 `sandbox.getBrowserCapabilities` 查询这些声明；它不是公开的 `window.game` 方法。声明不会覆盖浏览器安全策略；宿主必须通过 iframe 配置和响应头实际执行相同 profile。`buildBrowserPolicy` 会生成 sandbox token、iframe `allow`、CSP、Permissions-Policy、执行状态和警告。

当前浏览器权限点包括：

```text
browser.storage.local
browser.storage.indexeddb
browser.worker.dedicated
browser.worker.shared
browser.worker.service
browser.wasm
browser.webgl
browser.webaudio
browser.fullscreen
browser.pointer-lock
browser.clipboard.read
browser.clipboard.write
browser.camera
browser.microphone
browser.geolocation
browser.notifications
browser.popup
browser.top-navigation
browser.form-submit
browser.download
browser.modals
browser.presentation
network.connect
network.websocket
network.webrtc
```

已测试的基线使用 `worker-src blob:` 允许 Blob Dedicated Worker，并拒绝 Service Worker。普通浏览器不能用 CSP 区分 Dedicated Worker 和 Shared Worker，因此两者会报告 `not-distinguishable`，而不是伪装成严格隔离。Storage、WebGL、WebAudio、WebRTC 也属于不能由普通网页完全强制的能力。

文件选择器的 `accept="image/*,video/*"` 只是浏览器界面提示，不能限制用户最终选择的文件类型。当前策略可以阻止浏览器下载，但不能把原生文件选择器变成图片/视频专用选择器；需要通过受信任宿主的文件选择 API 实现这部分产品规则。

### 重要限制

- 这是浏览器级边界，不是操作系统或容器级边界。
- 桥接不提供通用网络代理。
- `localStorage` 和 `IndexedDB` 是浏览器能力，不是可以按每次调用撤销的桥接 capability；如果需要存储隔离，应为每个不可信游戏使用独立 game origin。
- 只要沙箱内的代码拿到了 `MessagePort`，它就拥有与游戏相同的桥接权限；当前没有脚本级身份隔离。
- Dedicated/Shared Worker 的区分必须在目标浏览器中实际验证；普通 CSP 不能把它们严格分开。
- 宿主方法属于受信任宿主代码，其内部授权逻辑不属于本包负责范围。

## 10. 校验与错误处理

桥接使用严格的 Zod schema 校验协议 envelope。未知字段、缺少必填字段、不支持的协议版本以及自相矛盾的响应字段，会在调用宿主方法前被拒绝。Zod 只负责消息结构校验，不能替代 origin/source 校验、capability 校验、payload 限制、限流或宿主侧授权。

## 11. 错误处理

原生 `window.game` 调用失败时会拒绝 Promise，错误包含 `code` 和 `message`。运行时内部使用 `SandboxBridgeError`，内容不导入其类，也不依赖 `instanceof` 判断：

```js
try {
  await window.game.echo({ value: "hello" }, { timeoutMs: 2_000 });
} catch (error) {
  if (error.code === "CANCELLED") {
    // 调用方已取消，无需展示失败提示。
  } else if (error.code === "TIMEOUT") {
    console.warn("宿主调用超时");
  } else {
    console.error("宿主调用失败", error.code, error.message);
  }
}
```

| Code | 含义 |
| --- | --- |
| `BRIDGE_CLOSED` | 端口或沙箱已经终止 |
| `CANCELLED` | 调用方取消了请求 |
| `TIMEOUT` | 调用或握手超时 |
| `INVALID_MESSAGE` | 方法、ID 或协议输入无效 |
| `INVALID_PAYLOAD` | payload 未通过校验或大小限制 |
| `NOT_ALLOWED` | 所需 capability 未授予 |
| `UNKNOWN_METHOD` | 宿主未注册该方法 |
| `RATE_LIMITED` | 超过速率、并发或请求 ID 配额 |
| `DUPLICATE_REQUEST` | 请求 ID 已经使用过 |
| `INTERNAL_ERROR` | 宿主处理器失败，内部细节不会暴露 |

## 12. 协议不变量

- 当前协议版本为 `1`。
- 请求 ID 在配置的 TTL 内保留；重放保护是有界的，不是永久保留。
- 一个宿主会话最多建立一个 `MessageChannel`。
- 无效消息会被忽略或拒绝，不能调用宿主处理器。
- 出站和入站 payload 都受大小限制。
- 宿主错误在进入沙箱前会被脱敏。
- `MessageChannel` 是能力转移；应将端口限制在沙箱运行上下文内部。
