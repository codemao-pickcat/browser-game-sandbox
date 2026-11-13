import assert from "node:assert/strict";
import http from "node:http";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

let server, origin, udp, stunPort;
const received = [], stunPackets = [];
const hostHtml = `<!doctype html><div id="container"></div><script type="module">
import { prepareSandboxPackage, createSandboxPackageSession } from '/runtime.js';
window.scopes = new Map(); window.events = []; window.terminated = [];
window.launch = async (sources, scope = 'a') => {
  const files = Object.fromEntries(Object.entries(sources).map(([path, source]) => [path, typeof source === 'string' ? new TextEncoder().encode(source) : new Uint8Array(source)]));
  const metadata = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, bytes]) => [path, { size: bytes.byteLength, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('') }])));
  if(window.shareByHash){
    const byHash=new Map();
    for(const [path,entry] of Object.entries(metadata)){
      if(byHash.has(entry.sha256)) files[path]=byHash.get(entry.sha256);else byHash.set(entry.sha256,files[path]);
    }
    window.sharedInputs=files;
  }
  const prepared = await prepareSandboxPackage({manifest:{formatVersion:1, entrypoint:'index.html', files:metadata}, files});
  window.logicalBytes=prepared.totalBytes;
  if (!scopes.has(scope)) scopes.set(scope, new Map());
  const store = scopes.get(scope); // captured scope, never a mutable current-user lookup
  const adapter = {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
  window.session = createSandboxPackageSession({container:document.querySelector('#container'), package:prepared, storage:adapter, onTerminate:reason => terminated.push(reason)});
  session.connected.then(() => events.push('connected'), () => events.push('connect-error'));
  session.ready.then(() => events.push('ready'), () => events.push('ready-error'));
  await session.ready;
};
window.hostReady = true;
</script>`;

test.beforeAll(async () => {
  udp=dgram.createSocket('udp4');
  udp.on('message',message=>stunPackets.push(message));
  await new Promise(resolve=>udp.bind(0,'127.0.0.1',resolve));stunPort=udp.address().port;
  server = http.createServer(async (request, response) => {
    const path = new URL(request.url, origin).pathname;
    if (path === "/host") { response.setHeader("Content-Type", "text/html"); response.end(hostHtml); }
    else if (path === "/runtime.js") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(new URL("../../dist/package.runtime.js", import.meta.url))); }
    else { received.push(path); response.writeHead(path === "/navigation-observation" ? 200 : 204, {"Content-Type":"text/html"}); response.end(path === "/navigation-observation" ? "<!doctype html><p>navigated</p>" : ""); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server?.close(resolve)); await new Promise(resolve=>udp?.close(resolve)); });

async function open(page, sources, scope = "a") {
  await page.goto(`${origin}/host`);
  await page.waitForFunction(() => window.hostReady);
  await page.evaluate(({ sources, scope }) => window.launch(sources, scope), { sources, scope });
  return page.frames().find(frame => frame.parentFrame() === page.mainFrame());
}
const png = Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=", "base64"));

const font = Array.from(await readFile(new URL("./fixtures/ABeeZee-Regular.ttf", import.meta.url)));
const wav = Buffer.alloc(44 + 8000 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8,4); wav.write("WAVEfmt ",8); wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28);
wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write("data",36); wav.writeUInt32LE(16000,40);
for(let i=0;i<8000;i++) wav.writeInt16LE(Math.round(Math.sin(i/8000*440*2*Math.PI)*1000),44+i*2);
const multi = {
  "index.html": '<!doctype html><html><head><link rel="stylesheet" href="css/main.css?v=1"></head><body><img id="image" src="images/pixel.png?v=1"><audio id="audio" src="audio.wav"></audio><div id="result">pending</div><script src="classic.js?v=1"></script><script type="module" src="js/main.js"></script></body></html>',
  "classic.js": 'window.order=["classic"]; window.firstGameType=typeof game.storageGet; document.addEventListener("DOMContentLoaded", () => window.domReady=true);',
  "js/main.js": 'import { value } from "./child.js"; const dynamic = await import("./dynamic.js"); const data = await (await fetch("data.json")).json(); const img = new Image(); img.src = new URL("../images/pixel.png",import.meta.url).href; await img.decode(); await game.storageSet({key:"save",value:"saved"}); window.local = {value,dynamic:dynamic.value,data,save:await game.storageGet({key:"save"}),image:img.naturalWidth}; order.push("module"); document.querySelector("#result").textContent="complete";',
  "js/child.js": 'export const value=42;',
  "js/dynamic.js": 'export const value="dynamic";',
  "css/main.css": '@import "./child.css"; body { background-image:url(../images/pixel.png) } @font-face { font-family:OfflineTest;src:url(../font.ttf) } body { font-family:OfflineTest }',
  "css/child.css": ':root { --space:7px; } body { margin:var(--space); }',
  "data.json": '{"local":true}',
  "images/pixel.png": png,
  "audio.wav": Array.from(wav),
  "font.ttf": font,
};

