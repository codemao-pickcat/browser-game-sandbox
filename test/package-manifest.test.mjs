import assert from "node:assert/strict";
import test from "node:test";
import * as publicApi from "../dist/index.js";
import { validatePackageManifest, SANDBOX_PACKAGE_LIMITS as limits } from "../dist/package-format.js";

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const metadata = size => ({sha256:emptyHash,size});
const manifest = () => ({formatVersion:1,entrypoint:"index.html",files:{"index.html":metadata(0)}});

test("shared manifest validator snapshots metadata and charges each logical path", () => {
  const source=manifest();
  const shared=metadata(3);
  source.files["a.txt"]=shared;source.files["b.txt"]=shared;
  const checked=validatePackageManifest(source);
  assert.equal(checked.totalBytes,6);
  assert.deepEqual(checked.paths,["index.html","a.txt","b.txt"]);
  source.files["a.txt"].size=7;
  assert.equal(checked.manifest.files["a.txt"].size,3);
  assert.ok(Object.isFrozen(checked.manifest) && Object.isFrozen(checked.manifest.files) && Object.isFrozen(checked.manifest.files["a.txt"]) && Object.isFrozen(checked.paths));
  assert.equal("validatePackageManifest" in publicApi,false,"metadata seam must remain private to the runtime");
});

test("manifest admits fallback data and prototype-named paths without changing metadata or budgets", () => {
  const paths=["index.html","js","json","dir.js/data","model.glb","model.gltf","app.wasm","app.exe","nested.zip","template.htm","constructor","toString","__proto__","payload.constructor"];
  const value={formatVersion:1,entrypoint:"index.html",files:Object.fromEntries(paths.map(path=>[path,metadata(3)]))};
  const checked=validatePackageManifest(value);
  assert.deepEqual(checked.paths,paths);
  assert.equal(checked.totalBytes,paths.length*3);
  assert.equal(Object.getPrototypeOf(checked.manifest.files),null);
  for(const path of paths) assert.deepEqual(checked.manifest.files[path],metadata(3));
  assert.equal("knownResourceMime" in publicApi,false,"classification must stay internal, not a new public policy");
});

for (const [name, mutate, code] of [
  ["format version",m=>{m.formatVersion=2;},"INVALID_MANIFEST"],
  ["entrypoint",m=>{m.entrypoint="other.html";},"INVALID_MANIFEST"],
  ["files record",m=>{m.files=null;},"INVALID_MANIFEST"],
  ["files array",m=>{m.files=[];},"INVALID_MANIFEST"],
  ["root file",m=>{delete m.files["index.html"];},"INVALID_MANIFEST"],
  ["file count",m=>{for(let i=0;i<limits.files;i++)m.files[`${i}.txt`]=metadata(0);},"INVALID_MANIFEST"],
  ["canonical path",m=>{m.files["../bad.txt"]=metadata(0);},"INVALID_PATH"],
  ["UTF-8 path bytes",m=>{m.files["汉".repeat(171)+".txt"]=metadata(0);},"INVALID_PATH"],
  ["metadata object",m=>{m.files["index.html"]=null;},"INVALID_MANIFEST"],
  ["metadata array",m=>{m.files["index.html"]=[];},"INVALID_MANIFEST"],
  ["SHA format",m=>{m.files["index.html"].sha256="A".repeat(64);},"INVALID_MANIFEST"],
  ["SHA string type",m=>{m.files["index.html"].sha256=BigInt("1".repeat(64));},"INVALID_MANIFEST"],
  ["negative size",m=>{m.files["index.html"].size=-1;},"INVALID_MANIFEST"],
  ["fractional size",m=>{m.files["index.html"].size=0.5;},"INVALID_MANIFEST"],
  ["string size",m=>{m.files["index.html"].size="0";},"INVALID_MANIFEST"],
  ["unsafe size",m=>{m.files["index.html"].size=Number.MAX_SAFE_INTEGER+1;},"INVALID_MANIFEST"],
  ["per-file budget",m=>{m.files["index.html"].size=limits.fileBytes+1;},"INVALID_MANIFEST"],
  ["total budget",m=>{m.files["a.bin"]=metadata(limits.fileBytes);m.files["b.bin"]=metadata(limits.fileBytes);m.files["c.bin"]=metadata(1);},"PACKAGE_TOO_LARGE"],
]) test(`pure validator and public prepare share ${name} rejection`, async () => {
  const value=manifest();mutate(value);
  assert.throws(()=>validatePackageManifest(value),error=>error.code===code);
  await assert.rejects(publicApi.prepareSandboxPackage({manifest:value,files:{"index.html":new Uint8Array()}}),error=>error.code===code);
});

test("shared metadata budget accepts exact product limits without reading file bytes", () => {
  const value=manifest();
  value.files["a.bin"]=metadata(limits.fileBytes);value.files["b.bin"]=metadata(limits.fileBytes);
  assert.equal(validatePackageManifest(value).totalBytes,limits.totalBytes);
  const many=manifest();for(let i=0;i<limits.files-1;i++)many.files[`${i}.txt`]=metadata(0);
  assert.equal(validatePackageManifest(many).paths.length,limits.files);
});
