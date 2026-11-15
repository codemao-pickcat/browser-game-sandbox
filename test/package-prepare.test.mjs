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
    assert.equal(SANDBOX_RUNTIME_VERSION, "0.5.3");
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

test("preload-style hint links are scrubbed from the compiled document", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<link rel="modulepreload" crossorigin href="./assets/app.js"><link rel="Preload" href="assets/app.css" as="style"><link rel="preload" href="assets/missing.onnx" as="fetch"><link rel="preload" as="image" imagesrcset="assets/app.css 1x" onload="void 0"><link rel="prefetch" href="https://cdn.invalid/chunk.js"><link rel="preconnect" href="https://fonts.invalid" crossorigin><link rel="dns-prefetch" href="//remote.invalid"><link rel="stylesheet" href="assets/app.css"><script type="module" src="assets/app.js"></script>',
    "assets/app.js": "export const value = 1; console.log(value);",
    "assets/app.css": "body{margin:0}",
  }));
  const snapshot = snapshotPreparedPackage(prepared);
  const html = snapshot.plan.html.map(part => typeof part === "string" ? part : "[asset]").join("");
  // Hints never survive into the child document: no tag, no Blob materialization.
  assert.doesNotMatch(html, /<(?:link|script)[^>]*(?:preload|prefetch|preconnect|dns-prefetch)/i);
  assert.equal(html.match(/<link/g)?.length, 1);
  assert.match(html, /rel="stylesheet"/);
  assert.deepEqual(snapshot.plan.resources.map(resource => resource.path).sort(), ["assets/app.css", "assets/app.js"]);
});

test("combined rel token lists keep the direct relation and drop only the hint tokens", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<link rel="preload stylesheet" href="a.css"><link rel="STYLESHEET   Prefetch ICON" href="b.css"><link rel="icon preload" href="icon.png"><script>void 0</script>',
    "a.css": "body{margin:0}",
    "b.css": "body{padding:0}",
  }));
  const snapshot = snapshotPreparedPackage(prepared);
  const html = snapshot.plan.html.map(part => typeof part === "string" ? part : "[asset]").join("");
  assert.match(html, /<link rel="stylesheet" href="\[asset\]">/);
  assert.equal(html.match(/<link/g)?.length, 2);
  assert.doesNotMatch(html, /preload|prefetch|icon/i);
  assert.deepEqual(snapshot.plan.resources.map(resource => resource.path).sort(), ["a.css", "b.css"]);
});

test("CDN preload-style hints are scrubbed instead of failing as external dependencies", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<link rel="modulepreload" href="https://remote.invalid/app.js"><link rel="preload" as="font" href="https://fonts.invalid/f.woff2" crossorigin><link rel="preconnect" href="https://fonts.invalid"><script>void 0</script>',
  }));
  const html = snapshotPreparedPackage(prepared).plan.html.map(part => typeof part === "string" ? part : "[asset]").join("");
  assert.equal(html.match(/<link/g), null);
  assert.doesNotMatch(html, /preload|prefetch|preconnect|remote\.invalid|fonts\.invalid/i);
});

test("external URLs in kept links still fail, even when the rel list contains a hint", async () => {
  await assert.rejects(prepareSandboxPackage(await input({
    "index.html": '<link rel="stylesheet preload" href="https://remote.invalid/a.css">',
  })), error => error.code === "EXTERNAL_URL");
});

const compiledHtml = plan => plan.html.map(part => typeof part === "string" ? part : `[${part.asset}]`).join("");

