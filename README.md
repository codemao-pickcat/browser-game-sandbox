# Browser Game Sandbox

Bare browser sandbox runtime for untrusted web games.

The runtime bridge uses a transferred `MessageChannel`. `window.postMessage` is used only for the initial handshake; all subsequent calls use the dedicated port.

This package contains no platform business API, credentials, network proxy, account model, room model, or cloud storage implementation.

## Build and test

The package is tested and published with Node.js 24 or newer.

```bash
npm install
npm test
npm run test:browser
```

The browser suite requires Chromium once:

```bash
npx playwright install chromium
```

## Offline package entry (0.4.1)

```ts
import { prepareSandboxPackage, createSandboxPackageSession } from "@codemao-pickcat/browser-game-sandbox";

// Same pure parser/integrity check in Node.js and in the browser; no user-code
// execution, DOM dependency or network access during preparation.
const prepared = await prepareSandboxPackage({ manifest, files });
// Trusted MOSS player MUST finish authorization before creating a session.
// permissions defaults to []; eval implies wasm. Do not infer grants from code.
const session = createSandboxPackageSession({ container, package: prepared, permissions, clipboard, storage, onTerminate });
await session.connected; // authenticated bootstrap/RPC, not content readiness
await session.ready;     // package loaded and initial scripts/modules evaluated
// session.terminate();
```

The execution entry is always root `index.html`; secondary HTML templates remain verified passive bytes for package-relative `fetch(...).text()`, never additional document/Blob/navigation entries. Unknown extensions and extensionless files (including names `js` and `json`) are accepted as raw GET/HEAD data with `application/octet-stream`, without automatic Blob URLs. They cannot be script/module/stylesheet, HTML resource attributes, CSS `url()`/`image-set()`, literal `new URL(..., import.meta.url)` or automatic Worker script targets. Known JSON/TXT/BIN and other supported formats keep their existing compatibility; sharing a MIME type with `.bin` does not grant fallback files Blob eligibility. Multi-file HTML/CSS/JS, static/literal-dynamic ESM imports, images/fonts/media and package-relative GET/HEAD fetch are supported within a documented compatibility matrix—not arbitrary ZIP transparency. A trusted embedded bootstrap authenticates an opaque iframe with the exact source, null Origin, one-time random token and one initial port. Package bytes have separate budgets/chunked transport; ordinary RPC stays at 64 KiB. Blobs are created inside the opaque child, not the parent.

Optional permissions are `worker`, `wasm`, `pointerLock`, `eval`, `clipboardRead`, all disabled by default. Exported `SANDBOX_PACKAGE_PERMISSIONS` is frozen in that order; `normalizeSandboxPackagePermissions(unknown)` rejects non-arrays/unknown entries, deduplicates, sorts and adds `wasm` when `eval` is present. Worker/WASM/eval are enforced by the offline CSP; pointerLock adds only the sandbox token. The iframe stays opaque, without `allow-same-origin`. Trusted `prepare({worker:true})` is only a parser option, independent of work permissions; preparation never executes uploaded code.

Only `clipboardRead` plus a `SandboxClipboardAdapter` exposes `game.clipboardReadText({})`. The adapter's `readText(signal: AbortSignal): Promise<string>` uses existing plugin/Host RPC strict input/output checks and sanitized errors: empty object input, 8 KiB UTF-8 output, concurrency 1, 30s timeout, cancellation and discarded late results after stop. Native iframe clipboard access stays denied.

Optional string-only `window.game.storageGet/Set/Delete` use the existing host-plugin/RPC validation and a scope-bound host adapter. Limits match MOSS: 2000 files, 512 UTF-8 path bytes, 25 MiB/file and 100 MiB/package. `SANDBOX_RUNTIME_VERSION` equals the package version. The standalone `package.runtime.js` export is a self-contained trusted ESM browser bundle; `npm run prepare` builds dist without Git metadata, including for pinned-commit Git dependencies.

The offline runtime accepts `data:` in passive image, font and media positions. If the opaque frame denies native Web Storage, initial scripts get in-memory `localStorage` and `sessionStorage`. The optional host adapter preloads and saves `localStorage` through `window.game`; `sessionStorage` is scoped to a playback session.

