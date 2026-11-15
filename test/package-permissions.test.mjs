import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_PACKAGE_PERMISSIONS, normalizeSandboxPackagePermissions,
  buildOfflineBrowserPolicy, createSandboxPackageSession, prepareSandboxPackage,
} from "../dist/index.js";
import { snapshotPreparedPackage } from "../dist/package-prepare.js";

const order = ["worker", "wasm", "pointerLock", "eval", "clipboardRead", "playerProfile"];
test("canonical permission list is fixed and frozen", () => {
  assert.deepEqual(SANDBOX_PACKAGE_PERMISSIONS, order);
  assert.equal(Object.isFrozen(SANDBOX_PACKAGE_PERMISSIONS), true);
});
for (let mask = 0; mask < 2 ** order.length; mask++) {
  const grants = order.filter((_, i) => mask & (1 << i));
  test(`normalization and offline policy cover permission combination ${mask}`, () => {
    const input = [...grants].reverse().concat(grants);
    const normalized = order.filter(p => grants.includes(p) || (p === "wasm" && grants.includes("eval")));
    assert.deepEqual(normalizeSandboxPackagePermissions(input), normalized);
    assert.deepEqual(input, [...grants].reverse().concat(grants), "must not mutate metadata");
    assert.deepEqual(normalizeSandboxPackagePermissions(normalized), normalized);
    const policy = buildOfflineBrowserPolicy(grants);
    const directives = Object.fromEntries(policy.contentSecurityPolicy.split("; ").map(d => { const [k, ...v] = d.split(" "); return [k, v]; }));
    assert.deepEqual(policy.sandboxTokens, ["allow-scripts", ...(grants.includes("pointerLock") ? ["allow-pointer-lock"] : [])]);
    assert.deepEqual(directives["worker-src"], grants.includes("worker") ? ["blob:"] : ["'none'"]);
    assert.deepEqual(directives["script-src"], [
      "'unsafe-inline'", "blob:",
      ...(normalized.includes("wasm") ? ["'wasm-unsafe-eval'"] : []),
      ...(grants.includes("eval") ? ["'unsafe-eval'"] : []),
    ]);
    assert.deepEqual(directives["style-src"], ["'unsafe-inline'", "blob:"]);
    for (const assetDirective of ["img-src", "font-src", "media-src"]) {
      assert.deepEqual(directives[assetDirective], ["blob:", "data:"]);
    }
    assert.deepEqual(directives["connect-src"], ["'none'"]);
    assert.deepEqual(directives["frame-src"], ["'none'"]);
    assert.deepEqual(policy.iframeAllow, []);
    assert.match(policy.permissionsPolicy, /clipboard-read=\(\)/);
    assert.match(policy.permissionsPolicy, /clipboard-write=\(\)/);
    assert.equal(policy.grantedCapabilities.includes("browser.wasm"), normalized.includes("wasm"));
    assert.equal(policy.grantedCapabilities.includes("browser.pointer-lock"), grants.includes("pointerLock"));
    assert.equal(policy.grantedCapabilities.includes("browser.clipboard.read"), false);
  });
}
test("unknown values, sparse arrays and non-arrays fail closed", () => {
  for (const input of [undefined, null, false, 1, "worker", {}, { 0: "worker", length: 1 }, new Set(["worker"]), ["Worker"], ["clipboard-read"], ["network"], ["worker", null], [1], [Symbol()], new Array(1)]) {
    assert.throws(() => normalizeSandboxPackagePermissions(input), TypeError);
    // Runtime JS callers cannot bypass validation on the execution entry.
    if (input !== undefined) assert.throws(() => createSandboxPackageSession({ permissions: input }), TypeError);
  }
  assert.deepEqual(buildOfflineBrowserPolicy(), buildOfflineBrowserPolicy([]));
  assert.deepEqual(buildOfflineBrowserPolicy().grantedCapabilities, []);
  assert.throws(() => buildOfflineBrowserPolicy(null), TypeError);
});

test("prepare accepts eval/new Function without execution or string reference rewriting", async () => {
  const js = 'eval(\'globalThis.__mustNotExecute=true; fetch("https://opaque.invalid/file")\'); new Function(\'return import("https://opaque.invalid/mod.js")\');';
  const bytes = new TextEncoder().encode(`<script>${js}</script>`);
  const prepared = await prepareSandboxPackage({
    manifest: { formatVersion: 1, entrypoint: "index.html", files: { "index.html": { size: bytes.length, sha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex") } } },
    files: { "index.html": bytes },
  });
  assert.equal(globalThis.__mustNotExecute, undefined);
  assert.ok(snapshotPreparedPackage(prepared).plan.html.join("").includes(js));
});