test("real opaque runtime loads a multi-file package, ESM, CSS, images, local fetch and storage", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const frame = await open(page, multi);
  assert.deepEqual(await page.evaluate(() => events), ["connected", "ready"]);
  await frame.waitForFunction(() => document.querySelector("#audio").readyState >= 1);
  const result = await frame.evaluate(async () => {
    let parentBlocked=false, localStorageBlocked=false;
    try { void parent.document.body; } catch { parentBlocked=true; }
    try { localStorage.getItem("x"); } catch { localStorageBlocked=true; }
    await document.querySelector("#image").decode();
    await document.fonts.load("16px OfflineTest");
    return { font:document.fonts.check("16px OfflineTest"), duration:document.querySelector("#audio").duration, referrer:document.referrer,origin:location.origin,parentBlocked,localStorageBlocked,firstGameType,order,domReady,local,
      margin:getComputedStyle(document.body).margin, image:document.querySelector("#image").naturalWidth,
      media:document.querySelector("#audio").src.startsWith("blob:null/"),
      frozen:Object.isFrozen(game), prototype:Object.getPrototypeOf(game)===null,
    };
  });
  assert.deepEqual(result, { font:true,duration:1,referrer:"",origin:"null",parentBlocked:true,localStorageBlocked:true,firstGameType:"function",order:["classic","module"],domReady:true,
    local:{value:42,dynamic:"dynamic",data:{local:true},save:"saved",image:1},margin:"7px",image:1,media:true,frozen:true,prototype:true });
  assert.deepEqual(errors, []);
  const errorsRpc = await frame.evaluate(async () => {
    const codes=[];
    for (const payload of [{key:"save",value:2},{key:"save",value:"x",namespace:"other"},{key:"x",value:"x".repeat(16385)}]) {
      try { await game.storageSet(payload); } catch (error) {codes.push(error.code);}
    }
    await game.storageDelete({key:"save"});
    return {codes,value:await game.storageGet({key:"save"})};
  });
  assert.deepEqual(errorsRpc,{codes:["INVALID_PAYLOAD","INVALID_PAYLOAD","INVALID_PAYLOAD"],value:null});
});

test("CSS SVG-view fragments remain quoted, parsed and actually rendered", async ({ page }) => {
  const fragment="#svgView(viewBox(0,0,10,10))";
  const frame=await open(page,{
    "index.html":`<link rel="stylesheet" href="main.css"><style>.probe,#reference{width:20px;height:20px;background-size:20px 20px}#reference{background-color:lime}#style{background-image:url("sprite.svg${fragment}")}</style><div id="sheet" class="probe"></div><div id="inline" class="probe" style='background-image:url("sprite.svg${fragment}")'></div><div id="style" class="probe"></div><div id="imported" class="probe"></div><div id="set-url" class="probe"></div><div id="set-string" class="probe"></div><div id="reference"></div>`,
    "main.css":`@import url("imports/base.css?v=1");#sheet{background-image:url("sprite.svg${fragment}")}#set-url{background-image:image-set(url("sprite.svg${fragment}") 1x)}#set-string{background-image:image-set("sprite.svg${fragment}" 1x)}`,
    "imports/base.css":`#imported{background-image:url("../sprite.svg${fragment}")}`,
    "sprite.svg":'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10" preserveAspectRatio="none"><rect width="10" height="10" fill="lime"/><rect x="10" width="10" height="10" fill="red"/></svg>',
  });
  // Avoid channel-specific iframe-border offsets in element screenshot clips.
  await page.evaluate(()=>{session.iframe.style.border="0";});
  const backgrounds=await frame.evaluate(()=>Object.fromEntries(["sheet","inline","style","imported","set-url","set-string"].map(id=>[id,getComputedStyle(document.getElementById(id)).backgroundImage])));
  for(const [id,background] of Object.entries(backgrounds)) {
    assert.notEqual(background,"none",`${id} declaration must survive CSS parsing`);
    assert.ok(background.includes(fragment),`${id} must retain the SVG-view fragment`);
  }
  await frame.evaluate(async()=>{
    const background=getComputedStyle(document.getElementById("sheet")).backgroundImage;
    const image=new Image();image.src=JSON.parse(background.slice(4,-1));await image.decode();
    await new Promise(resolve=>requestAnimationFrame(resolve));
  });
  const expected=await frame.locator("#reference").screenshot();
  for(const id of Object.keys(backgrounds)) {
    assert.deepEqual(await frame.locator(`#${id}`).screenshot(),expected,`${id} must render the green SVG view, not drop the fragment or declaration`);
  }
});

