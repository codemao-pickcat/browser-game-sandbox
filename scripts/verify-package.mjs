import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as publicApi from "../dist/index.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const result = JSON.parse(input);
// npm 12 keys pack output by package name; npm 11 returns an array.
const [packed] = Array.isArray(result) ? result : Object.values(result);
const files = new Set(packed.files.map(file => file.path));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.publishConfig?.registry, "https://npm.pkg.github.com");
assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./game.preload.js", "./package.runtime.js"], "Only host and trusted platform runtime entries may be published");
assert.equal(publicApi.SANDBOX_RUNTIME_VERSION, pkg.version);
assert.equal(typeof publicApi.prepareSandboxPackage, "function");
assert.equal(typeof publicApi.createSandboxPackageSession, "function");
assert.equal("SandboxHostRpcSession" in publicApi, false);
assert.equal(pkg.scripts.prepare, "npm run build");
assert.ok(files.has("dist/package-bootstrap-source.js"), "Missing embedded trusted bootstrap");
assert.equal(pkg.exports["./game.preload.js"], "./dist/game.preload.js");
for (const target of Object.values(pkg.exports).flatMap(value => typeof value === "string" ? [value] : Object.values(value))) {
  assert.ok(files.has(target.replace(/^\.\//, "")), `Missing packed export: ${target}`);
}
for (const file of files) {
  assert.ok(!/^dist\/(?:html|sdk|vue)\./.test(file) && !/^dist\/game\.global\.js(?:\.map)?$/.test(file), `Retired SDK artifact is still packed: ${file}`);
}
for (const name of [
  "acceptSandboxBridge", "SandboxBridgeClient", "connectSandboxHtmlSdk", "connectSandboxGame",
  "createSandboxSdk", "createPluginSdk", "SandboxSdkValidationError", "installSandboxGameApi",
]) {
  assert.equal(name in publicApi, false, `Retired root export is still public: ${name}`);
}
console.log(`Verified ${pkg.name}@${pkg.version}: host and trusted offline/preload runtimes; no retired SDK artifacts`);
