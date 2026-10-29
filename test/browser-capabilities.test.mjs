import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CAPABILITIES,
  buildBrowserPolicy,
} from "../dist/index.js";

const GAME_ORIGIN = "https://game.example.test";
const HOST_ORIGIN = "https://host.example.test";

test("builds an enforceable baseline browser policy", () => {
  const policy = buildBrowserPolicy({
    gameOrigin: GAME_ORIGIN,
    hostOrigins: [HOST_ORIGIN],
    capabilities: [
      BROWSER_CAPABILITIES.dedicatedWorker,
      BROWSER_CAPABILITIES.wasm,
      BROWSER_CAPABILITIES.camera,
      BROWSER_CAPABILITIES.networkConnect,
    ],
    networkOrigins: ["https://api.example.test"],
    scriptNonces: ["nonce-value"],
  });

  assert.deepEqual(policy.sandboxTokens, ["allow-scripts", "allow-same-origin"]);
  assert.match(policy.contentSecurityPolicy, /worker-src blob:/);
  assert.match(policy.contentSecurityPolicy, /wasm-unsafe-eval/);
  assert.match(policy.contentSecurityPolicy, /connect-src 'self' https:\/\/api\.example\.test/);
  assert.match(policy.contentSecurityPolicy, /frame-ancestors https:\/\/host\.example\.test/);
  assert.match(policy.permissionsPolicy, /camera=\(https:\/\/game\.example\.test\)/);
  assert.equal(policy.enforcement[BROWSER_CAPABILITIES.dedicatedWorker], "enforced");
  assert.equal(policy.enforcement[BROWSER_CAPABILITIES.webgl], "not-granted");
});

test("keeps Service Worker denial separate from Blob Worker support", () => {
  const denied = buildBrowserPolicy({
    gameOrigin: GAME_ORIGIN,
    capabilities: [BROWSER_CAPABILITIES.dedicatedWorker],
  });
  assert.match(denied.contentSecurityPolicy, /worker-src blob:/);
  assert.doesNotMatch(denied.contentSecurityPolicy, /worker-src 'self'/);

  const granted = buildBrowserPolicy({
    gameOrigin: GAME_ORIGIN,
    capabilities: [BROWSER_CAPABILITIES.serviceWorker],
  });
  assert.match(granted.contentSecurityPolicy, /worker-src 'self' blob:/);
  assert.ok(granted.warnings.some((warning) => warning.includes("Service Worker")));
});

test("fails closed for unknown capabilities and network origins", () => {
  assert.throws(
    () => buildBrowserPolicy({
      gameOrigin: GAME_ORIGIN,
      capabilities: ["browser.worker.unknown"],
    }),
    /Unknown browser capability/,
  );
  assert.throws(
    () => buildBrowserPolicy({
      gameOrigin: GAME_ORIGIN,
      capabilities: [BROWSER_CAPABILITIES.networkConnect],
      networkOrigins: ["https://api.example.test/path"],
    }),
    /exact http\(s\)\/ws\(s\) origin/,
  );
});