test("public browser prepare rejects prototype-chain MIME extensions", async ({ page }) => {
  await page.goto(`${origin}/host`);await page.waitForFunction(()=>window.hostReady);
  const result=await page.evaluate(async()=>{
    const codes=[];
    for(const path of ["payload.constructor","payload.__proto__"]){
      try {await launch({"index.html":"<p>root</p>",[path]:[]});codes.push("accepted");}
      catch(error){codes.push(error.code);}
    }
    return {codes,frames:document.querySelectorAll("iframe").length};
  });
  assert.deepEqual(result,{codes:["UNSUPPORTED_FORMAT","UNSUPPORTED_FORMAT"],frames:0});
});

test("runtime local fetch rejects encoded escapes and accepts Unicode plus valid relative dot paths", async ({ page }) => {
  const frame=await open(page,{
    "index.html":'<script type="module" src="scripts/main.js"></script>',
    "scripts/main.js":'import {value} from "./nested/%2e%2e/child.js";window.relativeModule=value;',
    "scripts/child.js":'export const value="in-root module";',
    "secret.txt":"root bytes",
    "资产/数据.txt":"Unicode bytes",
  });
  const result=await frame.evaluate(async()=>{
    const rejected=[];
    for(const path of ["%2e%2e/secret.txt","/%2E./secret.txt","folder/../%2e%2e/secret.txt","bad%2fdir/../secret.txt","%252e%252e/secret.txt"]){
      try {await fetch(path);rejected.push("accepted");}catch(error){rejected.push(error.code);}
    }
    return {rejected,module:relativeModule,unicode:await(await fetch("%E8%B5%84%E4%BA%A7/%E6%95%B0%E6%8D%AE.txt?next=%2f%5c#part")).text(),relative:await(await fetch("folder/%2E%2e/secret.txt")).text()};
  });
  assert.deepEqual(result,{rejected:Array(5).fill("INVALID_PATH"),module:"in-root module",unicode:"Unicode bytes",relative:"root bytes"});
});

test("child revalidates shared manifest rules before accepting chunks and still verifies SHA bytes", async ({ page }) => {
  for(const scenario of ["version","entrypoint","count","sha-type","size","total","bytes"]){
    await page.goto(`${origin}/host`);await page.waitForFunction(()=>window.hostReady);
    const result=await page.evaluate(async scenario=>{
      const Original=window.MessageChannel;let chunks=0,tampered=false;
      window.MessageChannel=class extends Original {
        constructor(){
          super();const post=this.port1.postMessage.bind(this.port1);
          this.port1.postMessage=(message,transfer)=>{
            if(message?.type==="begin"&&scenario!=="bytes"){
              message=structuredClone(message);tampered=true;
              const manifest=message.manifest;
              if(scenario==="version")manifest.formatVersion=2;
              if(scenario==="entrypoint")manifest.entrypoint="other.html";
              if(scenario==="count")for(let i=0;i<2000;i++)manifest.files[`${i}.txt`]={sha256:"0".repeat(64),size:0};
              if(scenario==="sha-type")manifest.files["index.html"].sha256=BigInt("1".repeat(64));
              if(scenario==="size")manifest.files["index.html"].size=25*1024*1024+1;
              if(scenario==="total"){
                manifest.files["a.bin"]={sha256:"0".repeat(64),size:25*1024*1024};
                manifest.files["b.bin"]={sha256:"0".repeat(64),size:25*1024*1024};
              }
            }
            if(message?.type==="chunk"){
              chunks++;
              if(scenario==="bytes"&&!tampered){message.bytes[0]^=1;tampered=true;}
            }
            return post(message,transfer);
          };
        }
      };
      let error;
      try{await launch({"index.html":"<p>verified root</p>"});error="accepted";}catch(reason){error=reason.message;}
      return {error,chunks,tampered,frames:document.querySelectorAll("iframe").length,events};
    },scenario);
    assert.notEqual(result.error,"accepted",scenario);
    assert.equal(result.frames,0,scenario);
    assert.equal(result.events.includes("ready"),false,scenario);
    assert.equal(result.tampered,true,scenario);
    if(scenario==="bytes"){assert.ok(result.chunks>0);assert.match(result.error,/SHA-256 mismatch/);}
    else assert.equal(result.chunks,0,`${scenario} must fail child admission, before allocation/chunk acceptance`);
  }
});

