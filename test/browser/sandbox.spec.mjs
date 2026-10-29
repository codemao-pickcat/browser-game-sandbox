import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let hostServer;
let gameServer;
let hostOrigin;
let gameOrigin;
let networkHits = 0;

function listen(server) {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine test server port"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function contentType(pathname) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function serveDist(requestPath, response) {
  const relativePath = requestPath.slice("/dist/".length);
  const filePath = resolve(repoRoot, "dist", relativePath);
  const distRoot = resolve(repoRoot, "dist") + sep;
  if (!filePath.startsWith(distRoot)) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}

async function serveZod(requestPath, response) {
  const relativePath = requestPath.slice("/zod/".length);
  const filePath = resolve(repoRoot, "node_modules", "zod", relativePath);
  const zodRoot = resolve(repoRoot, "node_modules", "zod") + sep;
  if (!filePath.startsWith(zodRoot)) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}

function hostHtml() {
  return `<!doctype html>
<html>
  <body>
    <script type="importmap">${JSON.stringify({ imports: { zod: `${hostOrigin}/zod/index.js` } })}</script>
    <div id="host-status">starting</div>
    <iframe
      id="game"
      title="game"
      sandbox="allow-scripts allow-same-origin"
      src="${gameOrigin}/game.html"
    ></iframe>
    <script type="module">
      import { SandboxHostSession } from "/dist/index.js";

      const iframe = document.querySelector("#game");
      const status = document.querySelector("#host-status");
      const host = new SandboxHostSession({
        window,
        iframe,
        gameOrigin: ${JSON.stringify(gameOrigin)},
        capabilities: ["test.echo"],
        methods: {
          "test.echo": {
            capability: "test.echo",
            handler: (payload) => payload,
          },
        },
        onTerminate: (reason) => {
          status.textContent = "terminated:" + reason;
        },
      });
      host.start();
      window.__sandboxHost = host;
      host.connected
        .then(() => { status.textContent = "connected"; })
        .catch((error) => { status.textContent = "failed:" + error.code; });

      const attacker = document.createElement("iframe");
      attacker.hidden = true;
      attacker.src = ${JSON.stringify(`${gameOrigin}/attacker.html`)};
      document.body.appendChild(attacker);
    </script>
  </body>
</html>`;
}

function gameHtml(importMapNonce) {
  return `<!doctype html>
<html>
  <body>
    <script type="importmap" nonce="${importMapNonce}">${JSON.stringify({ imports: { zod: `${gameOrigin}/zod/index.js` } })}</script>
    <div id="bridge">pending</div>
    <div id="local-storage">pending</div>
    <div id="indexed-db">pending</div>
    <div id="dedicated-worker">pending</div>
    <div id="service-worker">pending</div>
    <div id="network">pending</div>
    <div id="parent-access">pending</div>
    <div id="popup">pending</div>
    <script type="module" src="/game.js"></script>
  </body>
</html>`;
}

function gameJs() {
  return `import { acceptSandboxBridge } from "/dist/index.js";

const set = (id, value) => { document.querySelector(id).textContent = value; };

try {
  localStorage.setItem("sandbox-test", "ok");
  set("#local-storage", localStorage.getItem("sandbox-test") === "ok" ? "ok" : "failed");
} catch {
  set("#local-storage", "failed");
}

try {
  const request = indexedDB.open("sandbox-test", 1);
  request.onsuccess = () => { request.result.close(); set("#indexed-db", "ok"); };
  request.onerror = () => set("#indexed-db", "failed");
} catch {
  set("#indexed-db", "failed");
}

try {
  const workerUrl = URL.createObjectURL(new Blob(["postMessage('ok')"], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  worker.onmessage = (event) => { set("#dedicated-worker", event.data === "ok" ? "ok" : "failed"); worker.terminate(); URL.revokeObjectURL(workerUrl); };
  worker.onerror = () => { set("#dedicated-worker", "failed"); worker.terminate(); URL.revokeObjectURL(workerUrl); };
} catch {
  set("#dedicated-worker", "failed");
}

(async () => {
  try {
    await navigator.serviceWorker.register("/sw.js");
    set("#service-worker", "registered");
  } catch {
    set("#service-worker", "blocked");
  }
})();

(async () => {
  try {
    await fetch("/network-hit", { cache: "no-store" });
    set("#network", "reached");
  } catch {
    set("#network", "blocked");
  }
})();

try {
  void window.parent.document.body;
  set("#parent-access", "reached");
} catch {
  set("#parent-access", "blocked");
}

try {
  set("#popup", window.open("about:blank") === null ? "blocked" : "opened");
} catch {
  set("#popup", "blocked");
}

try {
  window.top.location.href = "https://attacker.invalid/escape";
} catch {
  // The sandbox is expected to block this navigation.
}

const hostOrigin = new URL(document.referrer).origin;
const bridge = await acceptSandboxBridge({
  window,
  expectedHostOrigin: hostOrigin,
});

try {
  const result = await bridge.call("sandbox.ping", {});
  const echo = await bridge.call("test.echo", { value: "ok" });
  set("#bridge", result.ok === true && echo.value === "ok" ? "ok" : "failed");
} catch {
  set("#bridge", "failed");
}
`;
}