test("inline image URLs are retained in static asset references without synthetic resources", async () => {
  const dataUrl = "data:image/svg+xml,%3Csvg%2F%3E#view";
  const source = {
    "index.html": `<link rel="stylesheet" href="images.css"><body background="${dataUrl}"><img src="${dataUrl}" srcset="${dataUrl} 1x, next.png 2x"><video poster="${dataUrl}"></video><p style="background-image:url(${dataUrl})"></p><script type="module">new URL('${dataUrl}', import.meta.url)</script>`,
    "images.css": `body{background-image:image-set("${dataUrl}" 1x,url(${dataUrl}) 2x)}`,
    "next.png": new Uint8Array([1]),
  };
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input(source))).plan;
  const html = compiledHtml(plan);
  for (const attribute of ["src", "poster", "background"]) assert.ok(html.includes(`${attribute}="${dataUrl}"`));
  assert.ok(html.includes(`srcset="${dataUrl} 1x, [next.png] 2x"`));
  assert.match(html, /style="background-image:url\(/);
  assert.ok(html.includes(`new URL("${dataUrl}")`));
  assert.deepEqual(plan.resources.map(resource => resource.path), ["images.css", "next.png"]);
  assert.deepEqual(plan.resources[0].parts.join("").match(/data:[^"]+/g), [dataUrl, dataUrl]);
});

test("inline asset URL detection follows ASCII URL scheme normalization", async () => {
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input({
    "index.html": '<img src="&#31; D&#9;aTa:image/gif;base64,R0lG&#10;ODlh &#31;">',
  }))).plan;
  assert.ok(compiledHtml(plan).includes("D\taTa:image/gif;base64,R0lG\nODlh"));
  assert.deepEqual(plan.resources, []);
});

test("CSS rewrites local image-set candidates when the function name uses an escape", async () => {
  const dataUrl = "data:image/svg+xml,%3Csvg%2F%3E";
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input({
    "index.html": `<style>body{background-image:image-s\\65t("${dataUrl}" 1x,"local.png" 2x)}</style>`,
    "local.png": new Uint8Array([1]),
  }))).plan;
  const html = compiledHtml(plan);
  assert.ok(html.includes(dataUrl));
  assert.match(html, /"\[local\.png\]"/);
});

test("favicon links are dropped without validating inline, missing, or external targets", async () => {
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input({
    "index.html": '<link rel="icon" href="data:,"><link rel="Icon" href="missing.ico"><link rel="icon" href="https://remote.invalid/favicon.ico">',
  }))).plan;
  assert.doesNotMatch(compiledHtml(plan), /<link/);
  assert.deepEqual(plan.resources, []);
});

test("unsubstituted template literals resolve module, Worker and asset references", async () => {
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input({
    "index.html": '<script type="module">import(`./ch\\u0069ld.js`); new Worker(new URL(`./worker.js`, import.meta.url)); new URL(`./image.png`, import.meta.url)</script>',
    "child.js": "export const name = 'child';",
    "worker.js": "postMessage('ready');",
    "image.png": new Uint8Array([1]),
  }))).plan;
  assert.match(compiledHtml(plan), /import\("sandbox-package:\/child\.js"\)/);
  assert.match(compiledHtml(plan), /new Worker\("\[worker\.js\]"\)/);
  assert.match(compiledHtml(plan), /new URL\("\[image\.png\]"\)/);
  assert.deepEqual(plan.workers.map(resource => resource.path), ["worker.js"]);
});

for (const [script, code] of [
  ['import(`./${name}.js`)', "DYNAMIC_IMPORT"],
  ['new Worker(new URL(`./${name}.js`, import.meta.url))', "DYNAMIC_RESOURCE"],
  ['export * from `./child.js`', "INVALID_JAVASCRIPT"],
]) test(`template resource restrictions still apply: ${script}`, async () => {
  await assert.rejects(prepareSandboxPackage(await input({ "index.html": `<script type="module">${script}</script>` })), { code });
});

test("computed asset URLs stay in document modules and require literals inside Worker graphs", async () => {
  const script = 'const name = "image"; new URL(`./${name}.png`, import.meta.url)';
  const prepared = await prepareSandboxPackage(await input({ "index.html": `<script type="module">${script}</script>` }));
  assert.ok(compiledHtml(snapshotPreparedPackage(prepared).plan).includes(script));
  await assert.rejects(prepareSandboxPackage(await input({
    "index.html": '<script>new Worker("./worker.js")</script>',
    "worker.js": script,
  })), { code: "DYNAMIC_RESOURCE" });
});