test("native Blob registry rejects appended query while accepting a fragment", async ({ page }) => {
  await page.goto(`${origin}/host`); await page.waitForFunction(() => window.hostReady);
  const result = await page.evaluate(async () => {
    const blobUrl = URL.createObjectURL(new Blob(["native blob bytes"], { type:"text/plain" }));
    try {
      const base = await (await fetch(blobUrl)).text();
      const fragment = await (await fetch(blobUrl + "#view?keep=1")).text();
      let queryRejected = false;
      try { await fetch(blobUrl + "?v=1#view"); } catch { queryRejected = true; }
      return { base, fragment, queryRejected };
    } finally { URL.revokeObjectURL(blobUrl); }
  });
  assert.deepEqual(result,{base:"native blob bytes",fragment:"native blob bytes",queryRejected:true});
});

test("static query references load real HTML/CSS/literal assets and fetch local bytes", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const marker = `query-local-${Date.now()}`;
  const frame = await open(page, {
    "index.html": `<link id="sheet" rel="stylesheet" href="styles/main.css?v=1#style?keep=1"><img id="query-image" src="assets/${marker}.png?v=1#html?keep=1"><script src="classic.js?v=1#classic"></script><script type="module" src="scripts/main.js"></script>`,
    "styles/main.css": `@import "./child.css?theme=1#child";body{background-image:url("../assets/${marker}.png?css=2#css?keep=1")}`,
    "styles/child.css": "body { margin:13px; }",
    "classic.js": "window.classicQueryLoaded=true;",
    "scripts/main.js": `const asset=new URL("../assets/${marker}.png?literal=3#literal?keep=1",import.meta.url);const image=new Image();image.src=asset.href;await image.decode();window.queryRead={literalSearch:asset.search,literalHash:asset.hash,literalWidth:image.naturalWidth,fetchOne:await(await fetch("assets/data.txt?v=1#data")).text(),fetchTwo:await(await fetch("assets/data.txt?v=2")).text(),fetchBlob:await(await fetch(new URL("../assets/data.txt?data=3#bytes",import.meta.url))).text(),template:await(await fetch("assets/template.html?template=1")).text()};`,
    [`assets/${marker}.png`]: png,
    "assets/data.txt": "local query bytes",
    "assets/template.html": "<p>passive query template</p>",
  });
  const result = await frame.evaluate(async () => {
    const image=document.querySelector("#query-image");await image.decode();
    const sheet=new URL(document.querySelector("#sheet").href), htmlImage=new URL(image.src);
    const background=getComputedStyle(document.body).backgroundImage;
    const backgroundUrl=new URL(background.slice(5,-2));
    const cssImage=new Image();cssImage.src=backgroundUrl.href;await cssImage.decode();
    return {...queryRead,classic:classicQueryLoaded,margin:getComputedStyle(document.body).margin,
      stylesheetSearch:sheet.search,stylesheetHash:sheet.hash,htmlSearch:htmlImage.search,htmlHash:htmlImage.hash,htmlWidth:image.naturalWidth,
      cssSearch:backgroundUrl.search,cssHash:backgroundUrl.hash,cssWidth:cssImage.naturalWidth};
  });
  assert.deepEqual(result,{literalSearch:"",literalHash:"#literal?keep=1",literalWidth:1,fetchOne:"local query bytes",fetchTwo:"local query bytes",fetchBlob:"local query bytes",template:"<p>passive query template</p>",classic:true,margin:"13px",stylesheetSearch:"",stylesheetHash:"#style?keep=1",htmlSearch:"",htmlHash:"#html?keep=1",htmlWidth:1,cssSearch:"",cssHash:"#css?keep=1",cssWidth:1});
  assert.deepEqual(errors,[]);
  assert.deepEqual(received.filter(path=>path.includes(marker)),[],"static queries must not fall back to HTTP");
});

