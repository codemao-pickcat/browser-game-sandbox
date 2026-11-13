# Offline package runtime (0.3.3)

[简体中文](./offline-package.zh-CN.md)

The trusted host supplies a manifest and file bytes instead of serving each game's resources over HTTP. The SDK verifies them and creates supported resource Blobs inside a unique opaque iframe. Content uses the platform-provided `window.game`; it installs no SDK.

**Native-browser offline restrictions are best-effort, not zero-network isolation.** CSP and iframe sandbox provide browser defenses, not an OS/container boundary. WebRTC/STUN and self-navigation are not absolutely blocked. There is no arbitrary-URL host proxy, and package fetch is a compatibility layer, not a security boundary.

## API and preparation

```ts
import {
  SANDBOX_RUNTIME_VERSION, // "0.3.3", equal to package.json
  prepareSandboxPackage,
  createSandboxPackageSession,
  type SandboxPackageInput,
} from "@codemao-pickcat/browser-game-sandbox";

// input.manifest = {
//   formatVersion: 1, entrypoint: "index.html",
//   files: { "index.html": { sha256: "64 lowercase hex digits", size: 123 }, ... }
// }
// input.files = { "index.html": Uint8Array, ... }
const controller = new AbortController();
const prepared = await prepareSandboxPackage(input satisfies SandboxPackageInput, {
  worker: true, // Recommended for browser previews; omit options in Node.
  signal: controller.signal,
});
const session = createSandboxPackageSession({
  container,
  package: prepared,
  storage, // Optional adapter bound to a fixed game/viewer scope by the host.
  onTerminate(reason) { /* Release host state; do not insert raw reasons into HTML. */ },
});
await session.connected; // Authenticated bootstrap/RPC, not content readiness.
await session.ready;     // Bytes reverified, resources loaded, initial modules evaluated (including TLA).
// Use session.iframe for layout; do not change sandbox/src/srcdoc/allow.
session.terminate("player closed");
```

Preparation works in Node.js 24+ and browsers using parse5, css-tree and Acorn, without DOM access, user-code execution or network I/O. It validates the root entry, exact file set, paths, sizes, SHA-256 and existing parser constraints, then snapshots caller bytes. A prepared handle is immutable and local to its JS realm, not a serializable compiled plan. After server preparation, the player downloads the same package and prepares it again.

`worker: true` moves parsing to an SDK-owned Blob Worker. Native asynchronous SHA-256 remains in the calling realm because opaque Blob Workers do not always expose SubtleCrypto. The trusted host CSP must permit `worker-src blob:`. Caller buffers are never detached. Aborting `signal` terminates that worker and revokes its URL. Child revalidation also uses a preparation worker; game initialization/rendering still runs in the browser without hard CPU/memory isolation.

The host must have an HTTP(S) Origin (HTTPS in production). Bundlers may use the root package entry. A trusted player without a bundler can serve the self-contained ESM export `@codemao-pickcat/browser-game-sandbox/package.runtime.js`, which embeds the trusted bootstrap. Never substitute uploaded code for this runtime. The older `game.preload.js` HTTP-resource integration is not needed for offline packages.

## File recognition and raw data

Known extensions and MIME types retain their previous behavior:

```text
html css js mjs json txt csv xml png jpg jpeg gif webp avif ico svg
woff woff2 ttf otf mp3 ogg wav m4a mp4 webm bin
```

Recognition is case-insensitive and uses only the last actual dot in the final filename segment, not dots in directories. Extensionless names such as `js` and `json` are raw data, not JavaScript or JSON. Lookups use own keys: `constructor`, `toString`, `__proto__` and similar paths cannot alias inherited formats.

Unknown extensions and extensionless files are accepted as **fallback raw data**. Examples include `.glb`, `.gltf`, `.data`, `.wasm`, `.exe`, `.zip` and `.htm`. They retain exact verified bytes, count against all existing budgets and use `application/octet-stream` for package GET/HEAD. They **never receive SDK-created Blob URLs** and cannot be automatic targets for:

- script/module imports or stylesheet loading;
- HTML resource attributes;
- CSS `url()` or either URL/string form of `image-set()`;
- literal `new URL(..., import.meta.url)` rewriting;
- Worker script generation.

Those uses fail with `UNSUPPORTED_REFERENCE`, not an upload-extension error. Read fallback bytes with `fetch("model.glb")`, not a literal `new URL` wrapper. Known JSON/TXT/CSV/XML/BIN keep their existing Blob/resource/literal-URL compatibility: `.bin` sharing the fallback MIME does **not** make fallback data eligible for Blob materialization. No MIME, class, capability or policy fields are added to the manifest.

