# Bare Sandbox Host Plugin Specification

Status: design draft v1.

## 1. Scope

A plugin is a **trusted host-side extension** that provides controlled methods and internal protocol events. Content calls explicitly configured methods through the platform-preloaded `window.game`; it installs no sandbox package or framework adapter. The preload has no public event-subscription interface.

A plugin is not:

- A dynamic module installed by game code
- A privilege-escalation mechanism
- A generic network proxy
- A platform business API collection

The game can call only methods registered and granted by the host.

## 2. Trust model

Plugin code belongs to the trusted host domain. The bare sandbox does not load untrusted plugins into the host. If untrusted third-party plugins are ever supported, they require a separate process, origin, or equivalent isolation mechanism.

A plugin declaration does not grant itself a capability. Final authorization comes from the host session:

```text
Plugin declares capability
        ↓
Host allowlist grants capability
        ↓
Game requests method
        ↓
Host checks method, capability, payload, and quotas
```

## 3. Identity and namespacing

Plugin IDs use stable reverse-domain names:

```text
com.example.echo
```

Internal bridge method and event names must include the plugin namespace (public `window.game` aliases are configured separately in section 5.2):

```text
com.example.echo.echo
com.example.echo.changed
```

A host session must reject duplicate plugin IDs, method names, and event names. Names must match:

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
  defaultTimeoutMs?: number | undefined; // Defaults to 5000ms; explicit values must be finite positive
  maxPayloadBytes?: number;
  timeoutMs?: number;         // Optional independent host execution hard cap
  maxConcurrent?: number;
}

interface EventDeclaration {
  name: string;
  maxPayloadBytes?: number;
}
```

The manifest declares requirements; it does not grant capabilities.

## 5. Plugin interface

Recommended interface:

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
  defaultTimeoutMs?: number | undefined;
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

The implementation should adapt `input` and `output` schemas to the current `HostMethodDefinition` and response validation. The public content API never receives the plugin object, host `window`, iframe DOM, or `MessagePort`; the platform preload owns the internal client.

### 5.1 Shared host contract and implementation

Keep the contract in a trusted shared module used by host registration and the game-resource renderer, not in uploaded content. `echo.contract.ts`:

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
      defaultTimeoutMs: 5000, // Optional; omission or undefined uses 5000ms.
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});
```

Top-level `defaultTimeoutMs` in `defineMethod` configurations and `SandboxMethodContract` may be omitted or `undefined`, defaulting to `5000ms`. Raw method contracts and methods without a `gameApi` alias follow the same rule. Explicit values must be finite positive numbers; `null`, zero, negative values, strings, `NaN` and infinities are invalid. This is the overridable game-side call default, not the optional independent host-side `limits.timeoutMs` hard cap.

Bind that contract to trusted host handlers. Their input/output types are inferred, and host-side Zod validation remains authoritative:

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
  // Only the trusted host decides which declared capabilities are granted.
  grantedCapabilities: ["com.example.echo"],
});

const session = new SandboxHostSession({
  // ... window, iframe and exact gameOrigin ...
  capabilities: hostExtensions.capabilities,
  methods: hostExtensions.methods,
});
```

Schemas and handlers stay on the trusted host. Content needs neither the contract nor a typed SDK; optional local type declarations must match the deployed `window.game` aliases. Content SDKs, including Vue adapters, are retired; see the [breaking migration](./usage.en.md#43-breaking-migration).

### 5.2 Platform-preloaded window.game methods

A contract may declare `gameApi: { echo: "echo" }` to expose `window.game.echo(payload, options)` through the platform preload. Keys are flat public names (`^[a-z][A-Za-z0-9_]{0,63}$`); values must be own methods of this plugin. `then`, `constructor`, `prototype` and `__proto__` are forbidden, and public names must not collide across plugins. Plugins without mappings expose nothing automatically.

`composeHostPlugins` additionally returns a frozen `gameApi` mapping whose values are frozen `{ method, defaultTimeoutMs }` bindings, not strings. For this contract it is `{ echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 } }`; the plugin declaration stays `gameApi: { echo: "echo" }`. The trusted game-resource renderer passes this mapping to `renderSandboxGamePreloadScript` using the same deployed host contract:

```ts
import { renderSandboxGamePreloadScript } from "@codemao-pickcat/browser-game-sandbox";

const preloadTag = renderSandboxGamePreloadScript({
  src: "/__sandbox/game.preload.js",
  expectedHostOrigin: "https://host.example.test",
  methods: hostExtensions.gameApi,
});
```

Migration: keep the `methods: hostExtensions.gameApi` call above unchanged. Convert manually authored string bindings to `{ method, defaultTimeoutMs }` objects, with a finite positive `defaultTimeoutMs` for every binding. `SandboxGamePreloadConfig` no longer supports a shared `defaultTimeoutMs` field; remove it. Plugin composition fills omitted or `undefined` method defaults with `5000ms`; only manually authored preload bindings need to supply that resolved value themselves.

Data must contain no handlers, schemas or credentials. Aliases do not grant capabilities or make unmapped methods private; all calls retain the same host validation and quotas. The platform must mount `dist/game.preload.js` on that exact reserved same-origin route, include it in the resource allowlist, and emit the synchronous classic tag in its controlled `<head>` before all game-controlled markup. Uploaded files must not override it; do not add `async`, `defer` or `type="module"`. See the [usage guide](./usage.en.md#platform-managed-preload) for complete integration steps.

## 6. Lifecycle

```text
unregistered → validating → registered → active → stopping → stopped
                                         ↘ failed
