import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { z } from "zod";
import {
  buildBrowserPolicy, composeHostPlugins, createHostPlugin,
  createSandboxGamePackagePolicy, defineMethod, defineSandboxPlugin,
  renderSandboxGamePreloadScript,
} from "../../dist/index.js";

const root = resolve(import.meta.dirname, "../..");
const preloadPath = "/__sandbox/game.preload.js";
let hostServer, gameServer, hostOrigin, gameOrigin;

// Same trusted registry feeds the HTML preload configuration and the host.
// Only public method bindings/defaults cross into the game, never handlers or Zod objects.
function registry() {
  const method = (extra = {}) => defineMethod({
    input: z.object({ value: z.string() }), output: z.object({ value: z.string() }), ...extra,
  });
  const contract = defineSandboxPlugin({
    id: "com.example.native", version: "1.0.0",
    methods: {
      echo: method({ capability: "test.echo" }),
      denied: method({ capability: "test.denied" }),
      invalidOutput: method(), crash: method(),
      slow: method({ limits: { maxConcurrent: 1 } }),
      timed: method({ defaultTimeoutMs: 30 }),
      capped: method({ defaultTimeoutMs: 5000, limits: { timeoutMs: 30 } }),
    },
    gameApi: { echo: "echo", denied: "denied", invalidOutput: "invalidOutput", crash: "crash", slow: "slow", timed: "timed", capped: "capped" },
  });
  return composeHostPlugins([createHostPlugin(contract, {
    echo: (input) => { window.echoCalls = (window.echoCalls ?? 0) + 1; return input; },
    denied: (input) => { window.deniedCalls = (window.deniedCalls ?? 0) + 1; return input; },
    invalidOutput: () => ({ value: 123 }),
    crash: () => { throw new Error("SECRET host credentials"); },
    timed: (input) => new Promise(resolve => setTimeout(() => resolve(input), 150)),
    capped: (input) => new Promise(resolve => setTimeout(() => resolve(input), 150)),
    slow: (input, { signal }) => new Promise((resolve, reject) => {
      window.slowStarted = true;
      const timer = setTimeout(() => resolve(input), 2000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        window.slowCancelled = true;
        reject(new Error("SECRET cancelled"));
      }, { once: true });
    }),
  })], { grantedCapabilities: ["test.echo"] });
}

