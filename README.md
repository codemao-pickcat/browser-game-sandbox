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

## Runtime shape

The trusted host creates an iframe with a stable, cross-origin game origin and starts a `SandboxHostSession`. Each untrusted game should use its own origin when storage or same-origin resource isolation matters. The game-side client calls `acceptSandboxBridge` with the expected host origin. The host remains the security authority: it validates source, origin, strict Zod schemas, capabilities, payload size, rate limits, and lifecycle.

## CI and publishing

- Pushes and pull requests run Node checks, the Vue 3 consumer build, and Chromium sandbox tests.
- Tags matching `v*.*.*` run the full suite, synchronize `package.json` to the tag version, verify the HTML bundle, build an npm tarball, upload it as an artifact, and publish to the GitHub Packages npm registry.
- The package is ESM-first and tested through a Vue 3 + Vite consumer fixture.

## Documentation

- [English usage guide](./docs/usage.en.md)
- [简体中文使用手册](./docs/usage.zh-CN.md)
- Vue 3 integration is available from `@codemao-pickcat/browser-game-sandbox/vue` with `createSandboxVuePlugin`, `defineSandboxVueConfig`, and `useSandboxSdk`.
- Plain HTML games can use `@codemao-pickcat/browser-game-sandbox/game` or load the bundled `dist/game.global.js`, which exposes `window.CodemaoSandboxGame`.
- Game resource servers can use `createSandboxGamePackagePolicy` to require `/index.html` and reject undeclared or traversal paths; the host also terminates a session after a post-load iframe navigation.
- [ADR 0001: MessageChannel host bridge](./docs/adr/0001-message-channel-host-bridge.md)
- [English plugin specification](./docs/plugin-spec.en.md)
- [插件规范（简体中文）](./docs/plugin-spec.zh-CN.md)
- [ADR 0002: Trusted host plugin seam](./docs/adr/0002-host-trusted-plugin-seam.md)