test("inline data URLs preserve the enclosing raw HTML elements after literal decoding", async () => {
  const plan = snapshotPreparedPackage(await prepareSandboxPackage(await input({
    "index.html": String.raw`<style>body{background-image:url("data:image/svg+xml,\3c /style>")}</style><script type="module">new URL("data:image/svg+xml,\u003c/script>", import.meta.url)</script>`,
  }))).plan;
  const html = compiledHtml(plan);
  assert.ok(html.includes(String.raw`data:image/svg+xml,\3c /style>`));
  assert.ok(html.includes(String.raw`data:image/svg+xml,\u003c/script>`));
  assert.equal(html.match(/<\/style>/g)?.length, 1);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
});

test("decoded inline data URLs may not contain reserved resource markers", async () => {
  for (const html of [
    String.raw`<style>body{background-image:url("data:image/png,\5f _SANDBOX_PACKAGE_ASSET_0__")}</style>`,
    String.raw`<script type="module">new URL("data:image/png,\u005f_SANDBOX_PACKAGE_ASSET_0__", import.meta.url)</script>`,
  ]) await assert.rejects(prepareSandboxPackage(await input({ "index.html": html })), { code: "RESERVED_TEXT" });
});

test("SVG style declarations accept regular drawing properties and local paint references", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/></defs><path style="fill: url(#paint); stroke-width: 2" stroke="url(#paint)"/><path style="fill:red"/></svg>';
  const prepared = await prepareSandboxPackage(await input({ "index.html": '<img src="paint.svg">', "paint.svg": svg }));
  assert.deepEqual(new TextDecoder().decode(snapshotPreparedPackage(prepared).files["paint.svg"]), svg);
});

for (const style of [
  'fill:url(https://remote.invalid/paint.svg)',
  'fill:url(javascript:void%200)',
  'fill:javascript:0',
  'fill:!important !important',
  'background-image:url(#paint)',
  "cursor:image-set('https://remote.invalid/cursor.png' 1x)",
  String.raw`cursor:image-s\65t('https://remote.invalid/cursor.png' 1x)`,
]) test(`SVG style rejects unsupported CSS: ${style}`, async () => {
  await assert.rejects(prepareSandboxPackage(await input({
    "index.html": '<img src="paint.svg">',
    "paint.svg": `<svg xmlns="http://www.w3.org/2000/svg"><path style="${style}"/></svg>`,
  })), { code: "UNSUPPORTED_SVG" });
});

for (const [name, html] of [
  ["classic script", '<script src="data:text/javascript,void%200"></script>'],
  ["module script", '<script type="module" src="data:text/javascript,export%20{}"></script>'],
  ["static module import", '<script type="module">import "data:text/javascript,export%20{}"</script>'],
  ["re-export", '<script type="module">export * from "data:text/javascript,export%20{}"</script>'],
  ["dynamic module import", '<script type="module">import(`data:text/javascript,export%20{}`)</script>'],
  ["worker", '<script>new Worker("data:text/javascript,void%200")</script>'],
  ["worker URL", '<script type="module">new Worker(new URL(`data:text/javascript,void%200`, import.meta.url))</script>'],
  ["CSS @import string", '<style>@import "data:text/css,body{}";</style>'],
  ["CSS @import URL", '<style>@import url(data:text/css,body{});</style>'],
  ["CSS @import escaped name", String.raw`<style>@im\70ort "data:text/css,body{}";</style>`],
  ["stylesheet link", '<link rel="stylesheet" href="DaTa:text/css,body{}">'],
  ["fetch", '<script>fetch("data:,value")</script>'],
]) test(`rejects an inline data URL with a distinct diagnostic: ${name}`, async () => {
  await assert.rejects(prepareSandboxPackage(await input({ "index.html": html })), { code: "INLINE_RESOURCE" });
});

