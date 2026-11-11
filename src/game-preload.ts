import { installSandboxGameApi } from "./game-api.js";
import { parseSandboxGamePreloadConfig } from "./game-api-config.js";

// This entry is intentionally a classic, parser-blocking script. currentScript
// belongs to the trusted HTML renderer's tag, not a game-provided global.
const data = document.currentScript?.getAttribute("data-sandbox-config");
if (!data) throw new TypeError("Sandbox game preload requires data-sandbox-config");
installSandboxGameApi(parseSandboxGamePreloadConfig(JSON.parse(data)));