Only root `index.html` is an executable document. Secondary `.html` files remain verified UTF-8 passive fetch data: no template parsing/rewriting, HTML Blob, DOM insertion, subdocument or navigation entry. Known HTML/JS/CSS/SVG validation errors never downgrade to raw data. ZIP extraction belongs to the platform; this API does not unpack ZIPs or recursively extract nested archives. A ZIP's `.htm` file is fallback data; a platform may still wrap a standalone uploaded HTM as root `index.html`.

“Read-only data” describes SDK automation, **not what content can interpret**. Content may decode bytes, create its own Blobs or pass WebAssembly bytes to compile/instantiate within the existing policy. Dedicated Workers and WebAssembly in the document/Workers remain supported exactly as before; `wasm-unsafe-eval` stays enabled and JavaScript eval/Function stays blocked. Accepting data grants no new executor, navigation, download, network or host-call permissions.

## Compatibility matrix

| Pattern | Behavior |
| --- | --- |
| Root HTML and ordinary layout/form controls | Only `index.html` is compiled as a document; controls work, form submission does not |
| Secondary HTML | GET/HEAD returns exact bytes and `text/html`; scripts/meta/URLs inside templates stay passive |
| Classic script src / inline script | Executed in document order after DOM installation; async/defer normalized to sequential execution |
| External/inline modules | Static imports/exports, ESM cycles and top-level await supported |
| Literal dynamic import | Supported for local `.js/.mjs`; computed/bare/external imports, attributes/JSON modules and module query/hash variants rejected |
| Literal `new URL("./asset", import.meta.url)` | Rewritten to child Blob URLs for known non-HTML resources, including existing JSON/TXT/BIN; dynamic arguments, HTML and fallback targets rejected |
| Stylesheet link / style / style attributes | CSS parsed and rewritten, including url/import/image-set; CSS string serialization preserves escaping and fragments such as `#svgView(viewBox(...))`; Blob dependency cycles rejected |
| Images/fonts/audio/video | Known non-HTML resource references supported; fallback references and HTML srcset/imagesrcset rejected; valid bytes do not guarantee browser codec support |
| SVG | Self-contained, no scripts/animation/external URLs or style/foreignObject/image/use embedding |
| Static query/fragment | Lookup uses the package path; query is dropped from Blob URLs, full fragment retained. Queries create no independent cache/version; ESM query/hash remains unsupported |
| Package-relative fetch | GET/HEAD from the complete verified file set, including fallback data; exact raw bytes, MIME and Content-Length; HEAD has no body. Relative paths always start at root index.html, not the calling script |
| Fetch of a rewritten known Blob URL | Returns the corresponding original file bytes, including JSON/TXT/BIN; missing own paths, external URLs and non-GET/HEAD methods fail with TypeError, without network fallback |
| Fragment anchors | Remain inside srcdoc; other static navigation rejected |
| Dedicated Workers | Child-created Blob Workers and literal `.js/.mjs` paths, including `new Worker(new URL("./worker.js", import.meta.url), options)`, supported with messaging/transferables/classic/module options |
| Worker module graph | Local static/literal-dynamic imports become direct Blob edges; cycles rejected. A classic bootstrap imports modules and queues messages until initialization (replayed MessageEvents are synthetic) |
| Worker limits | At most 32 live direct Workers; terminate releases a slot, session teardown closes Workers. No hard nested-worker/CPU/memory quota |
| Worker environment | No window.game or package fetch layer in Workers; importScripts unsupported; dynamic Blob source must be self-contained; document import maps do not apply in Workers. CSP permits only Blob Workers with inherited external-connection restrictions |
| Shared/Service Workers, XHR, eval/Function/importScripts | Unsupported direct constructions/calls rejected when statically identifiable; CSP/opaque Origin add browser defenses, not a security claim based on deleting globals |
| External/CDN/data URL dependencies | Statically identifiable references rejected; bundle them locally instead |
| Dynamic DOM src/href/style or computed loading | Not transparently rewritten; use supported static references/literal URLs. Native relative URLs cannot automatically read package files |
| iframe/object/embed/base/meta http-equiv, preload/prefetch, SRI/nomodule | Rejected; no extra document or runtime-bootstrap compatibility fallback |

JS files are validated with modern module syntax; classic references cannot depend on sloppy-only syntax such as `with`. Inline handlers are also parsed and cannot depend on top-level `return`. `document.write`, parser-stream timing, module `document.currentScript`, original HTTP paths/import.meta.url, XHR and arbitrary dynamic loading are not transparently compatible. The runtime replays DOMContentLoaded/load once after initial scripts finish. Later application tasks, playback and custom app readiness are outside `session.ready`.

