# 裸沙箱宿主插件规范

状态：设计稿 v1

## 1. 范围

插件是运行在**受信任沙箱宿主侧**的扩展，提供受控方法和内部协议事件。内容通过平台预加载的 `window.game` 调用显式配置的方法，不安装沙箱包或框架适配器；预加载接口不提供公开事件订阅。

插件不是：

- 游戏代码中的动态模块
- 游戏可以自行安装的代码
- 绕过 capability 的提权机制
- 通用网络代理
- 平台业务 API 集合

游戏只能调用宿主已经注册并授予的插件方法。

## 2. 信任模型

插件代码属于宿主信任域。当前裸沙箱不支持加载不可信插件；如果未来需要第三方不可信插件，必须放到独立的进程、origin 或其他隔离运行时中，不能直接加载到宿主页面。

插件不能把自身声明的 capability 视为已获授权。最终授权来自宿主会话配置：

```text
插件声明 capability
        ↓
宿主 allowlist 授权
        ↓
游戏请求方法
        ↓
宿主校验方法、capability、payload 和配额
```

## 3. 插件标识与命名

插件 ID 使用稳定、全局唯一的反向域名形式：

```text
com.example.echo
```

内部桥接方法名和事件名必须带插件命名空间（公开的 `window.game` 别名在第 5.2 节单独配置）：

```text
com.example.echo.echo
com.example.echo.changed
```

同一宿主会话内禁止重复注册插件 ID、方法名或事件名。名称只能包含：

```text
^[a-z][A-Za-z0-9._-]*$
```

## 4. Manifest

```ts
interface SandboxPluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;              // SemVer
  bridgeProtocol: 1;
  capabilities: CapabilityDeclaration[];
  methods: MethodDeclaration[];
  events?: EventDeclaration[];
}

interface CapabilityDeclaration {
  name: string;
  description: string;
}

interface MethodDeclaration {
  name: string;
  capability?: string;
  maxPayloadBytes?: number;
  timeoutMs?: number;
  maxConcurrent?: number;
}

interface EventDeclaration {
  name: string;
  maxPayloadBytes?: number;
}
```

Manifest 只描述插件需要什么，不能自行授予能力。

## 5. 插件实现接口

建议的插件接口：

```ts
interface SandboxPlugin<I = unknown, O = unknown> {
  manifest: SandboxPluginManifest;
  methods: Record<string, SandboxPluginMethod<I, O>>;
  start?: (context: PluginStartContext) => void | Promise<void>;
  stop?: (reason: string) => void | Promise<void>;
}

interface PluginStartContext {
  readonly pluginId: string;
  readonly capabilities: readonly string[];
}

interface SandboxPluginMethod<I = unknown, O = unknown> {
  capability?: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler: (
    input: I,
    context: PluginMethodContext,
  ) => O | Promise<O>;
}

interface PluginMethodContext {
  readonly pluginId: string;
  readonly methodName: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}
```

实现时应把 `input`、`output` schema 适配到当前 `HostMethodDefinition.validate` 和响应校验中。内容公共 API 不接收插件对象、宿主 `window`、iframe DOM 或 `MessagePort`；内部 client 由平台预加载脚本持有。

### 5.1 共享宿主契约与实现

契约放在宿主注册与游戏资源渲染器共用的受信任模块中，而不是上传内容中。`echo.contract.ts`：

```ts
import { z } from "zod";
import {
  defineMethod,
  defineSandboxPlugin,
} from "@codemao-pickcat/browser-game-sandbox";

export const echoContract = defineSandboxPlugin({
  id: "com.example.echo",
  version: "1.0.0",
  gameApi: { echo: "echo" },
  methods: {
    echo: defineMethod({
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});
```

用同一份契约绑定受信任宿主处理器；输入/输出类型可推导，宿主 Zod 校验仍是最终校验方：

```ts
import {
  SandboxHostSession,
  composeHostPlugins,
  createHostPlugin,
} from "@codemao-pickcat/browser-game-sandbox";
import { echoContract } from "./echo.contract";

const hostExtensions = composeHostPlugins([
  createHostPlugin(echoContract, {
    echo: async (input, context) => input,
  }),
], {
  // 最终授权只能由受信任宿主明确配置。
  grantedCapabilities: ["com.example.echo"],
});

const session = new SandboxHostSession({
  // ... window、iframe 和精确的 gameOrigin ...
  capabilities: hostExtensions.capabilities,
  methods: hostExtensions.methods,
});
```