test("http-equiv pragmas other than refresh are dropped from the document", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta http-equiv="Content-Security-Policy" content="default-src *"><meta charset="utf-8"><p>root</p>',
  }));
  const html = compiledHtml(snapshotPreparedPackage(prepared).plan);
  assert.equal(html.match(/<meta/g)?.length, 1);
  assert.match(html, /charset="utf-8"/);
  assert.doesNotMatch(html, /http-equiv|X-UA-Compatible|Content-Security-Policy/i);
});

test("classic nomodule scripts are removed instead of compiled", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<script nomodule src="legacy.js"></script><script nomodule src="https://remote.invalid/legacy.js"></script><script nomodule src="missing.js"></script><script nomodule>globalThis.__legacy = true</script><script src="classic.js"></script>',
    // Sloppy-only syntax must not fail preparation: nothing can ever load it.
    "legacy.js": "with (Math) { globalThis.p = PI; } globalThis.legacy = document.currentScript;",
    "classic.js": 'window.classic = "kept";',
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.doesNotMatch(html, /nomodule|legacy|missing\.js|remote\.invalid/);
  assert.match(html, /<script src="\[classic\.js\]"><\/script>/);
  assert.deepEqual(plan.resources.map(resource => resource.path), ["classic.js"]);
});

test("a file referenced only by a removed nomodule script stays inert but readable", async () => {
  const sources = {
    "index.html": '<script nomodule src="legacy.js"></script><script src="classic.js"></script>',
    "legacy.js": "with (Math) { globalThis.p = PI; }",
    "classic.js": 'window.classic = "kept";',
  };
  const prepared = await prepareSandboxPackage(await input(sources));
  const snapshot = snapshotPreparedPackage(prepared);
  assert.deepEqual(snapshot.plan.resources.map(resource => resource.path), ["classic.js"]);
  // Only compilation is skipped: the verified bytes remain for package fetch.
  assert.deepEqual(new TextDecoder().decode(snapshot.files["legacy.js"]), sources["legacy.js"]);
});

for (const live of [
  ['module import', '<script nomodule src="legacy.js"></script><script type="module">import "./legacy.js";</script>'],
  ['classic script', '<script nomodule src="legacy.js"></script><script src="legacy.js"></script>'],
  ['literal URL', '<script nomodule src="legacy.js"></script><script type="module">new URL("./legacy.js", import.meta.url);</script>'],
  ['Worker', '<script nomodule src="legacy.js"></script><script>new Worker("legacy.js")</script>'],
]) {
  test(`a nomodule script file with a live reference is still compiled: ${live[0]}`, async () => {
    const prepared = await prepareSandboxPackage(await input({
      "index.html": live[1],
      "legacy.js": "globalThis.legacy = 1;",
    }));
    const plan = snapshotPreparedPackage(prepared).plan;
    assert.deepEqual(plan.resources.map(resource => resource.path), ["legacy.js"]);
    assert.doesNotMatch(compiledHtml(plan), /nomodule/);
  });
}

test("JSON script blocks keep their data when they carry nomodule", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<script type="application/json" nomodule>{"ko":1}</script>',
  }));
  const html = compiledHtml(snapshotPreparedPackage(prepared).plan);
  assert.doesNotMatch(html, /nomodule/);
  assert.match(html, /\{"ko":1\}/);
});

test("module scripts keep running even when they carry nomodule", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<script type="module" nomodule src="app.js"></script><script type="module" nomodule>import "./app.js"; void 0;</script>',
    "app.js": "export const value = 1;",
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.doesNotMatch(html, /nomodule/);
  assert.match(html, /<script type="module" src="\[app\.js\]"><\/script>/);
  assert.match(html, /<script type="module">import "sandbox-package:\/app\.js"/);
  assert.deepEqual(plan.resources.map(resource => resource.path), ["app.js"]);
});

