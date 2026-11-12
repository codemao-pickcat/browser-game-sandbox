# Browser Game Sandbox Usage Guide

This guide documents the bare sandbox runtime. It covers the trusted host, the untrusted game iframe, and the host bridge. It does not define platform accounts, publishing, rooms, cloud storage, or other business APIs.

For the new **opaque offline-package entry**, including pure Node/browser preparation, scope-bound string storage and its explicit compatibility/network limits, see [Offline package runtime](./offline-package.zh-CN.md). The rest of this guide describes the existing cross-origin HTTP-resource integration; its Origin checks are unchanged.

## 1. Runtime model

```text
Trusted host page
  └── cross-origin iframe
        └── untrusted game package
```

The bridge has two phases:

1. `window.postMessage` performs the initial handshake.
2. A transferred `MessageChannel` carries all subsequent requests, responses, events, cancellation, and termination messages.

The platform preload owns the internal game-side MessageChannel client; content uses only the configured `window.game` methods and never opens a bridge connection. The host is the security authority. The preload is a convenience surface, not a security boundary. Runtime protocol messages are validated with strict Zod schemas; payload size estimation and browser-origin checks remain separate runtime controls.

## 2. Platform installation and build

These commands are for runtime contributors and trusted platform integration. Content developers do not install this package, including in Vue projects.

```bash
npm install
npm run build
```

Run the protocol tests:

```bash
npm test
```

Run the real Chromium integration tests:

```bash
npx playwright install chromium
npm run test:browser
```

Run everything:

```bash
npm run test:all
```

## 3. Host integration

Create an iframe with a stable, exact game origin. Do not use a wildcard origin.

```html
<iframe
  id="game-frame"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

Create and start a host session:

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
      defaultTimeoutMs: 5000, // Optional; omission or undefined uses 5000ms.
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});
const extensions = composeHostPlugins([
  createHostPlugin(echo, {
    echo(input, { signal }) {
      if (signal.aborted) throw new Error("Request cancelled");
      return input;
    },
  }),
], { grantedCapabilities: ["com.example.echo"] });

const iframe = document.querySelector("#game-frame");
if (!(iframe instanceof HTMLIFrameElement)) {
  throw new Error("Game iframe was not found");
}

const session = new SandboxHostSession({
  window,
  iframe,
  gameOrigin: "https://game.example.test",
  capabilities: extensions.capabilities,
  methods: extensions.methods,
  onRequestClose(reason) {
    console.log("Game requested close:", reason);
  },
});

session.start();
iframe.src = "https://game.example.test/index.html";
await session.connected;
```

Start the session before assigning the iframe `src` so the host is already listening when the platform preload announces the handshake. The resource server must complete the preload integration in section 4 before serving the game.

`gameOrigin` must be an exact `http` or `https` origin, including scheme and port when applicable. It must be cross-origin from the host page. Paths, wildcards, commas, quotes, and `*` are rejected.

### Game entry and resource allowlist

The game resource server should make `index.html` the only entry point and apply a resource allowlist to every request. `createSandboxGamePackagePolicy` accepts only explicitly listed package-relative paths and rejects traversal, encoded paths, queries, fragments, cross-origin URLs, and undeclared resources:

```ts
import { createSandboxGamePackagePolicy } from "@codemao-pickcat/browser-game-sandbox";

const packagePolicy = createSandboxGamePackagePolicy({
  entry: "index.html",
  resources: [
    "index.html",
    "game.js",
    "styles/game.css",
    "assets/logo.png",
    "__sandbox/game.preload.js", // Reserved platform asset, never an uploaded file.
  ],
});

packagePolicy.assertEntryPath("/index.html");

function serveGameRequest(pathname: string): void {
  const path = packagePolicy.assertAllowedResourcePath(pathname);
  if (path === "/__sandbox/game.preload.js") {
    // Serve the trusted package's dist/game.preload.js, not an uploaded file.
    return;
  }
  // Read the game package only through the validated path.
  console.log("serve", path);
}
```