Schema 和 handler 留在受信任宿主。内容不需要引入契约或类型化 SDK；可选的本地类型声明应匹配已部署的 `window.game` 别名。内容 SDK（包括 Vue 适配器）已下线，参见[破坏性迁移](./usage.zh-CN.md#43-破坏性迁移)。

### 5.2 平台预加载的 window.game 方法

契约可添加 `gameApi: { echo: "echo" }`，由平台预加载暴露为 `window.game.echo(payload, options)`。键是扁平公开名（`^[a-z][A-Za-z0-9_]{0,63}$`），值必须是当前插件 `methods` 的自有方法；`then`、`constructor`、`prototype` 和 `__proto__` 不允许使用，多个插件的公开名不得冲突。未配置映射的插件不自动暴露。

`composeHostPlugins` 额外返回冻结的 `gameApi` 映射（公开名 → 完整宿主方法名），供可信游戏资源渲染器使用同一部署版本的宿主契约，传入 `renderSandboxGamePreloadScript`：

```ts
import { renderSandboxGamePreloadScript } from "@codemao-pickcat/browser-game-sandbox";

const preloadTag = renderSandboxGamePreloadScript({
  src: "/__sandbox/game.preload.js",
  expectedHostOrigin: "https://host.example.test",
  methods: hostExtensions.gameApi,
});
```

配置不能包含 handler、schema 或凭据，映射不会授予 capability，也不能使未映射方法变成私有方法；预加载调用仍经过相同宿主校验与配额限制。平台须把 `dist/game.preload.js` 精确挂载到该保留同源路径，加入资源白名单，并在受控 `<head>` 中、所有游戏可控标记之前输出同步经典脚本标签。上传文件不能覆盖此路径，不可添加 `async`、`defer` 或 `type="module"`。完整步骤见[使用手册](./usage.zh-CN.md#平台自动预加载)。

## 6. 生命周期

插件生命周期为：

```text
未注册 → 校验中 → 已注册 → active → stopping → stopped
                         ↘ failed
```

规则：

1. 插件在宿主会话启动前注册。
2. Manifest、命名空间、schema 和 capability 声明必须全部通过后才允许注册。
3. 注册失败时使用原子失败，不保留部分方法。
4. v1 不支持游戏运行期间动态安装、卸载或替换插件。
5. 宿主终止时先取消未完成调用，再停止插件。
6. `stop` 不能阻止沙箱终止。

## 7. 方法调用规范

内容调用已配置别名，预加载内部 client 通过不变的桥接协议路由到 `com.example.echo.echo`：

```js
const controller = new AbortController();
const result = await window.game.echo(
  { value: "hello" },
  { signal: controller.signal, timeoutMs: 2_000 },
);
```

取消由内容自身创建的 `AbortController` 控制；内容不获取通用桥接 `call` 方法。

宿主执行顺序：

```text
协议 schema
→ 速率配额
→ 请求 ID 重放/预算检查
→ 全局并发配额
→ 方法是否存在
→ capability 是否由宿主授予
→ payload 大小
→ 方法并发配额
→ input schema
→ handler
→ output schema
→ 响应大小
```

任何一步失败都不能执行 handler 或返回未校验结果。

## 8. 事件规范

插件事件仅在内部运行时协议层由宿主发送给游戏，不是公开的 `window.game` 功能。宿主可发送事件，但预加载不提供内容订阅 API：

```ts
session.emit("com.example.echo.changed", {
  value: "updated",
});
```

事件必须：

- 在 manifest 中声明
- 使用插件命名空间
- 经过 payload schema 校验
- 受 payload 大小限制
- 不携带宿主凭据、内部错误或 `MessagePort`

## 9. 外部调用

插件可以在宿主侧通过单独的 Adapter 访问外部资源，但不能把任意 `fetch` 暴露给游戏。

推荐接口：

```ts
interface OutboundAdapter {
  request(
    target: string,
    request: OutboundRequest,
    context: PluginMethodContext,
  ): Promise<OutboundResponse>;
}
```

Adapter 必须拥有：

- 固定的目标 origin allowlist
- 固定的协议和 HTTP 方法 allowlist
- 请求/响应大小限制
- 超时和取消
- 脱敏后的错误
- 禁止把密钥或 Cookie 返回给游戏

插件不得接受游戏传入的任意 URL 后直接请求。目标 URL 应由插件根据固定配置构造，或由 Adapter 再次校验。

## 10. 错误规范

插件错误不得把宿主堆栈、文件路径、密钥、内部 URL 或数据库信息传给游戏。

建议错误分类：

```text
INVALID_INPUT
NOT_ALLOWED
TIMEOUT
CANCELLED
RATE_LIMITED
EXTERNAL_UNAVAILABLE
INTERNAL_ERROR
```

错误响应必须经过统一脱敏和长度限制。

## 11. 版本与兼容性

插件版本和桥接协议版本独立：

- `bridgeProtocol`：消息传输协议版本
- `manifest.version`：插件实现版本
- 方法输入/输出 schema：方法契约版本

破坏性修改必须：

- 升级插件 major 版本；或
- 使用新的方法名；或
- 使用新的 capability 名称

同名方法不能静默改变输入或输出含义。

## 12. 安全要求

- 插件注册发生在宿主侧，不接受游戏注册。
- capability allowlist 由宿主配置决定。
- 插件不能直接操作游戏 iframe DOM。
- 插件不能替换或持有宿主桥接端口。
- 插件处理器必须尊重 `AbortSignal`。
- 每个方法必须有输入和输出 schema。
- 外部调用必须经过专用 Adapter。
- 插件包版本必须锁定并经过供应链审查。
- 插件不能通过返回值、事件或错误信息泄漏宿主秘密。

## 13. 与当前实现的关系

当前 `SandboxHostSession` 的 `methods` 配置已经是插件规范的底层 Adapter seam：

```ts
new SandboxHostSession({
  capabilities: ["com.example.echo"],
  methods: {
    "com.example.echo.echo": {
      capability: "com.example.echo",
      validate(payload) {},
      handler(payload, context) {},
    },
  },
  // ...
});
```

正式插件注册器应负责把多个插件的 manifest 和方法转换为这个配置，并在注册阶段处理命名冲突、schema、版本和 capability allowlist。

## 14. 必须具备的合规测试

每个插件至少需要测试：

- 重复插件 ID 被拒绝
- 重复方法/事件名被拒绝
- 重复公开别名、保留名称和未知 `gameApi` 目标被拒绝
- 未配置 `gameApi` 的插件不暴露别名，组合后的映射被冻结
- 别名路由到正确的完整方法名，且不能绕过宿主 capability 校验
- 未授予 capability 时 handler 不执行
- 输入 schema 失败时 handler 不执行
- 输出 schema 失败时结果不返回
- 超大输入/输出被拒绝
- 重放 request ID 不重复执行
- 取消会触发 `AbortSignal`
- 超时不会泄漏内部错误
- 外部 Adapter 拒绝非 allowlist origin
- 插件停止后不能继续调用宿主