test("inert attributes are deleted while real references keep being rewritten", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<script integrity="sha384-abc" crossorigin src="classic.js"></script><img src="image.png" ping="https://remote.invalid/ping" codebase="https://remote.invalid" archive="https://remote.invalid" srcdoc="https://remote.invalid"><div manifest="https://remote.invalid/cache.appcache"></div>',
    "classic.js": 'window.classic = "kept";',
    "image.png": new Uint8Array([1, 2, 3]),
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.doesNotMatch(html, /integrity|ping|codebase|archive|srcdoc|manifest|remote\.invalid/i);
  assert.match(html, /<script crossorigin="" src="\[classic\.js\]"><\/script>/);
  assert.match(html, /<img src="\[image\.png\]">/);
  assert.deepEqual(plan.html.filter(part => typeof part !== "string").map(part => part.asset), ["classic.js", "image.png"]);
});

test("PWA manifest links are inert: dropped alone, stripped from direct relations", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<link rel="manifest" href="app.webmanifest"><link rel="manifest preload" href="https://remote.invalid/app.webmanifest"><link rel="manifest stylesheet" href="app.css"><script>void 0</script>',
    "app.css": "body{margin:0}",
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.equal(html.match(/<link/g)?.length, 1);
  assert.match(html, /<link rel="stylesheet" href="\[app\.css\]">/);
  assert.doesNotMatch(html, /manifest|remote\.invalid/i);
  assert.deepEqual(plan.resources.map(resource => resource.path), ["app.css"]);
});

test("srcset candidates are rewritten one by one with their descriptors intact", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<img srcset="a.png 1x, , b.png 1.5x , c.png  100w" src="a.png"><link rel="stylesheet" href="app.css" imagesrcset="missing.png 1x"><source srcset="b.png 2x">',
    "a.png": new Uint8Array([1]),
    "b.png": new Uint8Array([2]),
    "c.png": new Uint8Array([3]),
    "app.css": "body{margin:0}",
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.match(html, /srcset="\[a\.png\] 1x, \[b\.png\] 1\.5x , \[c\.png\]  100w"/);
  assert.match(html, /<source srcset="\[b\.png\] 2x">/);
  assert.doesNotMatch(html, /imagesrcset/);
  assert.deepEqual(plan.html.filter(part => typeof part !== "string").map(part => part.asset), ["a.png", "b.png", "c.png", "a.png", "app.css", "b.png"]);
  assert.deepEqual(plan.resources.map(resource => resource.path), ["a.png", "b.png", "c.png", "app.css"]);
});

test("srcset keeps commas that belong to the URL instead of splitting candidates", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<img srcset="assets/a,b.png 1x, a.png 2x"><img srcset="a,b.png,b.png 2x">',
    "assets/a,b.png": new Uint8Array([1]),
    "a.png": new Uint8Array([2]),
    "a,b.png": new Uint8Array([3]),
    "b.png": new Uint8Array([4]),
    "a,b.png,b.png": new Uint8Array([5]),
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  const html = compiledHtml(plan);
  assert.match(html, /srcset="\[assets\/a,b\.png\] 1x, \[a\.png\] 2x"/);
  assert.match(html, /srcset="\[a,b\.png,b\.png\] 2x"/);
  assert.deepEqual(plan.resources.map(resource => resource.path).sort(), ["a,b.png", "a,b.png,b.png", "a.png", "assets/a,b.png", "b.png"]);
});

test("background attributes become package-relative image references", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<body background="bg.png"><img background="bg.png"><table><tr><td background="bg.png"></td></tr></table></body>',
    "bg.png": new Uint8Array([1, 2, 3]),
  }));
  const plan = snapshotPreparedPackage(prepared).plan;
  assert.equal((compiledHtml(plan).match(/background="\[bg\.png\]"/g) ?? []).length, 3);
  assert.deepEqual(plan.html.filter(part => typeof part !== "string").map(part => part.asset), ["bg.png", "bg.png", "bg.png"]);
});

test("anchor and area links pass through untouched because the loader cancels every click", async () => {
  const prepared = await prepareSandboxPackage(await input({
    "index.html": '<a href="page.html">page</a><a href="https://remote.invalid/page">remote</a><a href="#frag">frag</a><area href="assets/template.html"><p id="frag">anchor</p>',
  }));
  const html = compiledHtml(snapshotPreparedPackage(prepared).plan);
  assert.match(html, /<a href="page\.html">page<\/a>/);
  assert.match(html, /<a href="https:\/\/remote\.invalid\/page">remote<\/a>/);
  assert.match(html, /<a href="#frag">frag<\/a>/);
  assert.match(html, /<area href="assets\/template\.html">/);
});