The resource server must still send the same CSP on every HTML document. The host watches the iframe's top-level `load` event; a second load after the initial document terminates the session, which prevents a running game from switching to an uncontrolled document. The resource allowlist and navigation watcher are both needed because a cross-origin host cannot read the iframe's current URL directly.

### Host options

| Option | Default | Meaning |
| --- | ---: | --- |
| `gameOrigin` | required | Exact origin allowed to initiate the handshake; must differ from the host origin |
| `hostOrigin` | inferred | Optional explicit host origin; same-origin game configurations are rejected |
| `capabilities` | `[]` | Capabilities granted to registered host methods |
| `browserCapabilities` | `[]` | Declared browser capability profile; must match the actual iframe/CSP policy |
| `maxPayloadBytes` | `65536` | Maximum estimated structured-clone payload size |
| `maxRequestsPerSecond` | `30` | Request rate limit per session |
| `maxConcurrentRequests` | `64` | Maximum unresolved host handlers |
| `maxRequestIds` | `10000` | Maximum remembered request IDs per session |
| `requestIdTtlMs` | `60000` | How long a request ID remains reserved |
| `handshakeTimeoutMs` | `5000` | Time allowed for the handshake |

## 4. Game integration

### Platform-managed preload

The platform must create `window.game` before any game script runs, using explicit plugin configuration. Content developers install no sandbox package, add no preload script tag and perform no handshake:

```js
const result = await window.game.echo({ value: "hello" });
```

Trusted plugins opt into flat global aliases through `gameApi`, as in section 3. Plugins without `gameApi` expose no global methods automatically. `composeHostPlugins()` returns a frozen mapping from each alias to a frozen binding containing its fully namespaced host `method` and the resolved `defaultTimeoutMs` (`5000ms` when the plugin omits it or supplies `undefined`). For this example, `extensions.gameApi` is `{ echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 } }`; the plugin declaration remains `gameApi: { echo: "echo" }`. The trusted game-resource renderer must use that same deployment's plugin configuration:

```ts
import { renderSandboxGamePreloadScript } from "@codemao-pickcat/browser-game-sandbox";

// extensions is composed from the shared trusted host contract in section 3.
const preloadTag = renderSandboxGamePreloadScript({
  src: "/__sandbox/game.preload.js",
  expectedHostOrigin: "https://host.example.test",
  methods: extensions.gameApi,
});
```

**The platform must implement this integration. This library includes no HTML resource server and cannot modify a cross-origin game's DOM from the parent:**

1. Mount the package's `dist/game.preload.js` at the exact reserved game-origin route `/__sandbox/game.preload.js`. Uploaded resources must not override it; do not open the entire directory.
2. Emit `preloadTag` inside the trusted renderer's `<head>`, **before all game-controlled markup**, then render game content. This is a synchronous classic script: do not add `async`, `defer` or `type="module"`. Integrate through a controlled template or an HTML parser, not unreliable string replacement over arbitrary uploaded HTML.
3. Include `index.html`, game resources and `__sandbox/game.preload.js` in the exact resource allowlist. Retain CSP, Permissions-Policy and navigation restrictions on every HTML response. The bundle is self-contained: no import map, configuration fetch or `unsafe-inline` is needed; `script-src 'self'` and `connect-src 'none'` remain unchanged.
4. Start the host session before navigating the iframe. The exact host origin and bindings must come from trusted startup configuration, never the uploaded game, referrer or unchecked request parameters. Preload data must contain no credentials; caches must not mix host origins or plugin versions.

The preload synchronously installs a frozen, non-replaceable `window.game` containing only explicitly mapped methods. Duplicate aliases, existing globals, unknown targets, `then` and prototype-related names are rejected. Methods always return Promises and accept `{ signal, timeoutMs }` as their second argument. Plugin method `defaultTimeoutMs` may be omitted or `undefined`; composition fills it with `5000ms`, so each preload binding always carries a resolved finite positive default. A per-call `options.timeoutMs` overrides it. The call timeout includes handshake waiting. At most 64 calls wait before the handshake, with a default 65536-byte payload limit. Configure the independent `handshakeTimeoutMs`, `maxPayloadBytes` and `maxQueuedCalls` on the tag helper if needed; `SandboxGamePreloadConfig` has no shared `defaultTimeoutMs` field. Cancelling one call does not cancel the shared handshake; a failed handshake is not automatically retried.

