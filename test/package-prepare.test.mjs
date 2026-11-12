import assert from "node:assert/strict";
import test from "node:test";
import { prepareSandboxPackage, SANDBOX_RUNTIME_VERSION, SANDBOX_PACKAGE_LIMITS, createSandboxPackageSession, buildOfflineBrowserPolicy } from "../dist/index.js";
import { snapshotPreparedPackage } from "../dist/package-prepare.js";
import { packageStoragePlugin } from "../dist/package-storage.js";
import { SandboxHostRpcSession } from "../dist/host.js";
import { SandboxBridgeClient } from "../dist/client.js";

async function input(sources) {
  const files = Object.fromEntries(Object.entries(sources).map(([path, source]) => [path, typeof source === "string" ? new TextEncoder().encode(source) : source]));
  const manifestFiles = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, bytes]) => [path, {
    size: bytes.byteLength,
    sha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
  }])));
  return { manifest: { formatVersion: 1, entrypoint: "index.html", files: manifestFiles }, files };
}

const fixture = {
  "index.html": '<link rel="stylesheet" href="css/main.css"><img src="image.png"><script src="classic.js"></script><script type="module" src="js/main.js"></script>',
  "classic.js": 'window.boot = "classic";',
  "js/main.js": 'import { value } from "./child.js"; export { value }; const d = import("./child.js"); const u = new URL("../image.png", import.meta.url); fetch("data.json");',
  "js/child.js": "export const value = 42;",
  "css/main.css": '@import "./child.css"; body { background: url(../image.png) }',
  "css/child.css": "body { margin: 0 }",
  "data.json": '{"value":42}',
  "image.png": new Uint8Array([1, 2, 3]),
};

test("pure Node preparation verifies/compiles multi-file packages without DOM, execution or network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must never fetch"); };
  try {
    globalThis.__packageExecuted = false;
    const packageInput = await input({ ...fixture, "unused.js": "globalThis.__packageExecuted = true" });
    const prepared = await prepareSandboxPackage(packageInput);
    assert.equal(SANDBOX_RUNTIME_VERSION, "0.3.0");
    assert.equal(prepared.runtimeVersion, SANDBOX_RUNTIME_VERSION);
    assert.equal(Object.isFrozen(prepared.manifest.files), true);
    assert.equal(globalThis.__packageExecuted, false);
    const snapshot = snapshotPreparedPackage(prepared);
    assert.match(snapshot.plan.resources.find(r => r.path === "js/main.js").parts.join(""), /sandbox-package:\/js\/child.js/);
    assert.equal(snapshot.plan.html.some(p => typeof p !== "string"), true);
    packageInput.files["index.html"].fill(0);
    snapshot.files["classic.js"].fill(0);
    assert.notEqual(snapshotPreparedPackage(prepared).files["index.html"][0], 0);
    assert.notEqual(snapshotPreparedPackage(prepared).files["classic.js"][0], 0);
    assert.throws(() => snapshotPreparedPackage({ ...prepared }), /must come from prepare/);
  } finally { globalThis.fetch = originalFetch; delete globalThis.__packageExecuted; }
});

test("same-SHA logical paths may share a Uint8Array and buffer without detachment", async () => {
  const shared = new TextEncoder().encode("shared payload");
  const packageInput = await input({"index.html":"<p>shared</p>","a.txt":shared,"b.txt":shared,"c.txt":new Uint8Array(shared.buffer)});
  assert.equal(packageInput.files["a.txt"],packageInput.files["b.txt"]);
  const prepared = await prepareSandboxPackage(packageInput);
  assert.equal(prepared.totalBytes, packageInput.files["index.html"].byteLength + shared.byteLength * 3);
  const snapshot = snapshotPreparedPackage(prepared);
  assert.notEqual(snapshot.files["a.txt"].buffer,snapshot.files["b.txt"].buffer);
  assert.notEqual(snapshot.files["b.txt"].buffer,snapshot.files["c.txt"].buffer);
  assert.equal(shared.byteLength,14);
  assert.equal(new TextDecoder().decode(snapshot.files["b.txt"]),"shared payload");
});

