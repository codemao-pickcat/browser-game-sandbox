# Offline package runtime (0.5.3)

[简体中文](./offline-package.zh-CN.md)

The trusted host supplies a manifest and file bytes instead of serving each game's resources over HTTP. The SDK verifies them and creates supported resource Blobs inside a unique opaque iframe. Content uses the platform-provided `window.game`; it installs no SDK.

**Native-browser offline restrictions are best-effort, not zero-network isolation.** CSP and iframe sandbox provide browser defenses, not an OS/container boundary. WebRTC/STUN and self-navigation are not absolutely blocked. There is no arbitrary-URL host proxy, and package fetch is a compatibility layer, not a security boundary.

## API and preparation

```ts
import {
  SANDBOX_RUNTIME_VERSION, // "0.5.3", equal to package.json
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
  permissions, // Explicit grants AFTER trusted-player consent; default [].
  clipboard, // Optional SandboxClipboardAdapter; also requires clipboardRead.
  storage, // Optional adapter bound to a fixed game/viewer scope by the host.
  onTerminate(reason) { /* Release host state; do not insert raw reasons into HTML. */ },
});
await session.connected; // Authenticated bootstrap/RPC, not content readiness.
await session.ready;     // Bytes reverified, resources loaded, initial modules evaluated (including TLA).
// Use session.iframe for layout; do not change sandbox/src/srcdoc/allow.
session.terminate("player closed");
```

Preparation works in Node.js 24+ and browsers using parse5, css-tree and Acorn, without DOM access, user-code execution or network I/O. It validates the root entry, exact file set, paths, sizes, SHA-256 and existing parser constraints, then snapshots caller bytes. A prepared handle is immutable and local to its JS realm, not a serializable compiled plan. After server preparation, the player downloads the same package and prepares it again.

`worker: true` moves parsing to an SDK-owned Blob Worker. Native asynchronous SHA-256 remains in the calling realm because opaque Blob Workers do not always expose SubtleCrypto. The trusted host CSP must permit `worker-src blob:`. Caller buffers are never detached. Aborting `signal` terminates that worker and revokes its URL. This is a trusted-player parsing option, NOT a grant to uploaded content. Child revalidation runs the pure parser on its own thread without creating a Worker, even when the work's worker permission is absent. Game initialization/rendering still runs in the browser without hard CPU/memory isolation.

The host must have an HTTP(S) Origin (HTTPS in production). Bundlers may use the root package entry. A trusted player without a bundler can serve the self-contained ESM export `@codemao-pickcat/browser-game-sandbox/package.runtime.js`, which embeds the trusted bootstrap. Never substitute uploaded code for this runtime. The older `game.preload.js` HTTP-resource integration is not needed for offline packages.

MOSS supplies a `formatVersion: 2` manifest for deployments with npm dependencies. `moduleAliases` maps `npm:<name>@<exact-version-or-latest>` to verified `__moss_npm__/<sha256>.mjs` files in the manifest. The host must provide those bytes. Aliases targeting the same file share a module instance. Work-owned Workers cannot use npm aliases. Local-only packages can keep using v1.

## Explicit work permissions

```ts
type SandboxPackagePermission = "worker" | "wasm" | "pointerLock" | "eval" | "clipboardRead";
// Frozen tuple in this exact order:
SANDBOX_PACKAGE_PERMISSIONS; // ["worker", "wasm", "pointerLock", "eval", "clipboardRead"]
declare function normalizeSandboxPackagePermissions(input: unknown): SandboxPackagePermission[];
// Session additions:
// permissions?: readonly SandboxPackagePermission[]
// clipboard?: SandboxClipboardAdapter
```

`normalizeSandboxPackagePermissions` rejects non-arrays (including undefined/null), sparse arrays and unknown/non-string entries with TypeError; returns a fresh deduplicated array in canonical order; never mutates input. `eval` necessarily includes `wasm` because CSP `unsafe-eval` also enables WASM. Session omission/undefined alone defaults to `[]`; invalid explicit values fail closed before creating an iframe. Permissions are not added to the manifest or inferred during preparation.

**The trusted MOSS player must complete authorization/consent before calling `createSandboxPackageSession`.** Session creation starts execution, not a permission prompt; the SDK cannot validate a viewer's consent. Never create a temporary/default-powered session while awaiting a decision. Changing grants requires terminating the old session and creating a new one.