const gamePackage = createSandboxGamePackagePolicy({
  entry: "index.html", resources: ["index.html", "game.js", preloadPath],
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function serveHostModule(pathname, response) {
  const match = /^\/(dist|zod)\/([A-Za-z0-9_./-]+)$/.exec(pathname);
  if (!match || match[2].split("/").includes("..")) return false;
  try {
    // Use the actual self-contained host browser artifact; the package root
    // also has parser dependencies intended for a bundler, not bare HTTP ESM.
    const name = match[1] === "dist" && match[2] === "index.js" ? "package.runtime.js" : match[2];
    const body = await readFile(resolve(root, match[1] === "dist" ? "dist" : "node_modules/zod", name));
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
  return true;
}

function hostHtml() {
  return `<!doctype html><html><head>
    <script type="importmap">${JSON.stringify({ imports: { zod: `${hostOrigin}/zod/index.js` } })}</script>
    </head><body><div id="status">pending</div><iframe id="frame" sandbox="allow-scripts allow-same-origin"></iframe>
    <script type="module">
      import { z } from "zod";
      import { SandboxHostSession, defineMethod, defineSandboxPlugin, composeHostPlugins, createHostPlugin } from "/dist/index.js";
      ${registry.toString()}
      const extensions = registry();
      const frame = document.querySelector("#frame");
      window.session = new SandboxHostSession({ window, iframe: frame, gameOrigin: ${JSON.stringify(gameOrigin)},
        methods: extensions.methods, capabilities: extensions.capabilities });
      session.start();
      frame.src = ${JSON.stringify(`${gameOrigin}/index.html`)};
      session.connected.then(() => document.querySelector("#status").textContent = "connected");
    </script></body></html>`;
}

test.beforeAll(async () => {
  gameServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, gameOrigin).pathname;
    const policy = buildBrowserPolicy({ gameOrigin, hostOrigins: [hostOrigin], capabilities: [] });
    response.setHeader("Content-Security-Policy", policy.contentSecurityPolicy);
    response.setHeader("Permissions-Policy", policy.permissionsPolicy);
    if (!gamePackage.isAllowedResourcePath(pathname)) { response.writeHead(404); response.end(); return; }
    if (pathname === preloadPath) {
      // Reserved, platform-owned route. Never read this from the uploaded game.
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(await readFile(resolve(root, "dist/game.preload.js")));
    } else if (pathname === "/index.html") {
      const tag = renderSandboxGamePreloadScript({ src: preloadPath, expectedHostOrigin: hostOrigin, methods: registry().gameApi });
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><html><head>${tag}</head><body><div id="result">pending</div><script src="/game.js"></script></body></html>`);
    } else if (pathname === "/game.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(`window.firstApiType = typeof window.game.echo;
        window.game.echo({ value: "boot" }).then(result => document.querySelector("#result").textContent = result.value);`);
    } else { response.writeHead(404); response.end(); }
  });
  gameOrigin = await listen(gameServer);
  hostServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, hostOrigin).pathname;
    if (pathname === "/host.html") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(hostHtml());
    } else if (!await serveHostModule(pathname, response)) { response.writeHead(404); response.end(); }
  });
  hostOrigin = await listen(hostServer);
});

test.afterAll(async () => {
  await Promise.all([hostServer, gameServer].map(server => new Promise(resolve => server?.close(resolve))));
});

async function openGame(page) {
  await page.goto(`${hostOrigin}/host.html`);
  await expect(page.frameLocator("#frame").locator("#result")).toHaveText("boot");
  return page.frames().find(frame => frame.url() === `${gameOrigin}/index.html`);
}

test("preloads native methods before the first game script under self-only CSP", async ({ page, request }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const frame = await openGame(page);
  const result = await frame.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "game");
    const original = window.game;
    try { window.game = {}; } catch {}
    try { window.game.echo = () => {}; } catch {}
    let parentBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    return {
      first: window.firstApiType, unchanged: window.game === original,
      frozen: Object.isFrozen(game), writable: descriptor.writable, configurable: descriptor.configurable,
      noPrototype: Object.getPrototypeOf(game) === null, noLegacySdk: typeof window.CodemaoSandboxGame,
      resolved: await Promise.resolve(game) === game, parentBlocked,
      result: await game.echo({ value: "native" }),
    };
  });
  assert.deepEqual(result, { first: "function", unchanged: true, frozen: true, writable: false, configurable: false,
    noPrototype: true, noLegacySdk: "undefined", resolved: true, parentBlocked: true, result: { value: "native" } });
  assert.deepEqual(errors, []);
  const html = await request.get(`${gameOrigin}/index.html`);
  assert.match(html.headers()["content-security-policy"], /connect-src 'none'/);
  assert.match(html.headers()["content-security-policy"], /(?:^|; )script-src 'self';/);
  assert.equal((await request.get(`${gameOrigin}/dist/index.js`)).status(), 404);
  assert.equal((await request.get(`${gameOrigin}/__sandbox/other.js`)).status(), 404);
});

test("native methods retain host authorization, schemas and sanitized errors", async ({ page }) => {
  const frame = await openGame(page);
  const results = await frame.evaluate(async () => {
    const errors = [];
    for (const [method, input] of [["echo", { value: 123 }], ["denied", { value: "no" }], ["invalidOutput", { value: "x" }], ["crash", { value: "x" }]]) {
      try { await game[method](input); } catch (error) { errors.push({ code: error.code, message: error.message }); }
    }
    return errors;
  });
  assert.deepEqual(results.map(error => error.code), ["INVALID_PAYLOAD", "NOT_ALLOWED", "INTERNAL_ERROR", "INTERNAL_ERROR"]);
  assert.ok(results.every(error => !error.message.includes("SECRET")));
  assert.equal(await page.evaluate(() => window.echoCalls), 1);
  assert.equal(await page.evaluate(() => window.deniedCalls ?? 0), 0);
});

test("native calls use plugin defaults, allow overrides and retain host hard limits", async ({ page }) => {
  const frame = await openGame(page);
  const result = await frame.evaluate(async () => {
    let defaultError, cappedError;
    try { await game.timed({ value: "default" }); } catch (error) { defaultError = error.code; }
    const extended = await game.timed({ value: "extended" }, { timeoutMs: 2000 });
    try { await game.capped({ value: "capped" }, { timeoutMs: 2000 }); } catch (error) { cappedError = error.code; }
    return { defaultError, extended, cappedError };
  });
  assert.deepEqual(result, {
    defaultError: "TIMEOUT", extended: { value: "extended" }, cappedError: "TIMEOUT",
  });
});

test("native calls preserve method limits, cancellation, timeouts and termination", async ({ page }) => {
  const frame = await openGame(page);
  await frame.evaluate(() => {
    window.cancel = new AbortController();
    window.pending = game.slow({ value: "slow" }, { signal: cancel.signal }).catch(error => error.code);
  });
  await expect.poll(() => page.evaluate(() => window.slowStarted)).toBe(true);
  assert.equal(await frame.evaluate(async () => {
    try { await game.slow({ value: "second" }); } catch (error) { return error.code; }
  }), "RATE_LIMITED");
  assert.equal(await frame.evaluate(async () => { cancel.abort(); return window.pending; }), "CANCELLED");
  await expect.poll(() => page.evaluate(() => window.slowCancelled)).toBe(true);
  assert.equal(await frame.evaluate(async () => {
    try { await game.slow({ value: "timeout" }, { timeoutMs: 20 }); } catch (error) { return error.code; }
  }), "TIMEOUT");
  // Keep the document alive solely to observe the client's termination state.
  await page.evaluate(() => {
    document.querySelector("#frame").remove = () => {};
    session.terminate("test complete");
  });
  await expect.poll(() => frame.evaluate(async () => {
    try { await game.echo({ value: "closed" }); } catch (error) { return error.code; }
  })).toBe("BRIDGE_CLOSED");
});