Bindings are a convenience surface, **not an authorization allowlist**: game code can still construct bridge requests. Host-side capabilities, input/output Zod validation, quotas and error sanitization remain authoritative. Freezing globals is not isolation between game scripts and does not expose host functions or windows.

The preload is the only supported content integration. Its private client announces readiness with an exact `targetOrigin`, validates the parent source and origin, accepts exactly one transferred port, and sends the port-level ready message. Content never supplies the host origin or opens another connection. `window.game` exposes configured plugin methods only, not generic `call`, readiness, event subscription or connection-management interfaces.

### 4.1 Plain HTML without an SDK

The uploaded HTML includes only its own game script; the platform inserts the preload separately, before all game-controlled markup:

```html
<script src="/game.js" defer></script>
```

In `game.js`:

```js
async function startGame() {
  const result = await window.game.echo({ value: "hello" });
  console.log(result.value);
}

startGame().catch((error) => {
  console.error("Host call failed", error.code, error.message);
});
```

No sandbox imports, SDK script tags, import map or content-side Zod dependency are needed. A call can be made immediately; its Promise includes waiting for the platform handshake.

### 4.2 Native Vue 3 components without an SDK

Vue remains the game's own framework dependency. Start the app normally, without a sandbox Vue plugin or bridge configuration module:

```js
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

A component calls the same native global directly:

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
  <button @click="callHost">Call host</button>
  <p>{{ message }}</p>
</template>
```

There is no injected SDK, readiness ref or extra connection to await. For TypeScript content, the platform may supply a matching local `Window.game` declaration; it is not a reason to install the host runtime package.

### 4.3 Breaking migration

For per-method timeouts, optionally add top-level `defaultTimeoutMs` to `defineMethod` / `SandboxMethodContract`. Omission or `undefined` uses `5000ms`; explicitly supplied values must be finite positive numbers. Plugin `gameApi: { echo: "echo" }` declarations stay unchanged. Composed `gameApi` values change from strings to frozen `{ method: "com.example.echo.echo", defaultTimeoutMs: 5000 }` objects. Keep `renderSandboxGamePreloadScript({ methods: extensions.gameApi, ... })` unchanged; convert any manually authored string bindings to objects with a required `defaultTimeoutMs`, and remove the shared `SandboxGamePreloadConfig.defaultTimeoutMs`. Keep `window.game.xxx(payload, { signal, timeoutMs })` calls unchanged.

The entire content SDK, including Vue support, is removed rather than retained as a compatibility mode:

- Removed package paths: `@codemao-pickcat/browser-game-sandbox/game`, `@codemao-pickcat/browser-game-sandbox/vue`, and `game.global.js` (formerly `dist/game.global.js` / `window.CodemaoSandboxGame`).
- Removed root exports: `acceptSandboxBridge`, `SandboxBridgeClient`, `createSandboxSdk`, `connectSandboxHtmlSdk`, and `installSandboxGameApi`. Content must not deep-import their internal replacements.
- Remove SDK imports, script tags, Vue plugin installation, injected SDK/ready refs and manual connection setup. Call the configured `window.game` methods directly, including for cancellation and error handling.
- Only the root host API and `game.preload.js` platform asset remain public. Platforms must complete the preload/resource-server integration above before migrating content; there is no content-side fallback or automatic event API replacement.

The internal MessageChannel client, host security checks and protocol v1 remain intact. Removing public SDKs does not remove the bridge runtime.

## 5. Calling host methods

```js
const echoed = await window.game.echo({ value: "hello" });
```

