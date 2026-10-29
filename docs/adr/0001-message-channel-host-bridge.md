---
status: accepted
---

# Use a MessageChannel host bridge for sandbox calls

The bare sandbox communicates with its trusted host through a transferred `MessageChannel`: `window.postMessage` is used only for the initial handshake, after which requests, responses, events, cancellation, and termination use the dedicated port. The sandbox core exposes only a versioned, schema-validated transport and lifecycle capabilities; it does not define platform business APIs, expose credentials, or provide a generic network proxy.

The host is the security authority: it verifies the iframe source and exact origin during the handshake, validates every message and capability, enforces payload/rate/time limits, and can terminate the iframe. The TypeScript client package is only a typed convenience wrapper; it is not a security boundary.

This preserves cross-origin isolation, keeps the runtime dependency-free, supports transferable browser data, and leaves future host integrations outside the bare sandbox protocol.
