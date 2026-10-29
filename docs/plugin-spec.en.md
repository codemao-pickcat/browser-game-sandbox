# Bare Sandbox Host Plugin Specification

Status: design draft v1.

## 1. Scope

A plugin is a **trusted host-side extension** that exposes controlled methods and events to the game.

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

Methods and events must include the plugin namespace:

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
  maxPayloadBytes?: number;
  timeoutMs?: number;
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

The implementation should adapt `input` and `output` schemas to the current `HostMethodDefinition` and response validation. The game never receives the plugin object, host `window`, iframe DOM, or `MessagePort`.

### 5.1 Game-side SDK

The plugin contract can be imported by the game-side SDK. The SDK infers method names, input types, and output types from the plugin object:

```ts
import { z } from "zod";
import {
  createSandboxSdk,
  defineMethod,
  defineSandboxPlugin,
} from "@codemao-pickcat/browser-game-sandbox";

const echoPlugin = defineSandboxPlugin({
  id: "com.example.echo",
  version: "1.0.0",
  methods: {
    echo: defineMethod({
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});

const sdk = createSandboxSdk(bridge, { echo: echoPlugin });
const result = await sdk.echo.echo({ value: "hello" });
// result.value: string
```

The SDK validates inputs before sending and validates host outputs before returning them to game logic.

The same contract can be bound to a host implementation:

```ts
import {
  composeHostPlugins,
  createHostPlugin,
} from "@codemao-pickcat/browser-game-sandbox";

const hostExtensions = composeHostPlugins([
  createHostPlugin(echoPlugin, {
    echo: async (input, context) => input,
  }),
]);

const session = new SandboxHostSession({
  // ...
  capabilities: hostExtensions.capabilities,
  methods: hostExtensions.methods,
});
```

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

The game calls a namespaced method:

```ts
const result = await bridge.call(
  "com.example.echo.echo",
  { value: "hello" },
);
```

The host execution order is:

```text
Protocol schema
→ method exists
→ capability granted by host
→ payload size
→ request ID replay check
→ rate/concurrency quota
→ input schema
→ handler
→ output schema
→ response size
```

A failed step must not invoke the handler or return an unvalidated result.

## 8. Events

Plugin events are host-to-game only:

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
- Every method has input and output schemas.
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
- A missing capability never invokes the handler
- Input schema failure never invokes the handler
- Output schema failure is not returned to the game
- Oversized input/output is rejected
- Replayed request IDs do not execute twice
- Cancellation reaches `AbortSignal`
- Timeouts do not leak internal errors
- External Adapters reject non-allowlisted origins
- A stopped plugin cannot continue calling the host