function attackerHtml() {
  return `<!doctype html><script>
    parent.postMessage({ type: "sandbox:ready", version: 1 }, ${JSON.stringify(hostOrigin)});
  </script>`;
}

async function startServers() {
  gameServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, gameOrigin ?? "http://127.0.0.1").pathname;
    if (pathname === "/game.html") {
      const importMapNonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": [
          "default-src 'self'",
          `script-src 'self' 'nonce-${importMapNonce}'`,
          "connect-src 'none'",
          "worker-src blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          `frame-ancestors ${hostOrigin}`,
        ].join("; "),
      });
      response.end(gameHtml(importMapNonce));
      return;
    }
    if (pathname === "/game.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(gameJs());
      return;
    }
    if (pathname === "/attacker.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(attackerHtml());
      return;
    }
    if (pathname === "/sw.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    if (pathname === "/network-hit") {
      networkHits += 1;
      response.writeHead(200);
      response.end("reached");
      return;
    }
    if (pathname.startsWith("/dist/")) {
      await serveDist(pathname, response);
      return;
    }
    if (pathname.startsWith("/zod/")) {
      await serveZod(pathname, response);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const gamePort = await listen(gameServer);
  gameOrigin = `http://127.0.0.1:${gamePort}`;

  hostServer = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, hostOrigin ?? "http://127.0.0.1").pathname;
    if (pathname === "/host.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(hostHtml());
      return;
    }
    if (pathname.startsWith("/dist/")) {
      await serveDist(pathname, response);
      return;
    }
    if (pathname.startsWith("/zod/")) {
      await serveZod(pathname, response);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const hostPort = await listen(hostServer);
  hostOrigin = `http://127.0.0.1:${hostPort}`;
}

test.beforeAll(async () => {
  await startServers();
});

test.afterAll(async () => {
  await Promise.all([
    new Promise((resolve) => hostServer?.close(() => resolve())),
    new Promise((resolve) => gameServer?.close(() => resolve())),
  ]);
});

test.beforeEach(() => {
  networkHits = 0;
});

test("runs the real cross-origin iframe bridge and browser capability profile", async ({ page }) => {
  await page.goto(`${hostOrigin}/host.html`);

  await expect(page.locator("#host-status")).toHaveText("connected");
  const game = page.frameLocator("iframe#game");
  await expect(game.locator("#bridge")).toHaveText("ok");
  await expect(game.locator("#local-storage")).toHaveText("ok");
  await expect(game.locator("#indexed-db")).toHaveText("ok");
  await expect(game.locator("#dedicated-worker")).toHaveText("ok");
  await expect(game.locator("#service-worker")).toHaveText("blocked");
  await expect(game.locator("#network")).toHaveText("blocked");
  await expect(game.locator("#parent-access")).toHaveText("blocked");
  await expect(game.locator("#popup")).toHaveText("blocked");

  await page.waitForTimeout(100);
  assert.equal(networkHits, 0);
  assert.equal(page.url(), `${hostOrigin}/host.html`);
});

test("ignores a same-origin attacker iframe trying to hijack the handshake", async ({ page }) => {
  await page.goto(`${hostOrigin}/host.html`);
  await expect(page.locator("#host-status")).toHaveText("connected");
  await expect(page.frameLocator("iframe#game").locator("#bridge")).toHaveText("ok");
});
