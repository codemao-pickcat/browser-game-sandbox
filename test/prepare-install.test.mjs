import assert from "node:assert/strict";
import { cp, mkdtemp, symlink, rm, access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("prepare builds all exports from a source checkout without Git metadata", { timeout: 30_000 }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "sandbox-prepare-"));
  try {
    for (const path of ["src", "scripts", "tsconfig.json", "package.json"]) await cp(join(root,path),join(directory,path),{recursive:true});
    await symlink(join(root,"node_modules"),join(directory,"node_modules"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(access(join(directory,".git")));
    const result = spawnSync("npm run prepare", { shell: true, cwd: directory, encoding: "utf8", timeout: 25_000 });
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stdout+result.stderr);
    const pkg=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
    for(const entry of Object.values(pkg.exports).flatMap(value=>typeof value==="string"?[value]:Object.values(value))) await access(join(directory,entry));
    const api=await import(pathToFileURL(join(directory,"dist/index.js")).href);
    assert.equal(api.SANDBOX_RUNTIME_VERSION,pkg.version);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