test("integrity, entrypoint, file set and byte limits fail closed", async () => {
  const good = await input({ "index.html": "<!doctype html><p>ok</p>" });
  for (const mutate of [
    x => { x.manifest.entrypoint = "other.html"; },
    x => { x.manifest.formatVersion = 2; },
    x => { x.manifest.files["index.html"].sha256 = "0".repeat(64); },
    x => { x.manifest.files["index.html"].size++; },
    x => { delete x.files["index.html"]; },
    x => { x.files["extra.txt"] = new Uint8Array(); },
    x => { x.manifest.files["index.html"].size = SANDBOX_PACKAGE_LIMITS.fileBytes + 1; },
  ]) { const changed = structuredClone(good); mutate(changed); await assert.rejects(prepareSandboxPackage(changed)); }
  await assert.rejects(prepareSandboxPackage(await input({ "other.html": "no root" })), /root index/);
  await assert.rejects(prepareSandboxPackage(await input({ "index.html": new Uint8Array([0xff]) })), /UTF-8/);
});

test("product budgets match MOSS, including 2000 files and UTF-8 path bytes", async () => {
  assert.equal(SANDBOX_PACKAGE_LIMITS.files, 2000);
  assert.equal(SANDBOX_PACKAGE_LIMITS.pathBytes, 512);
  assert.equal(SANDBOX_PACKAGE_LIMITS.fileBytes, 25 * 1024 * 1024);
  assert.equal(SANDBOX_PACKAGE_LIMITS.totalBytes, 50 * 1024 * 1024);
  const sources = Object.fromEntries(Array.from({length:1999},(_,i)=>[`files/${i}.txt`, ""]));
  // Construct explicitly rather than relying on character length for UTF-8.
  const longPath = "a".repeat(508)+".txt";
  await prepareSandboxPackage(await input({"index.html":"",[longPath]:""}));
  await assert.rejects(prepareSandboxPackage(await input({"index.html":"",["汉".repeat(170)+".txt"]:""})), e=>e.code==="INVALID_PATH");
  await prepareSandboxPackage(await input({"index.html":"",...sources}));
  await assert.rejects(prepareSandboxPackage(await input({"index.html":"",...sources,"extra.txt":""})), /file count/);
});

for (const path of ["../bad.js", "/bad.js", "a//b.js", "a/./b.js", "a/../b.js", "x%2fy.js", "x\\y.js", "https:bad.js", "x?y.js", "x#y.js", "a\u0000.js"]) {
  test(`rejects ambiguous manifest path ${JSON.stringify(path)}`, async () => {
    await assert.rejects(prepareSandboxPackage(await input({ "index.html": "ok", [path]: "" })), /path/i);
  });
}

for (const [name, sources, code] of [
  ["external HTML resource", { "index.html": '<img src="https://remote.invalid/a.png">' }, "EXTERNAL_URL"],
  ["external CSS", { "index.html": '<style>@import "//remote.invalid/a.css";</style>' }, "EXTERNAL_URL"],
  ["missing resource", { "index.html": '<script src="missing.js"></script>' }, "MISSING_RESOURCE"],
  ["dynamic import", { "index.html": '<script type="module">import(window.path)</script>' }, "DYNAMIC_IMPORT"],
  ["external import", { "index.html": '<script type="module">import "https://remote.invalid/a.js"</script>' }, "UNSUPPORTED_MODULE"],
  ["external fetch", { "index.html": '<script>fetch("https://remote.invalid/data")</script>' }, "EXTERNAL_URL"],
  ["Worker", { "index.html": '<script>new Worker("a.js")</script>' }, "UNSUPPORTED_API"],
  ["nested HTML", { "index.html": "ok", "other.html": "other" }, "UNSUPPORTED_FORMAT"],
  ["srcset", { "index.html": '<img srcset="x.png 1x">' }, "UNSUPPORTED_HTML"],
  ["base", { "index.html": '<base href="https://remote.invalid">' }, "UNSUPPORTED_HTML"],
  ["meta refresh", { "index.html": '<meta http-equiv="refresh" content="0;url=https://remote.invalid">' }, "UNSUPPORTED_HTML"],
  ["iframe", { "index.html": '<iframe srcdoc="hi"></iframe>' }, "UNSUPPORTED_HTML"],
  ["module syntax", { "index.html": '<script type="module">export ???</script>' }, "INVALID_JAVASCRIPT"],
  ["CSS cycle", { "index.html": '<link rel="stylesheet" href="a.css">', "a.css": '@import "./b.css";', "b.css": '@import "./a.css";' }, "RESOURCE_CYCLE"],
  ["scripted SVG", { "index.html": '<img src="x.svg">', "x.svg": '<svg><script>alert(1)</script></svg>' }, "UNSUPPORTED_SVG"],
  ["unsupported file", { "index.html": "ok", "app.wasm": new Uint8Array() }, "UNSUPPORTED_FORMAT"],
]) test(`rejects unsupported format: ${name}`, async () => {
  await assert.rejects(prepareSandboxPackage(await input(sources)), error => error.code === code);
});