`buildOfflineBrowserPolicy(permissions = [])` validates/normalizes the same input and stays opaque: always `allow-scripts`, never `allow-same-origin`. `worker` switches `worker-src 'none'` to `worker-src blob:`; `wasm` adds `wasm-unsafe-eval` to script-src; `eval` adds `unsafe-eval` (and WASM); `pointerLock` alone adds `allow-pointer-lock`. No grant enables network access. Do not substitute the general `buildBrowserPolicy`, whose cross-origin profile includes `allow-same-origin`.

Direct eval/new Function are parsed but no longer statically denied. CSP checks the actual execution site, including Worker inheritance; without their grant the browser rejects them. Dynamic code strings are opaque: their resource/import/Worker references are not transparently rewritten or validated as package references. XHR, SharedWorker, importScripts and existing unsupported-format checks remain unsupported; static checks are compatibility policy, not an unbypassable API blacklist. Worker wrapping provides compatibility and cleanup, not a hard count/CPU/memory quota.

### Clipboard via Host RPC only

```ts
interface SandboxClipboardAdapter {
  readText(signal: AbortSignal): Promise<string>;
}
// Only when clipboardRead AND an adapter are present:
const text: string = await window.game.clipboardReadText({});
// Existing optional RPC cancellation remains available:
// game.clipboardReadText({}, { signal, timeoutMs })
```

The input schema is a strict empty object; missing/null/array/extra fields fail. Output is a string of at most **8192 UTF-8 bytes**, not characters. Existing host-plugin/Host RPC validation, capability checks, cancellation and sanitized errors apply. Only one read is admitted (concurrent attempts fail, not queue); host and default client timeout are 30 seconds. A per-call timeout cannot extend the host cap. The adapter is bound at session creation and receives its request AbortSignal. Stop/cancel/timeout abort it and discard late text. Even an adapter ignoring abort retains its read slot until it settles, preventing overlapping underlying reads; the SDK cannot undo a native read already started. The host/player owns browser clipboard permission and user-gesture handling. No generic native `navigator.clipboard` fallback or iframe clipboard grant is supplied: iframe `allow` still denies clipboard-read/write and the browser policy keeps both features disabled.

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

“Read-only data” describes SDK automation, **not what content can interpret**. Content may decode bytes, create its own Blobs or pass WebAssembly bytes to compile/instantiate within the existing policy. Dedicated Workers, WebAssembly and eval/Function are available only with the explicit grants above, and are disabled by default. Accepting data grants no new executor, navigation, download, network or host-call permissions.

## Compatibility matrix