**Native-browser offline restrictions are best-effort, not zero-network isolation.** CSP blocks tested common fetch/WebSocket/remote resource exits; WebRTC/STUN and self-navigation are not strongly guaranteed. There is no arbitrary-URL network proxy. Resource acceptance grants no capabilities; dedicated Workers, WASM and eval/Function now require explicit grants. Dynamic code strings are not rewritten. XHR/SharedWorker/importScripts remain unsupported. The Worker wrapper's 32-direct-Worker guard is compatibility/cleanup, not a hard Worker/CPU/memory quota. Game code may still interpret bytes or create its own Blobs within that policy: fetch-only describes SDK automation, not a security boundary. See the [complete API, support matrix, limits and threat model](./docs/offline-package.en.md).

## Existing cross-origin runtime

The trusted host creates an iframe with a stable, cross-origin game origin and starts a `SandboxHostSession`. Each untrusted game should use its own origin when storage or same-origin resource isolation matters. The platform preloads `dist/game.preload.js` before all game-controlled markup, exposing explicitly configured `window.game.xxx(payload, { signal, timeoutMs })` methods. Content installs no sandbox package and performs no handshake. The internal MessageChannel client retains exact host-origin checks; the host validates source, origin, strict Zod schemas, capabilities, payload size, rate limits, and lifecycle.

## CI

This repository runs its own Node, package, Vue fixture and Chromium checks. Tagged releases use the standalone publish workflow. MOSS pins a commit from this repository as a Git submodule and builds it as a local file dependency for the API and player.

- The public package surface is the ESM root host API plus trusted `game.preload.js` and `package.runtime.js` platform assets, not a content SDK. There is no Vue peer dependency.

## Documentation

- [Offline package runtime: API, support matrix and boundaries](./docs/offline-package.en.md)
- [离线作品包运行时：接口、支持矩阵与边界](./docs/offline-package.zh-CN.md)
- [English usage guide](./docs/usage.en.md)
- [简体中文使用手册](./docs/usage.zh-CN.md)
- The trusted game-resource server must insert the synchronous classic tag generated by `renderSandboxGamePreloadScript` into a controlled `<head>` before all game-controlled markup, and serve `dist/game.preload.js` from an exact reserved same-origin route on the resource allowlist. See the usage guides for complete platform integration and SDK-free HTML/Vue examples.
- Game resource servers can use `createSandboxGamePackagePolicy` to require `/index.html` and reject undeclared or traversal paths; the host also terminates a session after a post-load iframe navigation.
- [ADR 0001: MessageChannel host bridge](./docs/adr/0001-message-channel-host-bridge.md)
- [English plugin specification](./docs/plugin-spec.en.md)
- [插件规范（简体中文）](./docs/plugin-spec.zh-CN.md)
- [ADR 0002: Trusted host plugin seam](./docs/adr/0002-host-trusted-plugin-seam.md)
- [ADR 0003: Platform-preloaded game API](./docs/adr/0003-platform-preloaded-game-api.md)

## Breaking migration

Plugin methods may declare a top-level `defaultTimeoutMs` in `defineMethod` / `SandboxMethodContract`. Omission or `undefined` defaults to `5000ms`; explicitly supplied values must be finite positive numbers. Calls remain `window.game.xxx(payload, { signal, timeoutMs })`: per-call `options.timeoutMs` overrides the resolved method default, including with a longer timeout; both cover handshake waiting. `handshakeTimeoutMs` remains independent, as does the optional host-side `limits.timeoutMs` hard cap, which content cannot override. Cancellation is unchanged.

Plugin declarations remain `gameApi: { echo: "echo" }`, but `composeHostPlugins().gameApi` now maps aliases to frozen bindings, e.g. `{ echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 } }`, rather than strings. Keep passing `methods: extensions.gameApi` to `renderSandboxGamePreloadScript`; migrate manually authored bindings to this object shape. `SandboxGamePreloadConfig` no longer accepts a shared `defaultTimeoutMs`. The plugin composer fills omitted method defaults with `5000ms`, so its output always includes a finite positive value; manually authored preload bindings must also include it.

The content SDK, including Vue support, is retired: `/game`, `/vue`, `game.global.js`, and the root content-side bridge/SDK exports are removed, not deprecated compatibility paths. Remove sandbox-package imports, SDK script tags and manual connection setup from content; call the platform-preloaded `window.game` instead. See the [migration details](./docs/usage.en.md#43-breaking-migration). Release checks must reject these retired exports and their compiled SDK artifacts, including stale files left by earlier builds.