test("nested HTML templates can be fetched as exact passive text without insertion or execution", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const marker = `template-passive-${Date.now()}`;
  const template = `<!doctype html>\r\n<meta http-equiv="refresh" content="0;url=${origin}/${marker}"><article id="template-content">模板 __SANDBOX_PACKAGE_ASSET_0__</article><script>window.templateExecuted = true; navigator.sendBeacon("${origin}/${marker}","unexpected");</script><script>not valid JS ???</script>`;
  const frame = await open(page, {
    "index.html": '<main id="root-entry">root entry</main><script type="module">window.templateExecuted=false;const response=await fetch("assets/template.html");window.templateRead={text:await response.text(),type:response.headers.get("content-type"),size:Number(response.headers.get("content-length")),status:response.status};</script>',
    "assets/template.html": template,
    "assets/nested/other.html": "<p>second nested template</p>",
  });
  const actual = await frame.evaluate(async () => {
    const head = await fetch("assets/template.html", { method: "HEAD" });
    return { ...templateRead, executed:templateExecuted, root:document.querySelector("#root-entry")?.textContent,
      inserted:document.querySelector("#template-content") !== null,
      nested:await (await fetch("assets/nested/other.html")).text(),
      headType:head.headers.get("content-type"),headBody:await head.text(),origin:location.origin };
  });
  assert.deepEqual(actual, { text:template,type:"text/html",size:new TextEncoder().encode(template).byteLength,status:200,
    executed:false,root:"root entry",inserted:false,nested:"<p>second nested template</p>",headType:"text/html",headBody:"",origin:"null" });
  assert.deepEqual(await page.evaluate(() => events), ["connected", "ready"]);
  assert.deepEqual(await page.evaluate(() => terminated), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(received.filter(path => path.includes(marker)), [], "template data must not activate network references");
});

test("fragment anchors stay inside srcdoc rather than requesting the parent's fallback URL", async ({ page }) => {
  const frame=await open(page,{"index.html":'<a id="link" href="#target">jump</a><div id="target">target</div>'});
  await frame.locator('#link').click();
  assert.equal(await frame.evaluate(()=>location.hash),'#target');
  assert.equal(await page.locator('iframe').count(),1);
  assert.deepEqual(await page.evaluate(()=>terminated),[]);
});

test("ESM cycles and inline modules evaluate before ready", async ({ page }) => {
  const frame = await open(page, {
    "index.html": '<script type="module">import { read } from "./a.js";window.cycleResult=read();</script>',
    "a.js": 'import { b } from "./b.js";export const a=1;export function read(){return b()}',
    "b.js": 'import { a } from "./a.js";export function b(){return a+1}',
  });
  assert.equal(await frame.evaluate(() => cycleResult),2);
});

test("package bootstrap rejects wrong null-Origin peer/token/origin and accepts one authenticated port only", async ({ page }) => {
  await page.goto(`${origin}/host`); await page.waitForFunction(()=>window.hostReady);
  await page.evaluate(() => {
    const Original=window.MessageChannel;
    window.channelCount=0;
    window.MessageChannel=class extends Original { constructor(){ super();window.channelCount++; } };
    window.blockBootstrap=event=>{
      if(event.isTrusted && event.data?.type==='sandbox:package-bootstrap'){
        window.hello=event.data;event.stopImmediatePropagation();
      }
    };
    window.addEventListener('message',blockBootstrap,true);
    void launch({'index.html':'<p>authenticated</p>'}).catch(()=>{});
  });
  await page.waitForFunction(()=>window.hello);
  const denied = await page.evaluate(async () => {
    const frame=session.iframe;
    for(const data of [
      {origin:'https://wrong.invalid',source:frame.contentWindow,data:hello},
      {origin:'null',source:window,data:hello},
      {origin:'null',source:frame.contentWindow,data:{...hello,token:'0'.repeat(64)}},
    ]) window.dispatchEvent(new MessageEvent('message',data));
    await new Promise(r=>setTimeout(r,50));
    return {channels:channelCount,events:[...events]};
  });
  assert.deepEqual(denied,{channels:0,events:[]});
  // Also exercise the child's trusted-parent/token check. A wrong init from
  // the actual parent must not steal its one bootstrap port.
  const rejectedChildInit = await page.evaluate(async () => {
    const attack=new MessageChannel(),extra=new MessageChannel();let replied=false;attack.port1.onmessage=()=>{replied=true;};
    session.iframe.contentWindow.postMessage({type:'sandbox:package-init',version:1,token:hello.token},'*',[attack.port2,extra.port2]);
    const wrongToken=new MessageChannel();wrongToken.port1.onmessage=()=>{replied=true;};
    session.iframe.contentWindow.postMessage({type:'sandbox:package-init',version:1,token:'0'.repeat(64)},'*',[wrongToken.port2]);
    await new Promise(r=>setTimeout(r,50));attack.port1.close();extra.port1.close();wrongToken.port1.close();return replied;
  });
  assert.equal(rejectedChildInit,false);
  const wrongParentAccepted=await page.evaluate(async()=>{
    let accepted=false;
    const listen=event=>{if(event.data?.type==='wrong-parent-port-replied')accepted=true;};
    window.addEventListener('message',listen);
    const sibling=document.createElement('iframe');
    sibling.srcdoc='<script>const c=new MessageChannel();c.port1.onmessage=()=>parent.postMessage({type:"wrong-parent-port-replied"},"*");parent.frames[0].postMessage('+JSON.stringify({type:'sandbox:package-init',version:1,token:hello.token})+',"*",[c.port2]);<'+ '/script>';
    document.body.append(sibling);await new Promise(r=>setTimeout(r,100));sibling.remove();
    window.removeEventListener('message',listen);return accepted;
  });
  assert.equal(wrongParentAccepted,false);
  await page.evaluate(async () => {
    window.removeEventListener('message',blockBootstrap,true);
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source:session.iframe.contentWindow,data:hello}));
    await session.ready;
    window.beforeReplay=channelCount;
    window.dispatchEvent(new MessageEvent('message',{origin:'null',source:session.iframe.contentWindow,data:hello}));
  });
  assert.equal(await page.evaluate(()=>channelCount===beforeReplay),true);
  assert.deepEqual(await page.evaluate(()=>events),['connected','ready']);
});

