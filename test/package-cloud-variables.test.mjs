import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SandboxCloudVariablesError, SandboxBridgeError, SANDBOX_CLOUD_PAYLOAD_BYTES } from "../dist/index.js";
import { SandboxBridgeClient } from "../dist/client.js";
import { SandboxHostRpcSession } from "../dist/host.js";
import { packageCloudVariablesPlugin } from "../dist/package-cloud-variables.js";
import {
  cloudApplyRequest, cloudApplyResult, cloudGetRequest, cloudGetResult, createCloudGameMethod,
} from "../dist/package-cloud-variables-wire.js";

const requestId = "1724100000000.550e8400-e29b-41d4-a716-446655440000";
const write = { name: "progress", requestId, ifRev: 0 };
const increment = { name: "likes", requestId, op: "increment", arg: { by: 1 } };
const resetAt = "2026-11-20T00:00:00.000Z";
const defaultAdapter = {
  async get() { return { value: null, rev: 0 }; },
  async apply() { return { changed: true, rev: 1 }; },
};

async function connect(adapter = defaultAdapter) {
  const plugins = packageCloudVariablesPlugin(adapter);
  const channel = new MessageChannel(), requests = [], responses = [];
  for (const [port, messages] of [[channel.port1, responses], [channel.port2, requests]]) {
    const post = port.postMessage.bind(port);
    port.postMessage = message => { messages.push(message); post(message); };
  }
  const host = new SandboxHostRpcSession(plugins);
  host.start(); host.attachAuthenticatedPort(channel.port1);
  const client = new SandboxBridgeClient(channel.port2);
  client.sendReady(); await host.connected;
  const { cloudGet, cloudApply } = plugins.gameApi;
  return {
    host, requests, responses,
    get: createCloudGameMethod(client, cloudGet, cloudGetRequest, cloudGetResult),
    apply: createCloudGameMethod(client, cloudApply, cloudApplyRequest, cloudApplyResult),
    rawGet(payload) { return client.call(cloudGet.method, payload); },
    close() { host.terminate(); client.close(); },
  };
}

test("cloud operations carry canonical JSON and forward only the documented arguments", async () => {
  assert.deepEqual(Object.keys(packageCloudVariablesPlugin().gameApi), []);
  const calls = [];
  const result = { items: [{ key: "player-1", value: { score: 42 }, isSelf: true }], nextCursor: null, rev: 1, limitStatus: { daily: { remaining: 2, resetAt } } };
  const adapter = {
    async get(request, signal) { assert.equal(this, adapter); calls.push([request, signal.aborted]); return result; },
    async apply(request, signal) { assert.equal(this, adapter); calls.push([request, signal.aborted]); return { changed: true, rev: 2 }; },
  };
  const bridge = await connect(adapter);
  try {
    const get = { name: "scores", limit: 20, cursor: "opaque", includeLimits: ["daily"] };
    assert.deepEqual(await bridge.get(get), result);
    assert.equal(bridge.requests.find(m => m.type === "request").payload, '{"cursor":"opaque","includeLimits":["daily"],"limit":20,"name":"scores"}');
    assert.equal(typeof bridge.responses.find(m => m.type === "response").payload, "string");
    const writes = [
      { ...write, op: "set", arg: { value: JSON.parse('{"2":0,"10":1,"__proto__":{"safe":true}}') } },
      increment,
      { ...write, op: "append", arg: { value: { score: 42 } } },
      { ...write, op: "replaceAt", arg: { index: 0, value: 0 } },
      { ...write, op: "removeAt", arg: { index: 0 } },
      { ...write, op: "put", arg: { key: "✨", value: null } },
      { ...write, op: "remove", arg: {} },
    ];
    // Capture both functions once when the session starts.
    adapter.apply = async () => { throw new Error("unexpected replacement"); };
    for (const request of writes) assert.deepEqual(await bridge.apply(request), { changed: true, rev: 2 });
    assert.deepEqual(calls, [get, ...writes].map(request => [request, false]));
    assert.match(bridge.requests[2].payload, /"10":1,"2":0,"__proto__":/);
  } finally { bridge.close(); }
});