Preparation errors distinguish invalid manifest/path/integrity/budgets/encoding, unsupported reference uses, missing resources, parser/module restrictions and Blob cycles. Unsupported runtime operations fail through TypeError, module rejection, resource error or CSP. Successful preparation does not guarantee all game code works; failed initialization rejects ready and destroys the session rather than reporting fake readiness.

## Budgets and paths

Node preparation, browser preparation and child admission share `SANDBOX_PACKAGE_LIMITS`:

- 2000 files; 512 UTF-8 bytes/path; 25 MiB/file and 50 MiB total original bytes.
- Parser text limit 25 MiB; compiled plan limit 100 MiB. Fallback bytes stay outside the Blob plan, not outside integrity/transport budgets.
- Duplicate-SHA logical paths may share input buffers, but each path is charged separately. SDK transfer never detaches caller buffers.
- Dedicated package channel, 256 KiB chunks with individual acknowledgments, 30s load timeout. Ordinary RPC remains 64 KiB, 30 requests/s with its existing concurrency/cancellation/request-ID checks; initial handshake timeout remains 5s.
- Canonical relative paths only: no empty/dot/dot-dot segments, leading slash, backslash, controls, whitespace, `% : ? #` in manifest paths.
- References may use in-root `./`, `../` and package-root `/`. Segments are decoded and traversal depth checked before URL normalization: encoded parent steps cannot escape and clamp back onto root. Unicode encoding is supported; encoded separators, double/invalid encoding are rejected. Query/hash do not alter path depth or bytes; manifest/SHA controls byte versions.

## Optional scope-bound storage

```ts
interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Content calls `game.storageSet({key:"save", value:JSON.stringify(state)})`, `game.storageGet({key:"save"})` and `game.storageDelete({key:"save"})`. Without an adapter these aliases are absent. The existing host-plugin/RPC schema/capability checks remain authoritative; content cannot supply namespace/game/viewer IDs or arbitrary JSON values.

Keys are nonempty, at most 128 UTF-8 bytes; values/get results at most 16 KiB. Per session: 1 MiB cumulative writes, 128 distinct write keys, read concurrency 4, set/delete concurrency 1 each, host execution cap 5s. Adapter errors are sanitized.

Adapter methods are bound when creating the session. Capture a fixed game/viewer scope, never a mutable current-user global. Persistent quotas/concurrency/authorization belong to the platform. Termination cancels RPC and drops late responses but cannot undo a write already accepted by an adapter without cancellation support.

## Isolation, revalidation and lifecycle

The fixed offline iframe uses only `allow-scripts`, without `allow-same-origin`. Bootstrap authenticates the exact contentWindow, null Origin, 256-bit one-time token and one initial port. The child checks the actual parent and exact trusted host Origin. Package transfer and the existing Host RPC use distinct MessagePorts. Game scripts run only after authentication, all byte verification, known-resource Blob creation and import-map installation.

Host preparation and child admission share pure manifest validation (version/root/path/count/SHA format/sizes), but the child independently hashes and recompiles received bytes. Own-key file access allows existing prototype-named files and rejects missing `constructor`/`toString`/`__proto__` instead of reading inherited object values.

After ready the package port closes. Termination closes ports, cancels Host requests, removes listeners/iframe, rejects outstanding connected/ready and releases transfer buffers. Child pagehide/load failure terminates direct Workers and revokes created Blob URLs. A caller retaining a prepared handle retains its verified bytes until releasing that handle.

`buildOfflineBrowserPolicy()` reports best-effort enforcement and warnings, not zero-network enforcement. Common remote fetch/WebSocket/resource exits are tested against a real local receiver; WebRTC/STUN may still send packets. Post-bootstrap iframe loads trigger reactive termination, but an initial self-navigation request may already have happened, and 204 responses need not trigger load. CPU/memory starvation, browser vulnerabilities and authorization side channels are not hard-isolated. Use a separate network-isolated environment for strict zero-network requirements.

## Build and validation

`npm run prepare` only builds, including pinned Git dependency installation without Git metadata. It does not commit, merge or publish. Platforms should pin immutable dependency commits and keep the server/player/runtime versions aligned; never edit installed dependencies or runtime versions on existing deployments to bypass checks.

```bash
npm ci
npm run check
npm run test:browser
# Windows with an installed Edge:
npx playwright test -c test/browser-edge.config.mjs test/browser/package-session.spec.mjs
```

The suite uses real browsers and local HTTP/UDP receivers, not request interception to pretend isolation. It covers fallback GET/HEAD bytes/MIME/length, no automatic fallback Blobs, reference rejection, Node/browser/preparation-worker/child agreement, prototype paths, manifest/hash/budgets, opaque Origin/authentication, module cycles/TLA, dedicated Workers/WASM, storage scopes, abort/teardown and initialization failure. These tests are not proof of denial for all exits in all browsers.