test("termination during module initialization rejects ready and cleans the live session", async ({ page }) => {
  await page.goto(`${origin}/host`);await page.waitForFunction(()=>window.hostReady);
  await page.evaluate(()=>{window.startResult=launch({'index.html':'<script type="module">await new Promise(r=>window.unblock=r);</script>'}).then(()=>"ready",()=>"rejected");});
  await expect.poll(()=>page.evaluate(()=>events[0])).toBe('connected');
  await page.evaluate(()=>session.terminate('cancel initialization'));
  assert.equal(await page.evaluate(()=>startResult),'rejected');
  await expect(page.locator('iframe')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(()=>terminated),['cancel initialization']);
});

test("package transport exceeds 64KiB without changing RPC payload limits", async ({ page }) => {
  const frame = await open(page, {
    "index.html": '<script>fetch("large.txt").then(r=>r.text()).then(t=>window.lengthResult=t.length)</script>',
    "large.txt": "x".repeat(700000),
  });
  await expect.poll(() => frame.evaluate(() => window.lengthResult)).toBe(700000);
  assert.equal(await frame.evaluate(async () => { try {await game.storageSet({key:"x",value:"x".repeat(70000)});}catch(e){return e.code;} }), "INVALID_PAYLOAD");
});

test("same-SHA paths share downloader buffers but transport never detaches/retransfers them", async ({ page }) => {
  await page.goto(`${origin}/host`);await page.waitForFunction(()=>window.hostReady);
  await page.evaluate(async () => {
    window.shareByHash=true;
    await launch({"index.html":'<script type="module">window.lengths=await Promise.all(["a.txt","b.txt"].map(async p=>(await(await fetch(p)).text()).length));</script>',"a.txt":"s".repeat(700000),"b.txt":"s".repeat(700000)});
  });
  const frame=page.frames().find(f=>f.parentFrame()===page.mainFrame());
  assert.deepEqual(await frame.evaluate(()=>lengths),[700000,700000]);
  assert.equal(await page.evaluate(()=>sharedInputs['a.txt']===sharedInputs['b.txt']),true);
  assert.equal(await page.evaluate(()=>sharedInputs['a.txt'].byteLength),700000);
  assert.equal(await page.evaluate(()=>logicalBytes>1400000),true);
});

test("connected precedes actual module completion and ready is never iframe load", async ({ page }) => {
  await page.goto(`${origin}/host`); await page.waitForFunction(() => window.hostReady);
  await page.evaluate(() => { void window.launch({"index.html":'<script type="module">await new Promise(r=>window.releaseExecution=r);window.executed=true;</script>'}); });
  await expect.poll(() => page.evaluate(() => events[0])).toBe("connected");
  const frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
  await frame.waitForFunction(() => typeof window.releaseExecution === "function");
  assert.equal(await page.evaluate(() => events.includes("ready")), false);
  await frame.evaluate(() => releaseExecution());
  await expect.poll(() => page.evaluate(() => events.includes("ready"))).toBe(true);
  assert.equal(await frame.evaluate(() => executed), true);
});

