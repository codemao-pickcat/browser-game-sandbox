import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as publicApi from "../dist/index.js";

const packageName = "@codemao-pickcat/browser-game-sandbox";
const retiredExports = [
  "acceptSandboxBridge", "SandboxBridgeClient", "connectSandboxHtmlSdk", "connectSandboxGame",
  "createSandboxSdk", "createPluginSdk", "SandboxSdkValidationError", "installSandboxGameApi",
];

test("exposes host integration only, not content-side SDK constructors", () => {
  assert.equal(typeof publicApi.SandboxHostSession, "function");
  assert.equal(typeof publicApi.renderSandboxGamePreloadScript, "function");
  for (const name of retiredExports) assert.equal(name in publicApi, false, `Retired root export: ${name}`);
});

for (const subpath of ["game", "vue", "game.global.js", "dist/client.js", "dist/game-api.js"]) {
  test(`does not export the retired/internal content entry ${subpath}`, async () => {
    await assert.rejects(import(`${packageName}/${subpath}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  });
}

test("builds contain no stale HTML, Vue or typed SDK artifacts", async () => {
  const files = await readdir(new URL("../dist/", import.meta.url));
  const retired = files.filter(name => /^(?:html|sdk|vue)\./.test(name) || /^game\.global\.js(?:\.map)?$/.test(name));
  assert.deepEqual(retired, []);
  assert.ok(files.includes("game.preload.js"));
  assert.ok(files.includes("client.js"), "the private bridge runtime is still required");
});

test("publishes only the host entry and platform preload, without Vue package dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./game.preload.js", "./package.runtime.js"]);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    assert.equal(pkg[field]?.vue, undefined, `Unnecessary root Vue dependency: ${field}`);
  }
  const vueFixture = JSON.parse(await readFile(new URL("./vue-compat/package.json", import.meta.url), "utf8"));
  assert.equal(vueFixture.dependencies[packageName], undefined);
  assert.equal(vueFixture.dependencies.zod, undefined);
});

test("prebuild removes old dist outputs without touching sibling files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-clean-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "dist"));
    await copyFile(new URL("../scripts/clean.mjs", import.meta.url), join(directory, "scripts/clean.mjs"));
    await writeFile(join(directory, "dist/game.global.js"), "retired");
    await writeFile(join(directory, "README.md"), "keep");
    execFileSync(process.execPath, [join(directory, "scripts/clean.mjs")]);
    await assert.rejects(access(join(directory, "dist")), { code: "ENOENT" });
    assert.equal(await readFile(join(directory, "README.md"), "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package verifier fails closed on retired artifacts in an otherwise valid package", () => {
  const script = fileURLToPath(new URL("../scripts/verify-package.mjs", import.meta.url));
  const files = ["dist/index.d.ts", "dist/index.js", "dist/game.preload.js", "dist/package.runtime.js", "dist/package-bootstrap-source.js"].map(path => ({ path }));
  const verify = (entries) => spawnSync(process.execPath, [script], {
    input: JSON.stringify([{ files: entries }]), encoding: "utf8",
  });
  const valid = verify(files);
  assert.equal(valid.status, 0, valid.stderr);
  for (const path of ["dist/html.js", "dist/sdk.d.ts", "dist/vue.js.map", "dist/game.global.js", "dist/game.global.js.map"]) {
    const result = verify([...files, { path }]);
    assert.notEqual(result.status, 0, `Verifier accepted ${path}`);
    assert.match(result.stderr, /Retired SDK artifact is still packed/);
  }
});