Here `echo` is the configured public alias for `com.example.echo.echo`. Content cannot enumerate or invoke arbitrary methods through a generic API. Internal namespaced bridge method names must match:

```text
^[a-z][A-Za-z0-9._-]*$
```

A method is executable only when:

1. The host registered it.
2. Its declared capability is present in `capabilities`.
3. Its payload validator accepts the input.
4. The request passes size, rate, concurrency, and request-ID checks.

A field inside the game payload cannot grant a capability.

### 5.1 Contracts and validation

The shared contract belongs to trusted host registration and preload configuration, not a content-side SDK. Plugin method `defineMethod` configurations and `SandboxMethodContract` may include a top-level `defaultTimeoutMs`. Omission or `undefined` uses `5000ms`; explicitly supplied values must be finite positive numbers. Raw method contracts that bypass `defineMethod` follow the same rule, including methods without a `gameApi` alias. `createHostPlugin` and `composeHostPlugins` preserve host input/output Zod validation and inferred handler types. The preload checks transport limits but does not ship plugin schemas to content. Any local content type declaration must match the deployed aliases and payloads; it does not grant authority or replace host validation.

## 6. Cancellation and timeouts

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

The game-side timeout precedence is per-call `options.timeoutMs` > the method's `defaultTimeoutMs` (`5000ms` when omitted by the plugin). An override may be shorter or longer than that default. The selected timeout covers handshake waiting and execution. `handshakeTimeoutMs` separately limits the shared handshake and is not overridden by a call timeout.

The optional host-side `limits.timeoutMs` is an independent hard cap on host execution, not the game-side default. A longer per-call override cannot extend or disable that host cap. Cancelling a queued call releases its queue slot without cancelling the shared handshake; after dispatch, cancellation is forwarded to the host.

The host receives an `AbortSignal`. Host handlers should stop work when it is aborted. Cancellation is cooperative; JavaScript cannot forcibly stop an arbitrary promise.

## 7. Events and termination

Events remain part of the internal platform runtime protocol, not the public content API. `window.game` has no event subscription method. A host may emit protocol events, but content has no supported listener interface; migrate products that depended on subscriptions explicitly rather than opening a manual connection.

Host-side protocol event:

```ts
session.emit("example.event", { value: "hello" });
```

Terminate the sandbox:

```ts
session.terminate("Host revoked the sandbox");
```

Termination sends `sandbox.terminated`, closes the port, rejects pending calls, removes the host message listener, and best-effort removes the iframe when the supplied iframe supports `remove()`. It does not erase origin-persistent storage or unregister a Service Worker; those require a separate cleanup policy. Game code cannot prevent bridge cleanup.

## 8. Built-in methods

The core host provides these methods:

| Method | Result |
| --- | --- |
| `sandbox.ping` | `{ ok: true }` |
| `sandbox.getInfo` | `{ protocolVersion }` |
| `sandbox.getCapabilities` | `{ capabilities }` |
| `sandbox.getBrowserCapabilities` | `{ capabilities }` |
| `sandbox.requestClose` | Calls the host `onRequestClose` callback |

These are internal platform-runtime lifecycle methods, not public content APIs or platform business APIs. They are not automatically exposed on `window.game`; content uses only explicitly mapped plugin methods.

## 9. Security requirements

### Origin and source checks

The host must check both:

```ts
event.origin === gameOrigin
event.source === iframe.contentWindow
```

The private client inside the platform preload must check both (content does not implement this handshake):

```ts
event.origin === expectedHostOrigin
event.source === window.parent
```

### Recommended iframe policy

Start with:

```html
sandbox="allow-scripts allow-same-origin"
```

Do not add these unless there is a separately tested requirement:

```text
allow-popups
allow-top-navigation
allow-top-navigation-by-user-activation
allow-forms
allow-downloads
allow-modals
```

### Recommended game response headers

Headers must be generated by the sandbox host, not accepted from uploaded game content. A baseline policy is:

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

The exact policy may need to be relaxed for a specific engine, but every relaxation is a new capability decision.