test("both sides reject invalid shapes, duplicate keys and non-JSON data", async () => {
  const bridge = await connect({ async get() { assert.fail("invalid read reached the adapter"); }, async apply() { assert.fail("invalid write reached the adapter"); } });
  const argument = error => error.code === "INVALID_ARGUMENT";
  try {
    for (const request of [
      undefined, null, [], "{}", { name: "a", playerId: "other" }, { name: "a", url: "/endpoint" },
      { name: "a", self: false }, { name: "a", key: "b", self: true }, { name: "a", key: "b", limit: 32 },
      { name: "a", self: true, cursor: "page" }, { name: "a", key: "😀".repeat(17) },
      { name: "a", key: "\u0000" }, { name: "a", cursor: "\uD800" }, { name: "a", limit: 65 },
      { name: "a", includeLimits: ["daily", "daily"] }, JSON.parse('{"__proto__":{},"name":"a"}'),
    ]) await assert.rejects(bridge.get(request), argument);
    const cycle = {}; cycle.self = cycle;
    for (const request of [
      { ...increment, requestId: "old" }, { ...increment, requestId: `9007199254740992.${requestId.split(".")[1]}` },
      { ...increment, arg: { by: Infinity } }, { ...increment, arg: { by: 2 ** 53 } },
      { ...increment, arg: { by: 1, key: "other" } }, { ...increment, ifRev: -1 },
      { name: "a", op: "set", arg: { value: 1 }, requestId }, { ...write, op: "replaceAt", arg: { index: -1, value: 1 } },
      { ...write, op: "removeAt", arg: { index: 0, value: 1 } }, { ...write, op: "remove", arg: { value: 1 } },
      ...[{}, { value: undefined }, { value: new Date() }, { value: [1, , 2] }, { value: cycle }, { value: { get access() { assert.fail("accessors must not be invoked"); } } }]
        .map(arg => ({ ...write, op: "set", arg })),
    ]) await assert.rejects(bridge.apply(request), argument);
    assert.equal(bridge.requests.filter(m => m.type === "request").length, 0);
    await assert.rejects(bridge.rawGet({ name: "a" }), error => error.code === "INVALID_PAYLOAD");
    for (const payload of ['{"name":"a","name":"b"}', '{"n\\u0061me":"a","name":"b"}', '{ "name":"a"}', '{"name":"a","url":"/api"}']) {
      assert.deepEqual(JSON.parse(await bridge.rawGet(payload)), { error: { code: "INVALID_ARGUMENT" } });
    }
  } finally { bridge.close(); }
});

function fillPayload(template) {
  const budget = SANDBOX_CLOUD_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(template("")));
  return "😀".repeat(Math.floor(budget / 4)) + "x".repeat(budget % 4);
}

test("the full request and page may fill exactly 32,768 UTF-8 bytes despite RPC work limits", async () => {
  const query = cursor => ({ name: "scores", cursor });
  const page = value => ({ rev: 1, items: [value], nextCursor: null });
  const cursor = fillPayload(query), item = fillPayload(page);
  let oversized = false;
  const bridge = await connect({ ...defaultAdapter, async get() { return page(item + (oversized ? "x" : "")); } });
  try {
    assert.deepEqual(await bridge.get(query(cursor)), page(item));
    assert.equal(Buffer.byteLength(bridge.requests.find(m => m.type === "request").payload), SANDBOX_CLOUD_PAYLOAD_BYTES);
    assert.equal(Buffer.byteLength(bridge.responses.find(m => m.type === "response").payload), SANDBOX_CLOUD_PAYLOAD_BYTES);
    await assert.rejects(bridge.get(query(cursor + "x")), error => error.code === "INVALID_ARGUMENT");
    await assert.rejects(bridge.rawGet(JSON.stringify(query(cursor + "x"))), error => error.code === "INVALID_PAYLOAD");
    oversized = true;
    await assert.rejects(bridge.get({ name: "scores" }), error => error.code === "INTERNAL_ERROR");
  } finally { bridge.close(); }
});

test("business codes and a reset time cross the bridge with SDK messages", async () => {
  const bridge = await connect({
    async get() { throw new SandboxBridgeError("SCHEMA_CHANGED", "internal details"); },
    async apply() { throw new SandboxCloudVariablesError("LIMIT_REACHED", resetAt); },
  });
  try {
    await assert.rejects(bridge.get({ name: "likes" }), error => error.code === "SCHEMA_CHANGED" && error.message !== "internal details");
    await assert.rejects(bridge.apply(increment), error => error instanceof SandboxCloudVariablesError && error.code === "LIMIT_REACHED" && error.resetAt === resetAt);
  } finally { bridge.close(); }
  for (const failure of [new Error("secret"), new SandboxBridgeError("UNKNOWN_BUSINESS_ERROR", "secret"), { value: 1, rev: 0, privateData: "secret" }]) {
    const unchecked = await connect({ ...defaultAdapter, async get() {
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    try { await assert.rejects(unchecked.get({ name: "likes" }), error => error.code === "INTERNAL_ERROR" && error.message === "Host method failed"); }
    finally { unchecked.close(); }
  }
});

test("timed out and terminated writes abort the adapter and keep its slot until it settles", async context => {
  let calls = 0;
  let signal, release;
  const bridge = await connect({
    ...defaultAdapter,
    apply(_request, current) {
      calls++; signal = current;
      return new Promise(resolve => { release = resolve; });
    },
  });
  async function waitForCalls(expected) {
    while (calls < expected) await nextTurn();
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = assert.rejects(bridge.apply(increment, { timeoutMs: 30_000 }), error => error.code === "TIMEOUT");
    await waitForCalls(1);
    context.mock.timers.tick(15_000);
    await first;
    assert.equal(signal.aborted, true);
    await assert.rejects(bridge.apply(increment), error => error.code === "RATE_LIMITED");
    assert.equal(calls, 1);
    release({ changed: true, rev: 1 });
    await nextTurn();
    assert.equal(bridge.responses.some(message => message.ok && message.payload === '{"changed":true,"rev":1}'), false);
    const second = assert.rejects(bridge.apply(increment), error => error.code === "BRIDGE_CLOSED");
    await waitForCalls(2);
    bridge.host.terminate();
    await second;
    assert.equal(signal.aborted, true);
    const count = bridge.responses.length;
    release({ changed: true, rev: 2 });
    await nextTurn();
    assert.equal(bridge.responses.length, count);
  } finally { context.mock.timers.reset(); bridge.close(); }
});
