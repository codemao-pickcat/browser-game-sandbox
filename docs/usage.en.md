# Browser Game Sandbox Usage Guide

This guide documents the bare sandbox runtime. It covers the trusted host, the untrusted game iframe, and the host bridge. It does not define platform accounts, publishing, rooms, cloud storage, or other business APIs.

## 1. Runtime model

```text
Trusted host page
  └── cross-origin iframe
        └── untrusted game package
```

The bridge has two phases:

1. `window.postMessage` performs the initial handshake.
2. A transferred `MessageChannel` carries all subsequent requests, responses, events, cancellation, and termination messages.

The host is the security authority. The game-side client is only a typed convenience wrapper and must not be treated as a security boundary. Runtime protocol messages are validated with strict Zod schemas; payload size estimation and browser-origin checks remain separate runtime controls.

## 2. Installation and build

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
  src="https://game.example.test/index.html"
  sandbox="allow-scripts allow-same-origin"
></iframe>
```

Create and start a host session:

```ts
import { SandboxHostSession } from "@codemao-pickcat/browser-game-sandbox";

const iframe = document.querySelector("#game-frame");
if (!(iframe instanceof HTMLIFrameElement)) {
  throw new Error("Game iframe was not found");
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
          throw new TypeError("Expected an object payload");
        }
      },
      handler(payload, { signal }) {
        if (signal.aborted) throw new Error("Request cancelled");
        return payload;
      },
    },
  },
  onRequestClose(reason) {
    console.log("Game requested close:", reason);
  },
});

session.start();
await session.connected;
```

`gameOrigin` must be an exact `http` or `https` origin, including scheme and port when applicable. Paths, wildcards, and `*` are rejected or unsafe.

### Host options

| Option | Default | Meaning |
| --- | ---: | --- |
| `gameOrigin` | required | Exact origin allowed to initiate the handshake |
| `capabilities` | `[]` | Capabilities granted to registered host methods |
| `browserCapabilities` | `[]` | Declared browser capability profile; must match the actual iframe/CSP policy |
| `maxPayloadBytes` | `65536` | Maximum estimated structured-clone payload size |
| `maxRequestsPerSecond` | `30` | Request rate limit per session |
| `maxConcurrentRequests` | `64` | Maximum unresolved host handlers |
| `maxRequestIds` | `10000` | Maximum remembered request IDs per session |
| `handshakeTimeoutMs` | `5000` | Time allowed for the handshake |

## 4. Game integration

The game must know the exact trusted host origin. It should come from trusted runtime configuration, not from arbitrary user input.

```ts
import { acceptSandboxBridge } from "@codemao-pickcat/browser-game-sandbox";

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

`acceptSandboxBridge` announces readiness to the parent with an exact `targetOrigin`, validates the parent source and origin, accepts exactly one transferred port, and sends the port-level ready message.

## 5. Calling host methods

```ts
const echoed = await bridge.call<{ value: string }>(
  "example.echo",
  { value: "hello" },
);
```

Method names must match:

```text
^[a-z][A-Za-z0-9._-]*$
```

A method is executable only when:

1. The host registered it.
2. Its declared capability is present in `capabilities`.
3. Its payload validator accepts the input.
4. The request passes size, rate, concurrency, and request-ID checks.

A field inside the game payload cannot grant a capability.

### 5.1 Typed plugin SDK

A plugin contract can be imported by the game-side SDK so method names, inputs, and outputs are inferred from the contract:

```ts
const sdk = createSandboxSdk(bridge, { echo: echoPlugin });
const result = await sdk.echo.echo({ value: "hello" });
// result.value is typed as string
```

The SDK validates inputs before sending and validates host outputs before returning them to game logic. The host still performs its own validation; client-side validation is not a security boundary.

## 6. Cancellation and timeouts

```ts
const controller = new AbortController();

const request = bridge.call(
  "example.echo",
  { value: "hello" },
  { signal: controller.signal, timeoutMs: 2_000 },
);

controller.abort();
await request; // rejects with SandboxBridgeError(code === "CANCELLED")
```

The host receives an `AbortSignal`. Host handlers should stop work when it is aborted. Cancellation is cooperative; JavaScript cannot forcibly stop an arbitrary promise.

## 7. Events and termination

Game-side subscription:

```ts
const unsubscribe = bridge.on("example.event", (payload) => {
  console.log("Received event", payload);
});

unsubscribe();
```

Host-side event:

```ts
session.emit("example.event", { value: "hello" });
```

Terminate the sandbox:

```ts
session.terminate("Host revoked the sandbox");
```

Termination sends `sandbox.terminated`, closes the port, rejects pending calls, and removes the host message listener. A game-side termination handler cannot prevent bridge cleanup.

## 8. Built-in methods

The core host provides these methods:

| Method | Result |
| --- | --- |
| `sandbox.ping` | `{ ok: true }` |
| `sandbox.getInfo` | `{ protocolVersion }` |
| `sandbox.getCapabilities` | `{ capabilities }` |
| `sandbox.getBrowserCapabilities` | `{ capabilities }` |
| `sandbox.requestClose` | Calls the host `onRequestClose` callback |

These are runtime lifecycle methods, not platform business APIs.

## 9. Security requirements

### Origin and source checks

The host must check both:

```ts
event.origin === gameOrigin
event.source === iframe.contentWindow
```

The game client must check both:

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

The game can query them with `sandbox.getBrowserCapabilities`. This declaration does not override browser security policy; the host must enforce the same profile through iframe flags and response headers. `buildBrowserPolicy` generates sandbox tokens, iframe `allow`, CSP, Permissions-Policy, enforcement status, and warnings.

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

The tested baseline allows Blob Dedicated Workers with `worker-src blob:` and denies Service Workers. Storage, WebGL, WebAudio, WebRTC, and the distinction between Dedicated and Shared Workers are declarative limitations in ordinary browsers; the policy builder reports warnings for them instead of claiming hard isolation.

### Important limitations

- This is a browser-level boundary, not an OS/container boundary.
- The bridge does not provide a generic network proxy.
- `localStorage` and `IndexedDB` are browser APIs, not bridge capabilities that can be revoked per call.
- Any code running inside the sandbox context that receives the `MessagePort` has the same bridge authority as the game. There is no script-level identity separation.
- Dedicated Worker support and Service Worker denial must be verified in the target browsers.
- Host method handlers are trusted host code; their own authorization logic is outside this package.

## 10. Validation and error handling

The bridge uses strict Zod schemas for protocol envelopes. Unknown envelope fields, missing required fields, unsupported protocol versions, and contradictory response fields are rejected before a host method is invoked. Zod validates message shape; it does not replace origin/source checks, capability checks, payload limits, rate limits, or host-side authorization.

## 11. Error handling

Errors are reported as `SandboxBridgeError`:

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
- Request IDs are single-use for the lifetime of a host session.
- Only one `MessageChannel` can be established per host session.
- Invalid messages are ignored or rejected without invoking a host handler.
- Payloads are bounded on both outbound and inbound paths.
- Host errors are sanitized before crossing into the sandbox.
- `MessageChannel` is a capability transfer; keep the port inside the sandbox context.