test("storage is scoped by host closure, not user input; old session is destroyed", async ({ page }) => {
  const frame = await open(page, {"index.html":"<p>storage</p>"}, "first");
  await frame.evaluate(() => game.storageSet({key:"save",value:"first"}));
  await page.evaluate(() => session.terminate("switch"));
  await page.evaluate(() => window.launch({"index.html":"<p>second</p>"},"second"));
  const second = page.frames().find(f => f.parentFrame() === page.mainFrame());
  assert.equal(await second.evaluate(() => game.storageGet({key:"save"})), null);
  assert.deepEqual(await page.evaluate(() => [...scopes.get("first")]), [["save","first"]]);
  assert.equal(await page.locator("iframe").count(), 1);
  assert.deepEqual(await page.evaluate(() => terminated), ["switch"]);
});

test("dynamic external fetch, sockets, images, beacon and workers hit no real HTTP receiver", async ({ page }) => {
  const frame = await open(page, {"index.html":"<p>offline</p>"});
  const prefix = `/probe-${Date.now()}`;
  const result = await frame.evaluate(async ({ target }) => {
    const failures=[];
    try { await fetch(target+"/fetch"); } catch { failures.push("fetch"); }
    await new Promise(resolve => { const img=new Image();img.onload=resolve;img.onerror=()=>{failures.push("image");resolve();};img.src=target+"/image"; });
    const beacon=navigator.sendBeacon(target+"/beacon","x");
    await new Promise(resolve => {
      try {
        const worker=new Worker(target+"/worker");
        worker.onerror=()=>{failures.push("worker");resolve();};
        worker.onmessage=()=>resolve();
      } catch { failures.push("worker"); resolve(); }
    });
    await new Promise(resolve => { const ws=new WebSocket(target.replace("http:","ws:")+"/socket");ws.onerror=()=>{failures.push("socket");resolve();};setTimeout(resolve,200); });
    return {failures,beacon};
  }, { target:origin+prefix });
  assert.deepEqual(new Set(result.failures), new Set(["fetch","image","worker","socket"]));
  // sendBeacon's boolean reports queuing, not CSP/network delivery.
  assert.equal(typeof result.beacon,"boolean");
  await page.waitForTimeout(100);
  assert.deepEqual(received.filter(path=>path.startsWith(prefix)),[]);
});

test("characterizes the explicitly unguaranteed WebRTC/STUN UDP boundary", async ({ page }) => {
  const frame=await open(page,{"index.html":"<p>WebRTC boundary</p>"});
  const before=stunPackets.length;
  const available=await frame.evaluate(async port=>{
    if(typeof RTCPeerConnection!=="function")return false;
    const peer=new RTCPeerConnection({iceServers:[{urls:`stun:127.0.0.1:${port}`}]});
    peer.createDataChannel('boundary');await peer.setLocalDescription(await peer.createOffer());
    await new Promise(resolve=>setTimeout(resolve,350));peer.close();return true;
  },stunPort);
  const observed=stunPackets.length-before;
  console.log(`Offline profile WebRTC available=${available}; real local STUN UDP datagrams observed=${observed} (not a zero-network guarantee)`);
  // Characterization, not a fake denial assertion: browsers may strengthen
  // their policy in the future. No network interception or API deletion.
  assert.equal(typeof available,'boolean');
});