for (const href of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<p>x</p>", "vbscript:msgbox(1)", "JaVa&#9;ScRiPt:alert(1)", "jav&#10;ascript:alert(1)", "&#13;javascript:alert(1)"]) {
  test(`active navigation scheme stays rejected: ${href}`, async () => {
    await assert.rejects(prepareSandboxPackage(await input({
      "index.html": `<a href="${href}">x</a>`,
    })), error => error.code === "UNSUPPORTED_HTML_ELEMENT");
    await assert.rejects(prepareSandboxPackage(await input({
      "index.html": `<area href="${href}">`,
    })), error => error.code === "UNSUPPORTED_HTML_ELEMENT");
  });
}

test("srcset only ends a URL at HTML whitespace, not at every Unicode space", async () => {
  await assert.rejects(prepareSandboxPackage(await input({
    // NBSP is not a srcset separator: the whole string is one package path.
    "index.html": '<img srcset="a.png\u00a01x"><img src="a.png">',
    "a.png": new Uint8Array([1]),
  })), error => error.code === "MISSING_RESOURCE");
});

for (const href of ["mailto:team@example.invalid", "https://remote.invalid/page", "page.html", "#frag"]) {
  test(`inert navigation target stays accepted: ${href}`, async () => {
    const prepared = await prepareSandboxPackage(await input({
      "index.html": `<a href="${href}">x</a>`,
    }));
    assert.match(compiledHtml(snapshotPreparedPackage(prepared).plan), new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });
}

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
  ["SharedWorker", { "index.html": '<script>new SharedWorker("a.js")</script>' }, "UNSUPPORTED_API"],
  ["XMLHttpRequest", { "index.html": '<script>new XMLHttpRequest()</script>' }, "UNSUPPORTED_API"],
  ["importScripts", { "index.html": '<script>importScripts("a.js")</script>' }, "UNSUPPORTED_DYNAMIC_CODE"],
  ["HTML template as classic script", { "index.html": '<script src="assets/template.html"></script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as module", { "index.html": '<script type="module">import "./assets/template.html"</script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as stylesheet", { "index.html": '<link rel="stylesheet" href="assets/template.html">', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template in CSS import", { "index.html": '<style>@import "./assets/template.html";</style>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template as Blob asset", { "index.html": '<script type="module">new URL("./assets/template.html", import.meta.url)</script>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_REFERENCE"],
  ["HTML template iframe", { "index.html": '<iframe src="assets/template.html"></iframe>', "assets/template.html": "<p>template</p>" }, "UNSUPPORTED_HTML_ELEMENT"],
  ["base", { "index.html": '<base href="https://remote.invalid">' }, "UNSUPPORTED_HTML_ELEMENT"],
  ["legacy shortcut icon relation", { "index.html": '<link rel="shortcut icon" href="icon.png">' }, "UNSUPPORTED_HTML_LINK"],
  ["unknown relation token in a combination", { "index.html": '<link rel="preload bookmark" href="a.css">' }, "UNSUPPORTED_HTML_LINK"],
  ["missing relation with href", { "index.html": '<link href="a.css">' }, "UNSUPPORTED_HTML_LINK"],
  ["meta refresh", { "index.html": '<meta http-equiv="refresh" content="0;url=https://remote.invalid">' }, "UNSUPPORTED_HTML_ELEMENT"],
  ["iframe", { "index.html": '<iframe srcdoc="hi"></iframe>' }, "UNSUPPORTED_HTML_ELEMENT"],
  ["unsupported script type", { "index.html": '<script type="text/template"></script>' }, "UNSUPPORTED_HTML_SCRIPT"],
  ["JSON script block with src", { "index.html": '<script type="application/json" src="data.json"></script>', "data.json": "{}" }, "UNSUPPORTED_HTML_SCRIPT"],
  ["form action", { "index.html": '<form action="https://remote.invalid/submit"></form>' }, "UNSUPPORTED_HTML_FORM"],
  ["button formaction", { "index.html": '<form><button formaction="https://remote.invalid"></button></form>' }, "UNSUPPORTED_HTML_FORM"],
  ["external script src", { "index.html": '<script src="https://remote.invalid/a.js"></script>' }, "EXTERNAL_URL"],
  ["external CSS url", { "index.html": '<style>body{background:url(//remote.invalid/a.png)}</style>' }, "EXTERNAL_URL"],
  ["external srcset candidate", { "index.html": '<img srcset="https://remote.invalid/a.png 1x">' }, "EXTERNAL_URL"],
  ["external background", { "index.html": '<body background="https://remote.invalid/a.png">' }, "EXTERNAL_URL"],
  ["module syntax", { "index.html": '<script type="module">export ???</script>' }, "INVALID_JAVASCRIPT"],
  ["CSS cycle", { "index.html": '<link rel="stylesheet" href="a.css">', "a.css": '@import "./b.css";', "b.css": '@import "./a.css";' }, "RESOURCE_CYCLE"],
  ["scripted SVG", { "index.html": '<img src="x.svg">', "x.svg": '<svg><script>alert(1)</script></svg>' }, "UNSUPPORTED_SVG"],
]) test(`rejects unsupported format: ${name}`, async () => {
  await assert.rejects(prepareSandboxPackage(await input(sources)), error => error.code === code);
});

test("fallback files keep exact verified bytes but never enter the automatic Blob plan", async () => {
  const paths=["data.data","model.glb","model.gltf","app.wasm","app.exe","nested.zip","template.htm","js","json","css","html","svg","dir.js/js","dir.json/json","data.","constructor","toString","__proto__","payload.constructor","payload.__proto__"];
  const bytes=new Uint8Array([0xff,0,1,128,42]); // Must not be parsed as text, scripts or HTML.
  const value=await input({"index.html":'<script>fetch("app.wasm");fetch("js");fetch("constructor")</script>',...Object.fromEntries(paths.map(path=>[path,bytes]))});
  const prepared=await prepareSandboxPackage(value);
  const snapshot=snapshotPreparedPackage(prepared);
  assert.equal(snapshot.plan.resources.length,0);
  assert.equal(snapshot.plan.workers.length,0);
  for(const path of paths) { assert.ok(Object.hasOwn(snapshot.files,path));assert.deepEqual(snapshot.files[path],bytes); }
  assert.equal(prepared.totalBytes,Object.values(value.files).reduce((sum,bytes)=>sum+bytes.byteLength,0));
  for(const mutate of [
    v=>{v.manifest.files["app.wasm"].sha256="0".repeat(64);},
    v=>{v.manifest.files["app.wasm"].size++;},
    v=>{delete v.files["app.wasm"];},
    v=>{v.files["extra.data"]=new Uint8Array();},
    v=>{v.manifest.files["app.wasm"].size=SANDBOX_PACKAGE_LIMITS.fileBytes+1;},
  ]) { const changed=structuredClone(value);mutate(changed);await assert.rejects(prepareSandboxPackage(changed)); }
});

test("known JSON/TXT/BIN and other passive formats retain their existing Blob/reference compatibility", async () => {
  const paths=["data.json","data.txt","data.csv","data.xml","data.bin"];
  const html='<script type="module">'+paths.map(path=>`new URL("./${path}",import.meta.url);`).join("")+'</script>'+paths.map(path=>`<img src="${path}">`).join("")+`<style>body{${paths.map((path,i)=>`--asset${i}:url("${path}");`).join("")}}</style>`;
  const prepared=await prepareSandboxPackage(await input({"index.html":html,...Object.fromEntries(paths.map(path=>[path,new Uint8Array([0xff,0,42])]))}));
  const snapshot=snapshotPreparedPackage(prepared);
  assert.deepEqual(snapshot.plan.resources.map(r=>r.path),paths);
  assert.ok(snapshot.plan.resources.every(r=>r.parts===null));
  assert.equal(snapshot.plan.resources.find(r=>r.path==="data.bin").mime,"application/octet-stream");
});

for(const path of ["data.data","model.glb","app.wasm","template.htm","js","json","dir.js/js","payload.constructor","constructor","__proto__"]){
  for(const [kind,html] of [
    ["classic script",`<script src="${path}"></script>`],
    ["module src",`<script type="module" src="${path}"></script>`],
    ["module import",`<script type="module">import "./${path}"</script>`],
    ["dynamic import",`<script type="module">import("./${path}")</script>`],
    ["stylesheet",`<link rel="stylesheet" href="${path}">`],
    ["CSS import",`<style>@import "${path}";</style>`],
    ["HTML attribute",`<img src="${path}">`],
    ["CSS url",`<style>body{background:url("${path}")}</style>`],
    ["CSS image-set string",`<style>body{background:image-set("${path}" 1x)}</style>`],
    ["CSS image-set URL",`<style>body{background:image-set(url("${path}") 1x)}</style>`],
    ["literal URL",`<script type="module">new URL("./${path}",import.meta.url)</script>`],
    ["Worker",`<script>new Worker("${path}")</script>`],
    ["Worker URL",`<script type="module">new Worker(new URL("./${path}",import.meta.url),{type:"module"})</script>`],
  ]) test(`fallback ${path} rejects unsupported reference use: ${kind}`,async()=>{
    await assert.rejects(prepareSandboxPackage(await input({"index.html":html,[path]:""})),error=>error.code==="UNSUPPORTED_REFERENCE");
  });
}

for(const [path,source,code] of [
  ["bad.JS","export ???","INVALID_JAVASCRIPT"],
  ["bad.MJS","export ???","INVALID_JAVASCRIPT"],
  ["bad.CSS","body{color:!important !important}","INVALID_CSS"],
  ["bad.SVG","<svg><script>execute()</script></svg>","UNSUPPORTED_SVG"],
  ["bad.HTML",new Uint8Array([0xff]),"INVALID_ENCODING"],
]) test(`known parser failures do not downgrade to fallback: ${path}`,async()=>{
  await assert.rejects(prepareSandboxPackage(await input({"index.html":"<p>root</p>",[path]:source})),error=>error.code===code);
});

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
  assert.doesNotMatch(policy.contentSecurityPolicy, /wasm-unsafe-eval| 'unsafe-eval'/);
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


test("Worker file admission checks local bytes, module graph and Blob dependencies", async () => {
  const sources={"index.html":'<script>new Worker("workers/main.js", {type:"module"})</script>',"workers/main.js":'import {n} from "./dep.js"; postMessage(n);',"workers/dep.js":'export const n=42;'};
  const prepared=await prepareSandboxPackage(await input(sources));
  const snapshot=snapshotPreparedPackage(prepared);
  assert.equal(snapshot.plan.workers.length,2);
  assert.ok(snapshot.plan.workers.find(r=>r.path==='workers/main.js').parts.some(p=>typeof p!=='string'&&p.worker&&p.asset==='workers/dep.js'));
  for(const [files,code] of [
    [{"index.html":'<script>new Worker("https://external.invalid/x.js")</script>'},'EXTERNAL_URL'],
    [{"index.html":'<script>new Worker("missing.js")</script>'},'MISSING_RESOURCE'],
    [{...sources,"workers/dep.js":'import "./main.js"; export const n=42;'},'RESOURCE_CYCLE'],
    [{...sources,"workers/main.js":'import "not-installed";'},'UNSUPPORTED_MODULE'],
  ]) await assert.rejects(prepareSandboxPackage(await input(files)),error=>error.code===code);
  await prepareSandboxPackage(await input({"index.html":'<script>const source="onmessage=e=>postMessage(e.data)"; const url=URL.createObjectURL(new Blob([source])); new Worker(url);</script>'}));
});