| Pattern | Behavior |
| --- | --- |
| Root HTML and ordinary layout/form controls | Only `index.html` is compiled as a document; controls work, form submission does not |
| Secondary HTML | GET/HEAD returns exact bytes and `text/html`; scripts/meta/URLs inside templates stay passive |
| Classic script src / inline script | Executed in document order after DOM installation; async/defer normalized to sequential execution |
| External/inline modules | Static imports/exports, ESM cycles and top-level await supported |
| Literal dynamic import | Accepts string literals and template literals without substitutions for local `.js/.mjs`; computed/bare/external imports, attributes/JSON modules and module query/hash variants are rejected. Static `import`/`export … from` still requires a string literal under JavaScript grammar |
| `new URL(path, import.meta.url)` | Resolves known non-HTML resources, including computed path strings, from the calling module's package directory. Inline document modules use root `index.html`. Worker graphs and static Worker entry references use literals |
| `new URL(path)`, `new URL(path, document.baseURI)` | The work document resolves path strings from root `index.html`. Package Blob URLs drop the query and keep the fragment. `URL.parse` and `URL.canParse` use the same resolution when supported. Use package-relative `fetch(path)` for HTML and fallback data |
| Stylesheet link / style / style attributes | CSS parsed and rewritten, including url/import/image-set; CSS string serialization preserves escaping and fragments such as `#svgView(viewBox(...))`; Blob dependency cycles rejected |
| Images/fonts/audio/video | Known non-HTML resource references supported; fallback references rejected. `srcset`/`imagesrcset` URLs and descriptors (`1.5x`, `100w`) are handled separately; `background` takes one URL. Local resources become Blob URLs, inline `data:` is retained, and external URLs fail with `EXTERNAL_URL`. `imagesrcset` is dropped on kept stylesheet links. Valid bytes do not guarantee browser codec support |
| `new Audio("./audio/loop.mp3")` | `Audio` resolves package path strings, including computed strings, from the root `index.html` and uses child-frame Blob URLs for known media, preserving media fragments. For dynamic `audio.src` assignments, use a literal `new URL("./loop.mp3", import.meta.url).href` or create a Blob URL. Call `play()` from a real click or tap inside the work |
| Inline `data:` URLs | Allowed unchanged in passive resource positions (`src`/`srcset`/`poster`/`background`, CSS `url()`/`image-set()` and literal `new URL`). They are not decoded into package files. CSP allows `data:` in `img-src`/`font-src`/`media-src`; SVG used as an image does not execute scripts. Scripts, modules, Workers, stylesheets (including `@import`) and direct `fetch()` reject `data:` with `INLINE_RESOURCE`; navigation links still reject it |
| SVG | Self-contained, with no scripts, animation or external URLs. CSS declarations in `style` attributes follow the same validation as presentation attributes: only approved properties may use same-document `url(#id)`; unparsed CSS and active schemes are rejected. `<style>`, `foreignObject`, `image` and `use` remain unsupported |
| Static query/fragment | Lookup uses the package path; query is dropped from Blob URLs, full fragment retained. Queries create no independent cache/version; ESM query/hash remains unsupported |
| Package-relative fetch | GET/HEAD from the complete verified file set, including fallback data; exact raw bytes, MIME and Content-Length; HEAD has no body. Relative paths always start at root index.html, not the calling script |
| Fetch of a rewritten known Blob URL | Returns the corresponding original file bytes, including JSON/TXT/BIN; missing own paths, external URLs and non-GET/HEAD methods fail with TypeError, without network fallback |
| Fetch of a Blob URL created by the work document | GET/HEAD can read a live Blob registered by `URL.createObjectURL` in the work document. Fragments are accepted, and queries follow native Blob URL lookup semantics |
| Fragment anchors, `a[href]`/`area[href]` | Supported; non-fragment `a`/`area` `href` values are kept without rewriting or validation, because the runtime `onLinkClick` in `package-loader.ts` already calls `preventDefault` in the capture phase for every `a[href]`/`area[href]` click and only handles `#fragment`; `javascript:`/`data:`/`vbscript:` remain rejected |
| Dedicated Workers (requires worker) | Child-created Blob Workers and literal `.js/.mjs` paths, including `new Worker(new URL("./worker.js", import.meta.url), options)`, supported with messaging/transferables/classic/module options |
| Worker module graph | Local static/literal-dynamic imports become direct Blob edges; cycles rejected. A classic bootstrap imports modules and queues messages until initialization (replayed MessageEvents are synthetic) |
| Worker compatibility guard | Wrapper rejects its 33rd live direct Worker; terminate releases a slot, session teardown closes tracked Workers. Bypassable through nested workers/other realms; **not** a security quota or hard Worker/CPU/memory limit |
| Worker environment | No `window.game`, package fetch layer or Web Storage fallback in Workers; `importScripts` is unsupported. Dynamic Blob source must be self-contained; document import maps do not apply in Workers. CSP permits only Blob Workers with inherited external-connection restrictions |
| eval / Function / WASM | Accepted in prepare without execution; actual execution requires eval / wasm (eval implies wasm); dynamic-code strings are not rewritten |
| Shared/Service Workers, XHR, importScripts | Remain unsupported; directly identifiable SharedWorker/XHR/importScripts constructions/calls rejected in prepare, CSP/opaque Origin add browser defenses, not a security claim based on deleting globals |
| External URL and CDN dependencies | Statically identifiable references rejected; bundle them locally instead |
| HTML template as script/module/stylesheet/iframe | Rejected: passive HTML data is not executable JS/CSS and is not an extra entrypoint. As an `a`/`area` link target it is accepted without rewriting or validation; the runtime `onLinkClick` cancels the click, so the template is never loaded |
| Dynamic DOM src/href/style or computed loading | Not transparently rewritten; use supported static references/literal URLs. Native relative URLs cannot automatically read package files |
| iframe/frame/frameset/object/embed/applet/portal/base, `meta http-equiv="refresh"` | Rejected (`UNSUPPORTED_HTML_ELEMENT`); no extra document or runtime-bootstrap compatibility fallback |
| Other `meta http-equiv="..."` | The whole `meta` element is dropped: a Blob/srcdoc document has no HTTP response header for those directives to override |
| SRI and other inert attributes, `nomodule` | `integrity/ping/manifest/codebase/archive/srcdoc` are deleted on any element; a classic `<script nomodule>` element is removed from the document entirely, its `src` is not rewritten, materialized or parsed as a module (only its bytes remain for package fetch), and its inline code is dropped. `nomodule` has no meaning on module scripts, so a `type="module" nomodule` script keeps running and only the attribute is removed |
| Form submission (`action`/`formaction`) | Rejected (`UNSUPPORTED_HTML_FORM`); layout and controls still work |
| `link rel=icon/preload/prefetch/modulepreload/manifest`, `preconnect/dns-prefetch` | Removed at compile time without validating or rewriting the href, so a `data:,` favicon, missing file or external URL does not block preparation |
| Combined `rel` token lists (e.g. `rel="stylesheet preload"`) | Tokens are case-insensitive and order-independent. A combination with `stylesheet` keeps only that token and still validates the href as a stylesheet. Unknown tokens such as `shortcut` remain rejected (`UNSUPPORTED_HTML_LINK`) |

