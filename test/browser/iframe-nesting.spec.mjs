// Probe: can a game escape its sandbox by nesting browsing contexts
// (iframe inside iframe, srcdoc, blob:, data:, object/embed, popups)?
//
// Observed with Chromium + the policy produced by buildBrowserPolicy():
// - frame-src 'none' blocks same-origin src, blob:, data: and later
//   navigations of an about:blank frame; object-src 'none' blocks object/embed.
// - srcdoc and about:blank+document.write DO create a nested document (Chromium
//   does not apply frame-src to them), but the document inherits the parent's
//   CSP and the parent's sandbox flags, so script still cannot eval, fetch,
//   send beacons, open popups, navigate the top frame or read the host DOM.
// - A nested frame's own sandbox="allow-top-navigation allow-popups ..." cannot
//   elevate itself above the flags it inherits.
// - Every HTML response in the package must carry the same CSP. The control
//   test below verifies that a same-origin navigation remains governed by the
//   package resource policy.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  buildBrowserPolicy,
  createSandboxGamePackagePolicy,
} from "../../dist/index.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

let hostServer;
let gameServer;
let hostOrigin;
let gameOrigin;
/** @type {Map<string, number>} */
let egressHits;
const gamePackage = createSandboxGamePackagePolicy({
  entry: "index.html",
  resources: ["index.html", "probe-game.js", "probe.js", "nested.html"],
});

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

function nestedHtml(id, host) {
  return `<!doctype html><html><body>
<script>window.__inlineRan = true;</script>
<script src="/probe.js?id=${encodeURIComponent(id)}&host=${encodeURIComponent(host)}"></script>
</body></html>`;
}

function gameHtml(nonce) {
  return `<!doctype html>
<html>
  <body>
    <script nonce="${nonce}">window.__HOST_ORIGIN = ${JSON.stringify(hostOrigin)};</script>
    <script src="/probe-game.js"></script>
  </body>
</html>`;
}

function hostHtml(popupAllowed = false) {
  const browserPolicy = buildBrowserPolicy({
    gameOrigin,
    hostOrigins: [hostOrigin],
    capabilities: popupAllowed ? ["browser.popup"] : [],
  });
  return `<!doctype html>
<html>
  <body>
    <div id="host-status">starting</div>
    <iframe
      id="game"
      title="game"
      sandbox="${browserPolicy.sandboxTokens.join(" ")}"
      allow="${browserPolicy.iframeAllow.join("; ")}"
      src="${gameOrigin}/index.html"
    ></iframe>
  </body>
</html>`;
}

function noteEgress(url) {
  const via = new URL(url, "http://127.0.0.1").searchParams.get("via") ?? "unknown";
  egressHits.set(via, (egressHits.get(via) ?? 0) + 1);
}

async function startServers() {
  gameServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, gameOrigin ?? "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/index.html") {
      const nonce = "dGVzdC1ub25jZS1mb3ItaWZyYW1lLXByb2Jl";
      const browserPolicy = buildBrowserPolicy({
        gameOrigin,
        hostOrigins: [hostOrigin],
        capabilities: [],
        scriptNonces: [nonce],
      });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": browserPolicy.contentSecurityPolicy,
        "Permissions-Policy": browserPolicy.permissionsPolicy,
      });
      response.end(gameHtml(nonce));
      return;
    }

    if (!gamePackage.isAllowedResourcePath(pathname)) {
      response.writeHead(404);
      response.end();
      return;
    }

    if (pathname === "/probe-game.js" || pathname === "/probe.js") {
      const file = pathname === "/probe.js" ? "iframe-probe-inner.js" : "iframe-probe-game.js";
      const body = await readFile(resolve(fixtureRoot, file));
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(body);
      return;
    }

    if (pathname === "/nested.html") {
      const browserPolicy = buildBrowserPolicy({
        gameOrigin,
        hostOrigins: [hostOrigin],
        capabilities: [],
      });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": browserPolicy.contentSecurityPolicy,
        "Permissions-Policy": browserPolicy.permissionsPolicy,
      });
      response.end(
        nestedHtml(
          url.searchParams.get("id") ?? "static",
          url.searchParams.get("host") ?? hostOrigin,
        ),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  const gamePort = await listen(gameServer);
  gameOrigin = `http://127.0.0.1:${gamePort}`;

  hostServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, hostOrigin ?? "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/host.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(hostHtml(url.searchParams.get("popup") === "1"));
      return;
    }
    if (pathname === "/egress") {
      noteEgress(request.url);
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }
    if (pathname === "/nested.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        nestedHtml(
          url.searchParams.get("id") ?? "static",
          url.searchParams.get("host") ?? hostOrigin,
        ),
      );
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
  egressHits = new Map();
});

