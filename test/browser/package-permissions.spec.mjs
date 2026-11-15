import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

let server, origin;
const received = [];
const host = `<!doctype html><div id="container"></div><script type="module">
import {prepareSandboxPackage,createSandboxPackageSession} from '/runtime.js';
window.launch=async(sources,permissions,worker=false)=>{
  const files=Object.fromEntries(Object.entries(sources).map(([path,text])=>[path,new TextEncoder().encode(text)]));
  const metadata=Object.fromEntries(await Promise.all(Object.entries(files).map(async([path,bytes])=>[path,{size:bytes.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')}])));
  const prepared=await prepareSandboxPackage({manifest:{formatVersion:1,entrypoint:'index.html',files:metadata},files},{worker});
  window.session=createSandboxPackageSession({container:document.querySelector('#container'),package:prepared,permissions,clipboard:window.clipboardAdapter,playerProfile:window.playerProfile});
  await session.ready;
};
window.hostReady=true;
</script>`;
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", request.url === "/runtime.js" ? "text/javascript" : "text/html");
    if (request.url === "/runtime.js") response.end(await readFile(new URL("../../dist/package.runtime.js", import.meta.url)));
    else if (request.url === "/host") response.end(host);
    else { received.push(request.url); response.end(""); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function hostPage(page) { await page.goto(`${origin}/host`); await page.waitForFunction(() => window.hostReady); }
function child(page) { return page.frames().find(frame => frame.parentFrame() === page.mainFrame()); }
const order = ["worker", "wasm", "pointerLock", "eval", "clipboardRead"];
// All probes execute in uploaded source, not DevTools page.evaluate: CSP is
// checked at the actual eval/Function/WASM/Worker execution sites.
const source = `<script type="module">
  const bytes=[0,97,115,109,1,0,0,0];
  const probe=async()=>{
    let evalAllowed=false,functionAllowed=false,wasmAllowed=false;
    try{evalAllowed=eval("40+2")===42;}catch{}
    try{functionAllowed=new Function("return 42")()===42;}catch{}
    try{await WebAssembly.compile(new Uint8Array(bytes));wasmAllowed=true;}catch{}
    return {evalAllowed,functionAllowed,wasmAllowed};
  };
  const workerSource='const bytes='+JSON.stringify(bytes)+';const probe='+probe.toString()+';probe().then(postMessage);';
  const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
  const workerResult=await new Promise(resolve=>{
    let worker;
    try{
      worker=new Worker(url);
      worker.onmessage=e=>{worker.terminate();resolve(e.data);};
      worker.onerror=e=>{e.preventDefault();worker.terminate();resolve("blocked");};
    }catch{resolve("blocked");}
  });
  let parentBlocked=false;try{void parent.document.body;}catch{parentBlocked=true;}
  window.probes={...await probe(),workerResult,origin:location.origin,parentBlocked,clipboard:typeof game.clipboardReadText};
</script>`;

for (const [granted, supplied, hasAvatar] of [
  [false, true, true], [true, false, false], [true, true, false], [true, true, true],
]) {
  test(`player profile requires grant and snapshot (${granted}, ${supplied}, ${hasAvatar})`, async ({ page }) => {
    await hostPage(page);
    await page.evaluate(async ({granted, supplied, hasAvatar}) => {
      if (supplied) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const context = canvas.getContext("2d");
        const image = context.createImageData(canvas.width, canvas.height);
        const pixels = new Uint32Array(image.data.buffer);
        let seed = 42;
        for (let index = 0; index < pixels.length; index++) {
          seed = Math.imul(seed, 1664525) + 1013904223;
          pixels[index] = seed | 0xff000000;
        }
        context.putImageData(image, 0, 0);
        const avatar = hasAvatar ? await new Promise(resolve => canvas.toBlob(resolve)) : null;
        if (avatar && avatar.size <= 64 * 1024) throw new Error("Expected avatar beyond the RPC budget");
        window.playerProfile = {
          playerId: "work-player-1",
          displayName: "PICKCAT player",
          avatar,
        };
      }
      await launch({"index.html": "<img alt='Player'>"}, granted ? ["playerProfile"] : []);
    }, {granted, supplied, hasAvatar});
    const frame = child(page);
    assert.equal(await frame.evaluate(() => typeof game.getPlayerProfile), granted && supplied ? "function" : "undefined");
    if (!granted || !supplied) return;
    const result = await frame.evaluate(async () => {
      const {playerId, displayName, avatar} = await game.getPlayerProfile({});
      if (!avatar) return {playerId, displayName, imageWidth: null};
      const img = document.querySelector("img");
      const url = URL.createObjectURL(avatar);
      try {
        img.src = url;
        await img.decode();
        return {playerId, displayName, imageWidth: img.naturalWidth};
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    assert.deepEqual(result, {playerId: "work-player-1", displayName: "PICKCAT player", imageWidth: hasAvatar ? 256 : null});
  });
}
for (let mask = 0; mask < 32; mask++) {
  const permissions = order.filter((_, i) => mask & (1 << i));
  test(`actual opaque CSP enforces all executors for permission combination ${mask}`, async ({ page }) => {
    await hostPage(page);
    // Host parser worker is explicitly independent of the work's worker grant.
    await page.evaluate(({source,permissions}) => launch({"index.html":source},permissions,true), {source,permissions});
    const result = await child(page).evaluate(() => probes);
    const expected = { evalAllowed:permissions.includes("eval"), functionAllowed:permissions.includes("eval"), wasmAllowed:permissions.includes("wasm") || permissions.includes("eval") };
    assert.deepEqual(result, {...expected,workerResult:permissions.includes("worker")?expected:"blocked",origin:"null",parentBlocked:true,clipboard:"undefined"});
    const attributes = await page.evaluate(() => ({ sandbox:session.iframe.getAttribute("sandbox"), allow:session.iframe.getAttribute("allow") }));
    assert.equal(attributes.sandbox, permissions.includes("pointerLock") ? "allow-scripts allow-pointer-lock" : "allow-scripts");
    // pointer-lock defaults to `*`; the grant delegates it explicitly and the
    // denial still pins the feature to none for a restrictive parent policy.
    assert.equal(attributes.allow, [
      "camera 'none'", "microphone 'none'", "geolocation 'none'", "fullscreen 'none'",
      permissions.includes("pointerLock") ? "pointer-lock" : "pointer-lock 'none'",
      "clipboard-read 'none'", "clipboard-write 'none'",
    ].join("; "));
  });
}

test("omitted permissions disable all optional executors and clipboard, but prepare remains pure", async ({ page }) => {
  await hostPage(page);
  await page.evaluate(source => launch({"index.html":source}), source);
  assert.deepEqual(await child(page).evaluate(() => probes), {evalAllowed:false,functionAllowed:false,wasmAllowed:false,workerResult:"blocked",origin:"null",parentBlocked:true,clipboard:"undefined"});
});

for (const granted of [false, true]) test(`actual pointer lock request with sandbox grant=${granted}`, async ({ page }) => {
  await hostPage(page);
  await page.evaluate(granted => launch({"index.html":`<button id="lock">lock</button><script>
    document.querySelector('#lock').addEventListener('click',async()=>{
      try{await document.body.requestPointerLock();window.lockResult=document.pointerLockElement===document.body;}catch{window.lockResult=false;}
    });
  </script>`},granted?["pointerLock"]:[]), granted);
  const frame = child(page); await frame.locator("#lock").click();
  await expect.poll(() => frame.evaluate(() => window.lockResult)).toBe(granted);
  if (granted) await frame.evaluate(() => document.exitPointerLock());
});

test("eval strings are not rewritten, revalidation accepts them, and network CSP remains effective", async ({ page }) => {
  await hostPage(page);
  const target = `${origin}/eval-network-probe`;
  await page.evaluate(({target}) => launch({"index.html":`<script type="module">
    window.evalResult=eval('new Function("return 42")()');
    window.stringSource=new Function('return "relative-package.js"')();
    const image=new Image();
    window.imageBlocked=await new Promise(resolve=>{image.onerror=()=>resolve(true);image.onload=()=>resolve(false);new Function('image','image.src='+JSON.stringify(${JSON.stringify(target)}))(image);});
  </script>`},["eval"]), {target});
  assert.deepEqual(await child(page).evaluate(() => ({value:evalResult,path:stringSource,blocked:imageBlocked})), {value:42,path:"relative-package.js",blocked:true});
  assert.equal(received.includes("/eval-network-probe"), false);
});

for (const granted of [false, true]) test(`clipboard adapter is only exposed with explicit grant=${granted}`, async ({ page }) => {
  await hostPage(page);
  await page.evaluate(granted => {
    window.readCalls=0;
    window.clipboardAdapter={async readText(signal){readCalls++;window.readSignal=signal;return "host text";}};
    return launch({"index.html":"<p>clipboard</p>"},granted?["clipboardRead"]:[]);
  }, granted);
  const frame = child(page);
  assert.equal(await frame.evaluate(() => typeof game.clipboardReadText), granted ? "function" : "undefined");
  if (granted) {
    assert.equal(await frame.evaluate(() => game.clipboardReadText({})), "host text");
    assert.equal(await frame.evaluate(async () => {try{await game.clipboardReadText({extra:true});}catch(e){return e.code;}}), "INVALID_PAYLOAD");
  }
  assert.equal(await page.evaluate(() => readCalls), granted ? 1 : 0);
});

test("clipboard RPC serializes reads, propagates cancel and drops late reads after stop", async ({ page }) => {
  await hostPage(page);
  await page.evaluate(() => {
    window.readCalls=0;window.aborted=0;
    window.clipboardAdapter={readText(signal){readCalls++;signal.addEventListener('abort',()=>aborted++);return new Promise(resolve=>window.releaseRead=resolve);}};
    return launch({"index.html":"<p>clipboard RPC</p>"},["clipboardRead"]);
  });
  const frame = child(page);
  await frame.evaluate(() => {window.cancel=new AbortController();window.pending=game.clipboardReadText({}, {signal:cancel.signal}).catch(e=>e.code);});
  await expect.poll(() => page.evaluate(() => readCalls)).toBe(1);
  assert.equal(await frame.evaluate(async () => {try{await game.clipboardReadText({});}catch(e){return e.code;}}), "RATE_LIMITED");
  assert.equal(await frame.evaluate(async () => {cancel.abort();return pending;}), "CANCELLED");
  await expect.poll(() => page.evaluate(() => aborted)).toBe(1);
  await page.evaluate(() => releaseRead("discarded after cancellation"));
  await expect.poll(() => frame.evaluate(async () => {
    try {await game.clipboardReadText({extra:true});}catch(e){return e.code;}
  })).toBe("INVALID_PAYLOAD"); // Prior request has released its admission slot.
  await frame.evaluate(() => {window.pending=game.clipboardReadText({}).catch(e=>e.code);});
  await expect.poll(() => page.evaluate(() => readCalls)).toBe(2);
  await page.evaluate(() => session.terminate("player stopped"));
  assert.equal(await page.evaluate(() => aborted), 2);
  await page.evaluate(() => releaseRead("discarded after termination"));
  await expect(page.locator("iframe")).toHaveCount(0);
});