JS files are validated with modern module syntax; classic references cannot depend on sloppy-only syntax such as `with`. Inline handlers are also parsed and cannot depend on top-level `return`. `document.write`, parser-stream timing, module `document.currentScript`, original HTTP paths/import.meta.url, XHR and arbitrary dynamic loading are not transparently compatible. The runtime replays DOMContentLoaded/load once after initial scripts finish. Later application tasks, playback and custom app readiness are outside `session.ready`.

Preparation errors expose `SandboxPackageError.code`: `INVALID_MANIFEST/INVALID_PATH/INTEGRITY/PACKAGE_TOO_LARGE/INVALID_ENCODING/UNSUPPORTED_REFERENCE`, missing resources, CSS/JS/module restrictions and Blob cycles. Rejected HTML is split into `UNSUPPORTED_HTML_ELEMENT` (base/iframe/frame/frameset/object/embed/applet/portal, `meta http-equiv="refresh"`, `javascript:`/`data:`/`vbscript:` `a`/`area` href), `UNSUPPORTED_HTML_SCRIPT` (unsupported script type, JSON script block with `src`), `UNSUPPORTED_HTML_LINK` (unsupported `rel` token, `href` without `rel`) and `UNSUPPORTED_HTML_FORM` (`action`/`formaction`); messages name the file or pattern. Unsupported runtime operations fail through TypeError, module rejection, resource error or CSP. Successful preparation does not guarantee all game code works; failed initialization rejects ready and destroys the session rather than reporting fake readiness.

### Known incompatibilities