test("nested iframe vectors cannot escape the game sandbox", async ({ page }) => {
  await page.goto(`${hostOrigin}/host.html`);

  const gameFrame = page
    .frames()
    .find((frame) => frame.url().startsWith(`${gameOrigin}/index.html`));
  assert.ok(gameFrame, "game frame should exist");

  await gameFrame.waitForFunction(() => window.__probes?.done === true, null, {
    timeout: 12_000,
  });
  // Let late beacons/loads land.
  await page.waitForTimeout(500);

  const result = await gameFrame.evaluate(() => window.__probes);

  console.log("\n=== nested iframe vectors ===");
  for (const record of Object.values(result.vectors)) {
    const nested = record.nested ?? {};
    const interesting = {
      loaded: record.loaded,
      scriptRan: record.scriptRan,
      inlineRan: record.inlineRan,
      origin: nested.origin,
      eval: nested.eval,
      popup: nested.popup,
      topNav: nested.topNav,
      fetch: nested.fetch,
      imgBeacon: nested.imgBeacon,
      formSubmit: nested.formSubmit,
      readParent: nested.readParent,
      readTop: nested.readTop,
      nestedIframe: nested.nestedIframe,
      nestedViolations: nested.violations,
      opened: record.opened,
      error: record.error,
      violations: record.violations,
    };
    console.log(record.label, JSON.stringify(interesting));
  }
  console.log("game top navigation:", result.gameTopNav);
  console.log("host egress hits:", JSON.stringify(Object.fromEntries(egressHits ?? []), null, 2));
  console.log("final page url:", page.url());

  // The host page must never be navigated by the game.
  assert.equal(page.url(), `${hostOrigin}/host.html`);
  assert.equal(result.gameTopNav.startsWith("blocked:"), true);
  // No nested browsing context may reach the cross-origin host: no DOM read,
  // no popup, no top navigation, no network egress.
  assert.deepEqual(Object.fromEntries(egressHits ?? []), {});
  for (const record of Object.values(result.vectors)) {
    if (!record.scriptRan) continue;
    const nested = record.nested ?? {};
    assert.notEqual(nested.eval, "allowed", `${record.label} ran eval`);
    assert.notEqual(nested.fetch, "sent", `${record.label} fetched host origin`);
    assert.notEqual(nested.readTop, true, `${record.label} read host DOM`);
    assert.notEqual(nested.popup, "opened", `${record.label} opened a popup`);
    assert.notEqual(nested.topNav, "assigned", `${record.label} navigated the host`);
  }
});

test("granting popup does not bypass the package resource policy", async ({ page }) => {
  // A popup is a new top-level browsing context, so every package HTML
  // response must carry the same CSP as the initial entry document.
  await page.goto(`${hostOrigin}/host.html?popup=1`);

  const gameFrame = page
    .frames()
    .find((frame) => frame.url().startsWith(`${gameOrigin}/index.html`));
  assert.ok(gameFrame, "game frame should exist");
  await gameFrame.waitForFunction(() => window.__probes?.done === true, null, {
    timeout: 12_000,
  });

  const opened = await gameFrame.evaluate(() => {
    const win = window.open(
      `/nested.html?id=popup-egress&host=${encodeURIComponent(window.__HOST_ORIGIN)}`,
    );
    window.__popup = win;
    return win !== null;
  });
  await page.waitForTimeout(1200);

  const hostHits = Object.fromEntries(egressHits ?? []);
  console.log("\n=== popup capability ===");
  console.log("popup opened:", opened);
  console.log("host egress hits:", JSON.stringify(hostHits, null, 2));
  console.log("pages:", page.context().pages().map((item) => item.url()));
  expect(page.url()).toBe(`${hostOrigin}/host.html?popup=1`);

  assert.ok(opened, "browser.popup should allow window.open");
  assert.equal(hostHits["form-popup-egress"], undefined);
  assert.equal(hostHits["fetch-popup-egress"], undefined);
  assert.equal(hostHits["img-popup-egress"], undefined);
  assert.equal(hostHits["topnav-popup-egress"], 1);
});

test("same-origin navigation remains governed by the package resource policy", async ({ page }) => {
  await page.goto(`${hostOrigin}/host.html`);

  const gameFrame = page
    .frames()
    .find((frame) => frame.url().startsWith(`${gameOrigin}/index.html`));
  assert.ok(gameFrame, "game frame should exist");

  await gameFrame.evaluate(() => {
    location.href = `/nested.html?id=self-nav&host=${encodeURIComponent(window.__HOST_ORIGIN)}`;
  });
  await page.waitForTimeout(1500);

  console.log("\n=== self-navigation control ===");
  console.log("frames:", page.frames().map((frame) => frame.url()));

  const navigated = page
    .frames()
    .find((frame) => frame.url().startsWith(`${gameOrigin}/nested.html`));
  assert.ok(navigated, "game iframe should navigate to the whitelisted document");
  await page.waitForTimeout(800);

  const hostHits = Object.fromEntries(egressHits ?? []);
  console.log("host egress hits:", JSON.stringify(hostHits, null, 2));
  console.log("page url:", page.url());
  expect(page.url()).toBe(`${hostOrigin}/host.html`);

  assert.deepEqual(hostHits, {});
  assert.equal(hostHits["topnav-self-nav"], undefined);
  assert.equal(hostHits["form-self-nav"], undefined);
});
