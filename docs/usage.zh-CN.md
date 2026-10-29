# 网页游戏裸沙箱使用手册

本文档只描述裸沙箱运行时本体，包括受信任宿主、非受信任游戏 iframe 和宿主桥接。不包含平台账号、发布、审核、房间、云存储或其他业务 API。

## 1. 运行时模型

```text
受信任的宿主页面
  └── 跨源 iframe
        └── 不可信游戏包
```

桥接分为两个阶段：

1. 使用 `window.postMessage` 完成初始握手。
2. 传递一个独立的 `MessageChannel`，后续请求、响应、事件、取消和终止都通过该端口完成。

宿主是安全校验方。游戏侧 client 只是类型封装，不能被当作安全边界。

## 2. 安装与构建

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
  src="https://game.example.test/index.html"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

创建并启动宿主会话：

```ts
import { SandboxHostSession } from "@codemao/browser-game-sandbox";

const iframe = document.querySelector("#game-frame");
if (!(iframe instanceof HTMLIFrameElement)) {
  throw new Error("未找到游戏 iframe");
}

const session = new SandboxHostSession({
  window,
  iframe,
  gameOrigin: "https://game.example.test",
  capabilities: ["example.echo"],
  methods: {
    "example.echo": {
      capability: "example.echo",
      validate(payload) {
        if (!payload || typeof payload !== "object") {
          throw new TypeError("payload 必须是对象");
        }
      },
      handler(payload, { signal }) {
        if (signal.aborted) throw new Error("请求已取消");
        return payload;
      },
    },
  },
  onRequestClose(reason) {
    console.log("游戏请求关闭：", reason);
  },
});

session.start();
await session.connected;
```

`gameOrigin` 必须是精确的 `http` 或 `https` origin，包含协议和必要的端口。不能使用路径、通配符或 `*`。

### 宿主配置项

| 配置项 | 默认值 | 含义 |
| --- | ---: | --- |
| `gameOrigin` | 必填 | 允许发起握手的精确 origin |
| `capabilities` | `[]` | 授予已注册宿主方法的能力名称 |
| `maxPayloadBytes` | `65536` | 估算后的结构化克隆数据最大大小 |
| `maxRequestsPerSecond` | `30` | 单个会话的请求速率限制 |
| `maxConcurrentRequests` | `64` | 最大未完成宿主处理器数量 |
| `maxRequestIds` | `10000` | 单个会话记忆的最大请求 ID 数量 |
| `handshakeTimeoutMs` | `5000` | 握手允许的最长时间 |

## 4. 游戏侧接入

游戏必须知道受信任宿主的精确 origin。它应来自受信任的运行时配置，不要直接使用用户输入。

```ts
import { acceptSandboxBridge } from "@codemao/browser-game-sandbox";

const bridge = await acceptSandboxBridge({
  window,
  expectedHostOrigin: "https://host.example.test",
});

const info = await bridge.call<{ protocolVersion: number }>(
  "sandbox.getInfo",
  {},
);

const capabilities = await bridge.call<{ capabilities: string[] }>(
  "sandbox.getCapabilities",
  {},
);

console.log(info.protocolVersion, capabilities.capabilities);
```

`acceptSandboxBridge` 会向精确的 `targetOrigin` 发送就绪消息，校验父窗口的 source 和 origin，只接受一个传入的端口，然后通过端口发送握手完成消息。

## 5. 调用宿主方法

```ts
const echoed = await bridge.call<{ value: string }>(
  "example.echo",
  { value: "hello" },
);
```

方法名必须符合：

```text
^[a-z][A-Za-z0-9._-]*$
```

方法只有在以下条件全部满足时才会执行：

1. 宿主注册了该方法。
2. 方法声明的 capability 存在于宿主的 `capabilities` 中。
3. payload 通过方法校验器。
4. 请求通过大小、速率、并发和请求 ID 检查。

游戏 payload 内的字段不能自行授予 capability。

## 6. 取消和超时

```ts
const controller = new AbortController();

const request = bridge.call(
  "example.echo",
  { value: "hello" },
  { signal: controller.signal, timeoutMs: 2_000 },
);

controller.abort();
await request; // 以 SandboxBridgeError(code === "CANCELLED") 拒绝
```

宿主处理器会收到 `AbortSignal`。宿主方法应在 signal 被取消后停止工作。取消是协作式的，JavaScript 无法强制终止任意 Promise。

## 7. 事件和终止

游戏侧监听事件：

```ts
const unsubscribe = bridge.on("example.event", (payload) => {
  console.log("收到事件", payload);
});

unsubscribe();
```

宿主侧发送事件：

```ts
session.emit("example.event", { value: "hello" });
```

终止沙箱：

```ts
session.terminate("宿主终止了沙箱");
```

终止会发送 `sandbox.terminated`，关闭端口，拒绝所有 pending 请求，并移除宿主的 message listener。游戏侧事件处理器不能阻止桥接清理。

## 8. 内置方法

核心宿主提供以下方法：

| 方法 | 结果 |
| --- | --- |
| `sandbox.ping` | `{ ok: true }` |
| `sandbox.getInfo` | `{ protocolVersion }` |
| `sandbox.getCapabilities` | `{ capabilities }` |
| `sandbox.requestClose` | 调用宿主的 `onRequestClose` 回调 |

这些是运行时生命周期方法，不是平台业务 API。

## 9. 安全要求

### origin 和 source 校验

宿主必须同时校验：

```ts
event.origin === gameOrigin
event.source === iframe.contentWindow
```

游戏 client 必须同时校验：

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

### 重要限制

- 这是浏览器级边界，不是操作系统或容器级边界。
- 桥接不提供通用网络代理。
- `localStorage` 和 `IndexedDB` 是浏览器能力，不是可以按每次调用撤销的桥接 capability。
- 只要沙箱内的代码拿到了 `MessagePort`，它就拥有与游戏相同的桥接权限；当前没有脚本级身份隔离。
- Dedicated Worker 与禁止 Service Worker 的组合必须在目标浏览器中实际验证。
- 宿主方法属于受信任宿主代码，其内部授权逻辑不属于本包负责范围。

## 10. 错误处理

错误会以 `SandboxBridgeError` 形式返回：

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

## 11. 协议不变量

- 当前协议版本为 `1`。
- 请求 ID 在一个宿主会话生命周期内只能使用一次。
- 一个宿主会话最多建立一个 `MessageChannel`。
- 无效消息会被忽略或拒绝，不能调用宿主处理器。
- 出站和入站 payload 都受大小限制。
- 宿主错误在进入沙箱前会被脱敏。
- `MessageChannel` 是能力转移；应将端口限制在沙箱运行上下文内部。