- **Configuration in resource queries.** `player.js?g=work.love` loads the package file `player.js`. The Blob URL preserves the fragment only, so scripts cannot read `g` from it. Configure the script in the package or read a configuration file with a package-relative fetch.
- **Scripts and stylesheet links inserted at runtime.** Their URLs are not rewritten. Use static tags in the entry document or supported literal imports.
- **Vite chunk output with computed preload URLs.** The SDK cannot resolve `new URL(dep, import.meta.url)` in `__vitePreload` at prepare time. For a single entry, disable [`build.modulePreload`](https://vite.dev/config/build-options.html#build-modulepreload) and inline the chunks with [`build.rollupOptions.output.inlineDynamicImports: true`](https://rollupjs.org/configuration-options/#output-inlinedynamicimports) on Rollup-based Vite, or [`build.rolldownOptions.output.codeSplitting: false`](https://vite.dev/guide/build.html#chunking-strategy) on Rolldown-based Vite. Top-level await is supported, but an unresolved await causes initial loading to time out.
- **XHR-based i18n backends.** The SDK rejects recognizable `XMLHttpRequest` use even in dead code. Use inline language resources or package-relative fetch.

## Budgets and paths

Node preparation, browser preparation and child admission share `SANDBOX_PACKAGE_LIMITS`:

- 2000 files; 512 UTF-8 bytes/path; 25 MiB/file and 50 MiB total original bytes.
- Parser text limit 25 MiB; compiled plan limit 100 MiB. Fallback bytes stay outside the Blob plan, not outside integrity/transport budgets.
- Duplicate-SHA logical paths may share input buffers, but each path is charged separately. SDK transfer never detaches caller buffers.
- Dedicated package channel, 256 KiB chunks with individual acknowledgments, 30s load timeout. Ordinary RPC remains 64 KiB, 30 requests/s with its existing concurrency/cancellation/request-ID checks; initial handshake timeout remains 5s.
- Canonical relative paths only: no empty/dot/dot-dot segments, leading slash, backslash, controls, whitespace, `% : ? #` in manifest paths.
- References may use in-root `./`, `../` and package-root `/`. Segments are decoded and traversal depth checked before URL normalization: encoded parent steps cannot escape and clamp back onto root. Unicode encoding is supported; encoded separators, double/invalid encoding are rejected. Query/hash do not alter path depth or bytes; manifest/SHA controls byte versions.

## Storage

When opaque-origin access to native Web Storage throws `SecurityError`, the SDK installs in-memory `localStorage` and `sessionStorage` before initial scripts run. They support `getItem`, `setItem`, `removeItem`, `clear`, `key` and `length` with string keys and values. Property-style access, Worker access and native IndexedDB in the work frame are outside this compatibility layer.

MOSS preloads persisted `localStorage` through `window.game.storageLocalLoad({})`. Synchronous methods update memory immediately and the SDK batches changes through `window.game.storageLocalApply`. The host applies each batch to the latest IndexedDB save in one transaction. Changes to distinct keys from different sessions merge, and the last committed change wins for a shared key. `sessionStorage` starts empty each time. Without a sync adapter or after a failed preload, `localStorage` stays in memory for the session. Write failures log a warning and closing the player can discard writes that have yet to commit. Use `window.game.storageSet/Delete` when the work needs an awaited persistence acknowledgement. Those methods use a separate key space.

Both in-memory stores share a cumulative 1 MiB UTF-8 write limit counting keys and values. Synced `localStorage` holds at most 128 entries and 48 KiB including bridge accounting. Local quota violations throw `QuotaExceededError`.

### Optional scope-bound storage

```ts
interface SandboxStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  readonly localStorage?: {
    load(): Promise<[string, string][]>;
    update(
      apply: (entries: [string, string][]) => [string, string][],
      signal: AbortSignal,
    ): Promise<void>;
  };
}
```

Content calls `game.storageSet({key:"save", value:JSON.stringify(state)})`, `game.storageGet({key:"save"})` and `game.storageDelete({key:"save"})`. Without an adapter these aliases are absent. The existing host-plugin/RPC schema/capability checks remain authoritative; content cannot supply namespace/game/viewer IDs or arbitrary JSON values.

Keys are nonempty, at most 128 UTF-8 bytes; values/get results at most 16 KiB. Per session: 1 MiB cumulative writes, 128 distinct write keys, read concurrency 4, set/delete concurrency 1 each, host execution cap 5s. Adapter errors are sanitized.

Adapter methods are bound when creating the session. Capture a fixed game/viewer scope, never a mutable current-user global. Persistent quotas/concurrency/authorization belong to the platform. Termination cancels RPC and drops late responses but cannot undo a write already accepted by an adapter without cancellation support.

## Isolation, revalidation and lifecycle

The offline iframe uses `allow-scripts` plus `allow-pointer-lock` only when granted, always without `allow-same-origin`. Bootstrap authenticates the exact contentWindow, null Origin, 256-bit one-time token and one initial port. The child checks the actual parent and exact trusted host Origin. Package transfer and the existing Host RPC use distinct MessagePorts. Game scripts run only after authentication, all byte verification, known-resource Blob creation and import-map installation.

Host preparation and child admission share pure manifest validation (version/root/path/count/SHA format/sizes), but the child independently hashes and recompiles received bytes. Own-key file access allows existing prototype-named files and rejects missing `constructor`/`toString`/`__proto__` instead of reading inherited object values.

After ready the package port closes. Termination closes ports, cancels Host requests, removes listeners/iframe, rejects outstanding connected/ready and releases transfer buffers. Child pagehide/load failure terminates direct Workers and revokes created Blob URLs. A caller retaining a prepared handle retains its verified bytes until releasing that handle.

`buildOfflineBrowserPolicy(permissions)` reports best-effort enforcement and warnings, not zero-network enforcement. Common remote fetch/WebSocket/resource exits are tested against a real local receiver; WebRTC/STUN may still send packets. Post-bootstrap iframe loads trigger reactive termination, but an initial self-navigation request may already have happened, and 204 responses need not trigger load. CPU/memory starvation, browser vulnerabilities and authorization side channels are not hard-isolated. Use a separate network-isolated environment for strict zero-network requirements.

## Build and validation

`npm run prepare` only builds, including pinned Git dependency installation without Git metadata. It does not commit, merge or publish. Platforms should pin immutable dependency commits and keep the server/player/runtime versions aligned; never edit installed dependencies or runtime versions on existing deployments to bypass checks.

```bash
npm ci
npm run check
npm run test:browser
# Windows with an installed Edge:
npx playwright test -c test/browser-edge.config.mjs test/browser/package-session.spec.mjs
```

The suite uses real browsers and local HTTP/UDP receivers, not request interception to pretend isolation. It covers fallback GET/HEAD bytes/MIME/length, no automatic fallback Blobs, reference rejection, Node/browser/preparation-worker/child agreement, prototype paths, manifest/hash/budgets, opaque Origin/authentication, module cycles/TLA, all 32 permission combinations in document/Workers (including eval→wasm and default denial), actual pointer lock requests/tokens, clipboard grant/adapter gates and RPC limits/cancel/stop, dedicated Workers/WASM, storage scopes, abort/teardown and initialization failure. These tests are not proof of denial for all exits in all browsers.
