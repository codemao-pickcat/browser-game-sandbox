import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { packageClipboardPlugin } from "../dist/package-clipboard.js";
import { SandboxHostRpcSession } from "../dist/host.js";
import { SandboxBridgeClient } from "../dist/client.js";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function connect(adapter) {
  const plugins = packageClipboardPlugin(adapter);
  const channel = new MessageChannel(), sent = [];
  const post = channel.port1.postMessage.bind(channel.port1);
  channel.port1.postMessage = message => { sent.push(message); post(message); };
  const host = new SandboxHostRpcSession(plugins);
  host.start(); host.attachAuthenticatedPort(channel.port1);
  const client = new SandboxBridgeClient(channel.port2); client.sendReady(); await host.connected;
  return { plugins, host, client, sent, close() { host.terminate(); client.close(); } };
}
const method = "package.clipboard.readText";

test("clipboard plugin is absent without adapter and declares strict bounded RPC", async () => {
  assert.deepEqual(Object.keys(packageClipboardPlugin().gameApi), []);
  const bridge = await connect({ async readText() { return "hello"; } });
  try {
    const definition = bridge.plugins.methods[method];
    assert.equal(definition.maxConcurrent, 1);
    assert.equal(definition.timeoutMs, 30_000);
    assert.equal(bridge.plugins.gameApi.clipboardReadText.defaultTimeoutMs, 30_000);
    assert.equal(await bridge.client.call(method, {}), "hello");
    for (const payload of [undefined, null, [], "", 1, { key: "text" }, { text: "" }, { signal: null }]) {
      await assert.rejects(bridge.client.call(method, payload), e => e.code === "INVALID_PAYLOAD");
    }
  } finally { bridge.close(); }
});

test("clipboard UTF-8 output is at most 8KiB and adapter exceptions are sanitized", async () => {
  for (const output of ["x".repeat(8192), "😀".repeat(2048), "x".repeat(8193), "😀".repeat(2049), 12, null, new Error("private clipboard secret")]) {
    const adapter = { async readText() { if (output instanceof Error) throw output; return output; } };
    const bridge = await connect(adapter);
    try {
      if (typeof output === "string" && Buffer.byteLength(output) <= 8192) assert.equal(await bridge.client.call(method, {}), output);
      else await assert.rejects(bridge.client.call(method, {}), e => e.code === "INTERNAL_ERROR" && e.message === "Host method failed");
    } finally { bridge.close(); }
  }
});

test("clipboard admits only one in-flight read, binds adapter once, and can read again after completion", async () => {
  const started = deferred(), done = deferred(); let calls = 0;
  const adapter = { async readText(signal) { calls++; assert.equal(signal.aborted, false); started.resolve(); return done.promise; } };
  const bridge = await connect(adapter);
  adapter.readText = async () => { throw new Error("replacement must not run"); };
  try {
    const first = bridge.client.call(method, {}); await started.promise;
    await assert.rejects(bridge.client.call(method, {}), e => e.code === "RATE_LIMITED");
    assert.equal(calls, 1); done.resolve("text"); assert.equal(await first, "text");
    assert.equal(await bridge.client.call(method, {}), "text"); assert.equal(calls, 2);
  } finally { bridge.close(); }
});

test("cancelling clipboard propagates AbortSignal and never sends the late text", async () => {
  const started = deferred(), done = deferred(), aborted = deferred();
  const bridge = await connect({ async readText(signal) { signal.addEventListener("abort", () => aborted.resolve(), { once: true }); started.resolve(); return done.promise; } });
  try {
    const controller = new AbortController();
    const first = bridge.client.call(method, {}, { signal: controller.signal }); await started.promise;
    controller.abort(); await assert.rejects(first, e => e.code === "CANCELLED"); await aborted.promise;
    await assert.rejects(bridge.client.call(method, {}), e => e.code === "RATE_LIMITED");
    done.resolve("late secret"); await nextTurn(); await nextTurn();
    assert.equal(bridge.sent.some(m => m.ok && m.payload === "late secret"), false);
  } finally { bridge.close(); }
});

test("termination aborts clipboard and ignores late completion", async () => {
  const started = deferred(), done = deferred(); let signal;
  const bridge = await connect({ async readText(value) { signal = value; started.resolve(); return done.promise; } });
  try {
    const first = bridge.client.call(method, {}); await started.promise;
    bridge.host.terminate("player stopped");
    await assert.rejects(first, e => e.code === "BRIDGE_CLOSED"); assert.equal(signal.aborted, true);
    const count = bridge.sent.length;
    done.resolve("late secret"); await nextTurn(); await nextTurn();
    assert.equal(bridge.sent.length, count);
  } finally { bridge.close(); }
});

test("30s Host timeout aborts adapter; an uncooperative read cannot overlap its successor", async context => {
  const started = deferred(), done = deferred(); let signal, calls = 0;
  const bridge = await connect({ async readText(value) { calls++; signal = value; started.resolve(); return done.promise; } });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = bridge.client.call(method, {}, { timeoutMs: 60_000 });
    const rejected = assert.rejects(first, e => e.code === "TIMEOUT");
    await started.promise; context.mock.timers.tick(30_000); await rejected;
    assert.equal(signal.aborted, true);
    await assert.rejects(bridge.client.call(method, {}, { timeoutMs: 60_000 }), e => e.code === "INTERNAL_ERROR");
    assert.equal(calls, 1);
    done.resolve("late secret"); await nextTurn(); await nextTurn();
    assert.equal(bridge.sent.some(m => m.ok && m.payload === "late secret"), false);
    assert.equal(await bridge.client.call(method, {}), "late secret"); assert.equal(calls, 2);
  } finally { context.mock.timers.reset(); bridge.close(); }
});