test("does not rewrite JavaScript strings/comments as resource references; supports ESM cycles", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<script type="module" src="a.js"></script>',
    "a.js": 'import { b } from "./b.js"; export const a=1; // import("https://fake.invalid")\nconst s = "fetch(https://fake.invalid)";',
    "b.js": 'export { a as b } from "./a.js";',
  }));
  assert.match(snapshotPreparedPackage(prepared).plan.resources[0].parts.join(""), /https:\/\/fake.invalid/);
});

test("offline profile is opaque and explicitly refuses zero-network enforcement claims", () => {
  const policy = buildOfflineBrowserPolicy();
  assert.deepEqual(policy.sandboxTokens, ["allow-scripts"]);
  assert.match(policy.contentSecurityPolicy, /connect-src 'none'/);
  assert.match(policy.contentSecurityPolicy, /worker-src 'none'/);
  assert.equal(policy.enforcement["network.webrtc"], "not-enforceable");
  assert.equal(policy.enforcement["network.connect"], "not-enforceable");
  assert.ok(policy.warnings.some(w => w.includes("not zero-network")));
  assert.equal(typeof createSandboxPackageSession, "function");
});

test("storage enforces cumulative write bytes, distinct keys and bounded adapter outputs", async () => {
  for (const mode of ["bytes", "keys", "output"]) {
    let calls=0;
    const composed=packageStoragePlugin({
      async get(){return "x".repeat(16385);},async set(){calls++;},async delete(){calls++;},
    });
    const channel=new MessageChannel();
    const host=new SandboxHostRpcSession({...composed,maxRequestsPerSecond:1000});
    host.start();host.attachAuthenticatedPort(channel.port1);
    const client=new SandboxBridgeClient(channel.port2);client.sendReady();await host.connected;
    try {
      if(mode==="bytes") {
        for(let i=0;i<64;i++)await client.call("package.storage.set",{key:"same",value:"x".repeat(16384)});
        await assert.rejects(client.call("package.storage.set",{key:"same",value:"x"}),e=>e.code==="INTERNAL_ERROR");
        assert.equal(calls,64);
      } else if(mode==="keys") {
        for(let i=0;i<128;i++)await client.call("package.storage.set",{key:String(i),value:""});
        await assert.rejects(client.call("package.storage.delete",{key:"another"}),e=>e.code==="INTERNAL_ERROR");
        assert.equal(calls,128);
      } else await assert.rejects(client.call("package.storage.get",{key:"save"}),e=>e.code==="INTERNAL_ERROR");
    } finally {host.terminate();client.close();}
  }
});

test("storage plugin retains Host RPC schema/auth/limits and immutable adapter binding", async () => {
  const data = new Map(); let calls = 0;
  const adapter = { async get(k) { return data.get(k) ?? null; }, async set(k,v) { calls++; data.set(k,v); }, async delete(k) { data.delete(k); } };
  const composed = packageStoragePlugin(adapter);
  adapter.set = async () => { throw new Error("mutable replacement must not be called"); };
  const channel = new MessageChannel();
  const host = new SandboxHostRpcSession(composed);
  host.start(); host.attachAuthenticatedPort(channel.port1);
  const client = new SandboxBridgeClient(channel.port2); client.sendReady(); await host.connected;
  try {
    await client.call("package.storage.set", { key: "save", value: "hello" });
    assert.equal(await client.call("package.storage.get", { key: "save" }), "hello");
    await assert.rejects(client.call("package.storage.set", { key: "save", value: 123 }), e => e.code === "INVALID_PAYLOAD");
    await assert.rejects(client.call("package.storage.set", { key: "save", value: "x", namespace: "another" }), e => e.code === "INVALID_PAYLOAD");
    await assert.rejects(client.call("package.storage.set", { key: "x".repeat(129), value: "x" }), e => e.code === "INVALID_PAYLOAD");
    await assert.rejects(client.call("package.storage.set", { key: "x", value: "x".repeat(16385) }), e => e.code === "INVALID_PAYLOAD");
    assert.equal(calls, 1);
    await client.call("package.storage.delete", { key: "save" });
    assert.equal(await client.call("package.storage.get", { key: "save" }), null);
  } finally { host.terminate(); client.close(); }
});
