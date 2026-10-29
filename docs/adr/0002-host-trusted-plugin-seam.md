---
status: accepted
---

# Keep plugins on the trusted host side

Plugin extensions are registered and executed by the trusted sandbox host, not dynamically installed by game code. A plugin contributes namespaced, schema-validated methods and host-to-game events; the host independently grants capabilities, applies limits, sanitizes errors, and controls lifecycle. This keeps the bare sandbox protocol small and prevents a plugin manifest or game payload from becoming a privilege grant.

The current `SandboxHostSession.methods` option is the low-level seam for this contract. A future registry may compose multiple plugins into that option, but v1 does not load or hot-swap untrusted plugins. External calls, when needed, must be implemented behind a reviewed host-side adapter with fixed origin and resource policies rather than exposed as arbitrary game-controlled network access.