### Browser capability declarations

The host can declare browser permissions separately from plugin capabilities:

```ts
new SandboxHostSession({
  // ...
  browserCapabilities: [
    "browser.worker.dedicated",
    "browser.storage.local",
  ],
});
```

The internal runtime protocol supports querying these declarations with `sandbox.getBrowserCapabilities`; this is not a public `window.game` method. This declaration does not override browser security policy; the host must enforce the same profile through iframe flags and response headers. `buildBrowserPolicy` generates sandbox tokens, iframe `allow`, CSP, Permissions-Policy, enforcement status, and warnings.

Available browser capability IDs include:

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

The tested baseline allows Blob Dedicated Workers with `worker-src blob:` and denies Service Workers. Ordinary browsers cannot use CSP to distinguish Dedicated Workers from Shared Workers, so both report `not-distinguishable` instead of pretending to provide strict isolation. Storage, WebGL, WebAudio, and WebRTC also cannot be fully enforced by an ordinary web page.

The `accept="image/*,video/*"` attribute on a file input is only a browser UI hint and cannot restrict the file a user ultimately selects. The baseline policy can block browser downloads, but it cannot turn the native file chooser into an image/video-only chooser; that product rule needs a trusted host-side file picker API.

### Important limitations

- This is a browser-level boundary, not an OS/container boundary.
- The bridge does not provide a generic network proxy.
- `localStorage` and `IndexedDB` are browser APIs, not bridge capabilities that can be revoked per call. Use a separate game origin per untrusted game if storage isolation matters.
- Any code running inside the sandbox context that receives the `MessagePort` has the same bridge authority as the game. There is no script-level identity separation.
- Dedicated/Shared Worker separation and Service Worker denial must be verified in the target browsers; ordinary CSP cannot strictly separate the first two.
- Host method handlers are trusted host code; their own authorization logic is outside this package.

## 10. Validation and error handling

The bridge uses strict Zod schemas for protocol envelopes. Unknown envelope fields, missing required fields, unsupported protocol versions, and contradictory response fields are rejected before a host method is invoked. Zod validates message shape; it does not replace origin/source checks, capability checks, payload limits, rate limits, or host-side authorization.

## 11. Error handling

Native `window.game` calls reject with errors carrying `code` and `message`. The runtime uses `SandboxBridgeError` internally; content does not import its class or rely on `instanceof` checks:

```js
try {
  await window.game.echo({ value: "hello" }, { timeoutMs: 2_000 });
} catch (error) {
  if (error.code === "CANCELLED") {
    // Caller cancelled; no user-facing failure is needed.
  } else if (error.code === "TIMEOUT") {
    console.warn("Host call timed out");
  } else {
    console.error("Host call failed", error.code, error.message);
  }
}
```

| Code | Meaning |
| --- | --- |
| `BRIDGE_CLOSED` | Port or sandbox has terminated |
| `CANCELLED` | Caller cancelled the request |
| `TIMEOUT` | Client-side call timeout or handshake timeout |
| `INVALID_MESSAGE` | Invalid method, ID, or protocol input |
| `INVALID_PAYLOAD` | Payload failed validation or size limits |
| `NOT_ALLOWED` | Required capability is not granted |
| `UNKNOWN_METHOD` | Host did not register the method |
| `RATE_LIMITED` | Rate, concurrency, or request-ID budget exceeded |
| `DUPLICATE_REQUEST` | Request ID was already used |
| `INTERNAL_ERROR` | Host handler failed; internal details are not exposed |

## 12. Protocol invariants

- Protocol version is currently `1`.
- Request IDs are reserved for the configured TTL; replay protection is bounded rather than permanent.
- Only one `MessageChannel` can be established per host session.
- Invalid messages are ignored or rejected without invoking a host handler.
- Payloads are bounded on both outbound and inbound paths.
- Host errors are sanitized before crossing into the sandbox.
- `MessageChannel` is a capability transfer; keep the port inside the sandbox context.