test("self-navigation terminates reactively (not claimed to prevent initial request)", async ({ page }) => {
  const frame = await open(page,{"index.html":"<p>navigate</p>"});
  await frame.evaluate(url => { location.href=url; },origin+"/navigation-observation").catch(()=>{});
  await expect.poll(()=>page.evaluate(()=>terminated.length)).toBe(1);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("loader failure rejects ready and removes the iframe, rather than fake-ready", async ({ page }) => {
  await page.goto(`${origin}/host`); await page.waitForFunction(()=>window.hostReady);
  const error = await page.evaluate(async () => {
    try { await launch({"index.html":'<script type="module">throw new Error("user init failed")</script>'}); return "ready"; }
    catch(error){return error.message;}
  });
  // Module execution exceptions fire window.error rather than script.error;
  // the runtime must detect them before claiming ready.
  assert.notEqual(error,"ready");
  await expect(page.locator("iframe")).toHaveCount(0);
});


test("dedicated Blob, classic file and module graph Workers run inside the opaque child", async ({ page }) => {
  const frame = await open(page, {
    "index.html": `<script type="module">
      const request = (worker, value) => new Promise((resolve, reject) => {
        worker.onmessage = event => { worker.terminate(); resolve(event.data); };
        worker.onerror = event => reject(new Error("Worker initialization failed: " + event.message));
        worker.postMessage(value, value instanceof ArrayBuffer ? [value] : []);
      });
      const blob = URL.createObjectURL(new Blob(['onmessage = e => postMessage(e.data.byteLength)'], {type:'text/javascript'}));
      const bytes = new ArrayBuffer(16);
      const a = await request(new Worker(blob), bytes);
      const b = await request(new Worker('workers/classic.js'), 7);
      const c = await request(new Worker(new URL('./workers/module.js', import.meta.url), {type:'module'}), 2);
      window.workerResults = {a,b,c,detached:bytes.byteLength};
    </script>`,
    "workers/classic.js": "onmessage = e => postMessage(e.data * 3);",
    "workers/module.js": "import {base} from './base.js'; const {extra} = await import('./extra.js'); self.onmessage = e => postMessage(base + extra + e.data);",
    "workers/base.js": "export const base = 30;",
    "workers/extra.js": "export const extra = 10;",
  });
  assert.deepEqual(await frame.evaluate(() => workerResults), {a:16,b:21,c:42,detached:0});
  assert.equal(await frame.evaluate(() => location.origin), "null");
});

test("Blob Workers inherit network restrictions and are closed with the session", async ({ page }) => {
  const observedWorkers = [];
  page.on('worker', worker => observedWorkers.push(worker));
  const target = `${origin}/worker-network-probe`;
  const frame = await open(page, {"index.html": `<p>Worker host</p>`});
  const source = `onmessage = async () => { let blocked = false; try { await fetch(${JSON.stringify(target)}); } catch { blocked = true; } postMessage({blocked}); };`;
  const result = await frame.evaluate(async source => {
    const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
    window.liveWorker = new Worker(url);
    return await new Promise((resolve, reject) => { liveWorker.onmessage=e=>resolve(e.data);liveWorker.onerror=reject;liveWorker.postMessage(null); });
  }, source);
  assert.deepEqual(result, {blocked:true});
  assert.equal(received.includes('/worker-network-probe'), false);
  assert.equal(observedWorkers.length, 1);
  const closed = new Promise(resolve => observedWorkers[0].once('close', resolve));
  await page.evaluate(() => session.terminate());
  await closed;
  assert.equal(await page.locator('iframe').count(), 0);
});

test("Worker admission rejects remote scripts and bounds live direct Workers", async ({ page }) => {
  const frame = await open(page, {"index.html":"<p>Worker budget</p>"});
  const result = await frame.evaluate(() => {
    let remoteBlocked=false,limitBlocked=false;
    try { new Worker('https://example.invalid/worker.js'); } catch { remoteBlocked=true; }
    const url=URL.createObjectURL(new Blob(['onmessage=()=>{}'],{type:'text/javascript'}));
    const workers=Array.from({length:32},()=>new Worker(url));
    try {new Worker(url);} catch {limitBlocked=true;}
    workers[0].terminate();
    const replacement=new Worker(url);
    replacement.terminate();workers.forEach(worker=>worker.terminate());
    return {remoteBlocked,limitBlocked};
  });
  assert.deepEqual(result,{remoteBlocked:true,limitBlocked:true});
});


test("embedded WebAssembly runs in document and Blob Worker while JavaScript eval stays blocked", async ({ page }) => {
  const frame=await open(page,{"index.html":"<p>WASM</p>"});
  const bytes=[0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,5,1,1,102,0,0,10,6,1,4,0,65,42,11];
  const result=await frame.evaluate(async bytes=>{
    const {instance}=await WebAssembly.instantiate(new Uint8Array(bytes));
    let evalBlocked=false;try { Function('return 1')(); }catch{evalBlocked=true;}
    const source='onmessage=async e=>{const {instance}=await WebAssembly.instantiate(new Uint8Array(e.data)); postMessage(instance.exports.f());}';
    const worker=new Worker(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
    const workerValue=await new Promise((resolve,reject)=>{worker.onmessage=e=>{worker.terminate();resolve(e.data);};worker.onerror=reject;worker.postMessage(bytes);});
    return {documentValue:instance.exports.f(),workerValue,evalBlocked};
  },bytes);
  assert.deepEqual(result,{documentValue:42,workerValue:42,evalBlocked:true});
});
