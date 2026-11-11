---
status: accepted
---

# Preload plugin-configured game methods inside the game origin

Content developers should call `window.game.xxx()` without shipping an SDK. Trusted plugins explicitly map flat game aliases to existing host methods; a self-contained, synchronous classic preload creates the facade before game code and invokes the existing MessageChannel bridge without changing protocol v1. Handlers, schemas and capabilities remain authoritative on the host; aliases are convenience, not authorization.

A cross-origin parent cannot assign the game's globals. Instead of weakening origin isolation, using srcdoc or rewriting arbitrary HTML strings, the platform's trusted resource renderer must insert the escaped external-script tag into its controlled head before all game-controlled markup and reserve an exact same-origin bundle route on the resource allowlist. This requires platform integration but preserves self-only script CSP and disabled network access.

We explicitly retire the entire content-facing SDK, including Vue integration, rather than maintain parallel connection modes. Only the root host API and the platform-served `game.preload.js` asset remain public; content neither installs the package nor initiates a connection. The internal MessageChannel client, protocol v1 and all host security checks remain unchanged. This breaking migration removes manual bridge setup, SDK wrappers and their published artifacts; existing content must move to native `window.game` calls. Maintaining one platform-owned connection avoids duplicate handshakes and keeps framework-specific dependencies out of the runtime package.
