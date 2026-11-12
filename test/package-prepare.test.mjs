import assert from "node:assert/strict";
import test from "node:test";
import { prepareSandboxPackage, SANDBOX_RUNTIME_VERSION, SANDBOX_PACKAGE_LIMITS, createSandboxPackageSession, buildOfflineBrowserPolicy } from "../dist/index.js";
import { snapshotPreparedPackage } from "../dist/package-prepare.js";
import { resolvePackageReference } from "../dist/package-format.js";
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

test("secondary HTML templates remain verified passive fetch data, never executable resources", async () => {
  const template = '<!doctype html>\r\n<section id="template">模板 __SANDBOX_PACKAGE_ASSET_0__</section><script>globalThis.__templateExecuted = true; fetch("https://external.invalid/")</script><script>not valid JS ???</script>';
  const sources = {
    "index.html": '<main>root</main><script>fetch("assets/template.html").then(response => response.text())</script>',
    "assets/template.html": template,
    "assets/nested/fragment.HTML": "<p>nested HTML data</p>",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("prepare must not fetch template references"); };
  globalThis.__templateExecuted = false;
  try {
    const packageInput = await input(sources);
    const prepared = await prepareSandboxPackage(packageInput);
    const snapshot = snapshotPreparedPackage(prepared);
    assert.equal(prepared.manifest.entrypoint, "index.html");
    assert.equal(new TextDecoder().decode(snapshot.files["assets/template.html"]), template);
    assert.equal(new TextDecoder().decode(snapshot.files["assets/nested/fragment.HTML"]), sources["assets/nested/fragment.HTML"]);
    assert.equal(snapshot.plan.resources.some(resource => resource.mime === "text/html"), false, "HTML data must not get Blob resources");
    assert.equal(snapshot.plan.html.join("").includes('id="template"'), false, "only root HTML becomes the document");
    assert.equal(globalThis.__templateExecuted, false);
    assert.equal(prepared.totalBytes, Object.values(packageInput.files).reduce((sum, bytes) => sum + bytes.byteLength, 0));
  } finally { globalThis.fetch = originalFetch; delete globalThis.__templateExecuted; }
});

test("secondary HTML still requires integrity, UTF-8, size limits and the root entrypoint", async () => {
  const sources = { "index.html": "<p>root</p>", "assets/template.html": "<p>template</p>" };
  for (const mutate of [
    value => { value.manifest.files["assets/template.html"].sha256 = "0".repeat(64); },
    value => { value.manifest.files["assets/template.html"].size++; },
    value => { value.manifest.files["assets/template.html"].size = SANDBOX_PACKAGE_LIMITS.fileBytes + 1; },
    value => { value.manifest.entrypoint = "assets/template.html"; },
  ]) {
    const value = await input(sources); mutate(value);
    await assert.rejects(prepareSandboxPackage(value));
  }
  await assert.rejects(prepareSandboxPackage(await input({ ...sources, "assets/template.html": new Uint8Array([0xff]) })), error => error.code === "INVALID_ENCODING");
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
  ["HTML template as classic script", { "index.html": '<script src="assets/template.html"></script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as module", { "index.html": '<script type="module">import "./assets/template.html"</script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as stylesheet", { "index.html": '<link rel="stylesheet" href="assets/template.html">', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template in CSS import", { "index.html": '<style>@import "./assets/template.html";</style>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as Blob asset", { "index.html": '<script type="module">new URL("./assets/template.html", import.meta.url)</script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template iframe", { "index.html": '<iframe src="assets/template.html"></iframe>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_HTML"],
  ["HTML template navigation", { "index.html": '<a href="assets/template.html">template</a>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_HTML"],
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

for (const path of ["payload.constructor", "payload.__proto__"]) {
  test(`public prepare rejects prototype-chain MIME extension ${path}`, async () => {
    await assert.rejects(prepareSandboxPackage(await input({"index.html":"<p>root</p>",[path]:new Uint8Array()})),error=>error.code==="UNSUPPORTED_FORMAT");
  });
}

test("prepare rejects encoded over-root references instead of aliasing root resources", async () => {
  for (const html of ['<script src="%2e%2e/secret.js"></script>', '<script>fetch(".%2E/data.txt")</script>', '<style>body{background:url("%2E%2e/image.png")}</style>']) {
    await assert.rejects(prepareSandboxPackage(await input({"index.html":html,"secret.js":"", "data.txt":"local", "image.png":new Uint8Array()})),error=>error.code==="INVALID_PATH");
  }
});

test("virtual reference resolution retains query/hash until Blob materialization", async () => {
  assert.deepEqual(resolvePackageReference("../image.png?v=1#view?keep=2", "styles/main.css"), {path:"image.png",suffix:"?v=1#view?keep=2"});
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<img src="image.png?v=1#html?keep=1"><style>body{background-image:url("image.png?v=2#css?keep=2")}</style>',
    "image.png": new Uint8Array([1,2,3]),
  }));
  const suffixes=snapshotPreparedPackage(prepared).plan.html.filter(part=>typeof part!=="string").map(part=>part.suffix);
  assert.deepEqual(suffixes,["?v=1#html?keep=1","?v=2#css?keep=2"]);
});

for (const suffix of ["?v=1", "#module", "?v=1#module"]) {
  for (const kind of ["static import", "literal dynamic import", "module src"]) {
    test(`ESM ${kind} still rejects query/hash ${suffix}`, async () => {
      const html=kind==="module src"?`<script type="module" src="dep.js${suffix}"></script>`:
        `<script type="module">${kind==="static import"?`import "./dep.js${suffix}"`:`import("./dep.js${suffix}")`}</script>`;
      await assert.rejects(prepareSandboxPackage(await input({"index.html":html,"dep.js":"export const value=1;"})),error=>error.code==="UNSUPPORTED_REFERENCE" && error.message.includes("Module query/fragment"));
    });
  }
}

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