```

Rules:

1. Plugins register before the host session starts.
2. Manifest, namespace, schemas, and capability declarations must all validate before registration.
3. Registration is atomic; a failed plugin leaves no partial methods.
4. v1 does not support installing, removing, or replacing plugins while a game is running.
5. Host termination first cancels in-flight calls and then stops plugins.
6. `stop` cannot prevent sandbox termination.

## 7. Method calls

Content calls the configured alias; the private preload client routes it to `com.example.echo.echo` over the unchanged bridge protocol:

```js
const controller = new AbortController();
const result = await window.game.echo(
  { value: "hello" },
  { signal: controller.signal, timeoutMs: 2_000 },
);
```

The call shape remains `window.game.xxx(payload, { signal, timeoutMs })`. Game-side timeout precedence is per-call `options.timeoutMs` > the method's `defaultTimeoutMs` (`5000ms` when omitted by the plugin). The override may shorten or lengthen the default; the selected timeout includes waiting for the handshake. `handshakeTimeoutMs` remains an independent shared-handshake limit.

The optional host-side `limits.timeoutMs` remains an independent hard cap on host execution, not a game-side default. A per-call override cannot extend or disable that cap. Cancellation is unchanged: it uses the content-owned `AbortController`, does not cancel the shared handshake, and is forwarded to the host after dispatch. Handlers must respect `AbortSignal`. Content never receives a generic bridge `call` method.

The host execution order is:

```text
Protocol schema
→ rate quota
→ request ID replay/budget check
→ global concurrency quota
→ method exists
→ capability granted by host
→ payload size
→ method concurrency quota
→ input schema
→ handler
→ output schema
→ response size
```

A failed step must not invoke the handler or return an unvalidated result.

## 8. Events

Plugin events are host-to-game only at the internal runtime protocol layer, not a public `window.game` feature. The host can emit an event; the preload provides no content subscription API:

```ts
session.emit("com.example.echo.changed", {
  value: "updated",
});
```

Events must be declared in the manifest, namespaced, schema-validated, size-limited, and free of host credentials, internal errors, and `MessagePort` objects.

## 9. External calls

A plugin may access external resources from the host through a dedicated Adapter. It must not expose arbitrary `fetch` to the game.

```ts
interface OutboundAdapter {
  request(
    target: string,
    request: OutboundRequest,
    context: PluginMethodContext,
  ): Promise<OutboundResponse>;
}
```

The Adapter must enforce:

- Fixed target-origin allowlists
- Fixed protocol and HTTP-method allowlists
- Request and response size limits
- Timeout and cancellation
- Sanitized errors
- No secrets or cookies returned to the game

A plugin must not accept an arbitrary URL from the game and fetch it directly. The plugin should construct targets from fixed configuration, or the Adapter must validate them again.

## 10. Errors

Plugin errors must not expose host stacks, file paths, secrets, internal URLs, or database details.

Recommended categories:

```text
INVALID_INPUT
NOT_ALLOWED
TIMEOUT
CANCELLED
RATE_LIMITED
EXTERNAL_UNAVAILABLE
INTERNAL_ERROR
```

Error responses must be sanitized and length-limited centrally.

## 11. Versioning

Plugin versions and bridge protocol versions are independent:

- `bridgeProtocol`: transport protocol version
- `manifest.version`: plugin implementation version
- Input/output schemas: method contract versions

Breaking changes must use a new plugin major version, a new method name, or a new capability name. A method name must not silently change its input or output meaning.

## 12. Security requirements

- Plugins register on the host; games cannot register plugins.
- Capability allowlists are owned by the host configuration.
- Plugins cannot manipulate the game iframe DOM.
- Plugins cannot replace or retain the host bridge port.
- Handlers must respect `AbortSignal`.
- Every method has input and output schemas; `defaultTimeoutMs` is optional with a `5000ms` fallback, and explicit values must be finite positive numbers.
- External calls go through a dedicated Adapter.
- Plugin package versions are pinned and supply-chain reviewed.
- Plugins must not leak host secrets through results, events, or errors.

## 13. Relationship to the current implementation

The current `SandboxHostSession.methods` option is already the low-level Adapter seam:

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

A formal plugin registry should translate plugin manifests and methods into this configuration, while handling namespace collisions, schemas, versions, and capability allowlists atomically.

## 14. Required conformance tests

Every plugin should test:

- Duplicate plugin IDs are rejected
- Duplicate method/event names are rejected
- Duplicate public aliases, reserved names and unknown `gameApi` targets are rejected
- Plugins without `gameApi` expose no aliases; the composed mapping and its `{ method, defaultTimeoutMs }` bindings are frozen
- Omitted or `undefined` plugin method defaults become `5000ms`; explicitly invalid values and manually authored preload bindings missing a default are rejected
- Per-call `options.timeoutMs` overrides the binding default in either direction, includes handshake waiting, and cannot override `handshakeTimeoutMs` or the host `limits.timeoutMs` hard cap
- Preload configuration has no shared `defaultTimeoutMs` field; composition always fills in each binding's resolved default
- Aliases route to the correct namespaced method without bypassing host capability checks
- A missing capability never invokes the handler
- Input schema failure never invokes the handler
- Output schema failure is not returned to the game
- Oversized input/output is rejected
- Replayed request IDs do not execute twice
- Cancellation reaches `AbortSignal`
- Timeouts do not leak internal errors
- External Adapters reject non-allowlisted origins
- A stopped plugin cannot continue calling the host
