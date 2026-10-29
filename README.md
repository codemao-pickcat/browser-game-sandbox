# Browser Game Sandbox

Bare browser sandbox runtime for untrusted web games.

The runtime bridge uses a transferred `MessageChannel`. `window.postMessage` is used only for the initial handshake; all subsequent calls use the dedicated port.

This package contains no platform business API, credentials, network proxy, account model, room model, or cloud storage implementation.

## Build and test

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

The trusted host creates an iframe with a stable game origin and starts a `SandboxHostSession`. The game-side client calls `acceptSandboxBridge` with the expected host origin. The host remains the security authority: it validates source, origin, strict Zod schemas, capabilities, payload size, rate limits, and lifecycle.

## Documentation

- [English usage guide](./docs/usage.en.md)
- [简体中文使用手册](./docs/usage.zh-CN.md)
- [ADR 0001: MessageChannel host bridge](./docs/adr/0001-message-channel-host-bridge.md)
- [English plugin specification](./docs/plugin-spec.en.md)
- [插件规范（简体中文）](./docs/plugin-spec.zh-CN.md)
- [ADR 0002: Trusted host plugin seam](./docs/adr/0002-host-trusted-plugin-seam.md)
