import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  composeHostPlugins,
  createHostPlugin,
  defineMethod,
  defineSandboxPlugin,
  renderSandboxGamePreloadScript,
} from "../dist/index.js";
import { installSandboxGameApi } from "../dist/game-api.js";
import { parseSandboxGamePreloadConfig } from "../dist/game-api-config.js";

function bindings(defaultTimeoutMs = 5000) {
  return { echo: { method: "com.example.echo.echo", defaultTimeoutMs } };
}

function plugin(gameApi = { echo: "echo" }) {
  return defineSandboxPlugin({
    id: "com.example.echo",
    version: "1.0.0",
    methods: {
      echo: defineMethod({ input: z.object({ value: z.string() }), output: z.object({ value: z.string() }) }),
    },
    gameApi,
  });
}

function disconnectedWindow() {
  const listeners = new Set();
  return {
    listeners,
    parent: { postMessage() {} },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
  };
}

test("composes explicitly exposed native names without granting capabilities", () => {
  const contract = plugin();
  const composed = composeHostPlugins([createHostPlugin(contract, { echo: (input) => input })]);
  assert.deepEqual({ ...composed.gameApi }, bindings());
  assert.deepEqual(composed.capabilities, []);
  assert.equal(Object.isFrozen(composed.gameApi), true);
  assert.equal(Object.isFrozen(composed.gameApi.echo), true);
  assert.deepEqual(composeHostPlugins([]).gameApi, Object.freeze(Object.create(null)));
});

test("rejects invalid, reserved, missing and colliding native names", () => {
  for (const name of ["then", "constructor", "prototype", "__proto__", "a.b", "a-b"]) {
    assert.throws(() => plugin({ [name]: "echo" }), /game API/i);
  }
  assert.throws(() => plugin({ echo: "missing" }), /game API/i);
  const first = plugin();
  assert.throws(() => composeHostPlugins([{
    contract: { ...first, gameApi: { echo: "toString" } }, handlers: {},
  }]), /Unknown game API method/);
  const second = defineSandboxPlugin({
    id: "com.example.other", version: "1.0.0", methods: first.methods, gameApi: { echo: "echo" },
  });
  assert.throws(() => composeHostPlugins([
    createHostPlugin(first, { echo: (input) => input }),
    createHostPlugin(second, { echo: (input) => input }),
  ]), /Duplicate game API/);
});

test("renders a parser-blocking same-origin preload with escaped data, not inline code", () => {
  const tag = renderSandboxGamePreloadScript({
    src: "/sandbox/game.preload.js",
    expectedHostOrigin: "https://host.example.test",
    methods: bindings(750),
  });
  assert.match(tag, /&quot;defaultTimeoutMs&quot;:750/);
  assert.match(tag, /^<script src="\/sandbox\/game.preload.js" data-sandbox-config="/);
  assert.match(tag, /&quot;expectedHostOrigin&quot;/);
  assert.match(tag, /><\/script>$/);
  assert.doesNotMatch(tag, /\b(?:async|defer|type=)|<script[^>]*>[^<]+<\/script>/);
  for (const src of ["https://evil.test/a.js", "//evil.test/a.js", "/../evil.js", "/a.js?x=1", '/a\" onload=\"evil.js']) {
    assert.throws(() => renderSandboxGamePreloadScript({ src, expectedHostOrigin: "https://host.example.test", methods: {} }));
  }
  assert.throws(() => renderSandboxGamePreloadScript({ src: "/a.js", expectedHostOrigin: "*", methods: {} }));
});

test("requires validated per-method defaults and snapshots nested bindings", () => {
  const base = { expectedHostOrigin: "https://host.example.test" };
  for (const defaultTimeoutMs of [undefined, null, 0, -1, NaN, Infinity, "1000"]) {
    assert.throws(() => parseSandboxGamePreloadConfig({ ...base, methods: {
      echo: { method: "com.example.echo.echo", defaultTimeoutMs },
    } }));
  }
  assert.throws(() => parseSandboxGamePreloadConfig({ ...base, methods: { echo: "com.example.echo.echo" } }));
  assert.throws(() => parseSandboxGamePreloadConfig({ ...base, methods: bindings(), defaultTimeoutMs: 5000 }));
  assert.throws(() => parseSandboxGamePreloadConfig({ ...base, methods: {
    echo: { ...bindings().echo, unknown: true },
  } }));
  const methods = bindings(750);
  const config = parseSandboxGamePreloadConfig({ ...base, methods });
  methods.echo.method = "missing.method";
  methods.echo.defaultTimeoutMs = 1;
  assert.deepEqual({ ...config.methods }, bindings(750));
  assert.equal(Object.isFrozen(config.methods), true);
  assert.equal(Object.isFrozen(config.methods.echo), true);
});

test("uses per-method deadlines and caller overrides while waiting for the handshake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const game = installSandboxGameApi({
    window: disconnectedWindow(), expectedHostOrigin: "https://host.example.test", handshakeTimeoutMs: 1000,
    methods: { short: bindings(20).echo, long: bindings(80).echo },
  });
  const settled = [];
  const watch = (name, promise) => promise.then(
    () => { throw new Error("Unexpected successful call without a host"); },
    (error) => { assert.equal(error.code, "TIMEOUT"); settled.push(name); },
  );
  const short = watch("short", game.short({}));
  const long = watch("long", game.long({}));
  const extended = watch("extended", game.short({}, { timeoutMs: 100 }));
  const shortened = watch("shortened", game.long({}, { timeoutMs: 10 }));
  t.mock.timers.tick(10);
  await shortened;
  assert.deepEqual(settled, ["shortened"]);
  t.mock.timers.tick(10);
  await short;
  assert.deepEqual(settled, ["shortened", "short"]);
  t.mock.timers.tick(60);
  await long;
  assert.deepEqual(settled, ["shortened", "short", "long"]);
  t.mock.timers.tick(20);
  await extended;
  assert.deepEqual(settled, ["shortened", "short", "long", "extended"]);
  t.mock.timers.tick(1000);
});

test("installs window.game synchronously and bounds/cancels calls awaiting the host", async () => {
  const window = disconnectedWindow();
  const game = installSandboxGameApi({
    window, expectedHostOrigin: "https://host.example.test", methods: bindings(),
    handshakeTimeoutMs: 30, maxQueuedCalls: 1,
  });
  assert.equal(window.game, game);
  assert.equal(Object.getPrototypeOf(game), null);
  assert.equal(Object.isFrozen(game), true);
  assert.equal(Object.getOwnPropertyDescriptor(window, "game").writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(window, "game").configurable, false);
  assert.equal(game.then, undefined);
  const controller = new AbortController();
  const waiting = game.echo({ value: "hello" }, { signal: controller.signal });
  await assert.rejects(game.echo({ value: "full" }), { code: "RATE_LIMITED" });
  controller.abort();
  await assert.rejects(waiting, { code: "CANCELLED" });
  await assert.rejects(game.echo({ value: "timeout" }, { timeoutMs: 5 }), { code: "TIMEOUT" });
  await assert.rejects(game.echo({ value: "no host" }), { code: "TIMEOUT" });
  assert.equal(window.listeners.size, 0);
});

test("does not overwrite globals or accept unsafe config and oversized queued payloads", async () => {
  const options = { expectedHostOrigin: "https://host.example.test", methods: bindings(), handshakeTimeoutMs: 10 };
  const occupied = Object.assign(disconnectedWindow(), { game: "existing" });
  assert.throws(() => installSandboxGameApi({ ...options, window: occupied }), /already exists/);
  assert.equal(occupied.game, "existing");
  assert.equal(occupied.listeners.size, 0);
  for (const methods of [{ then: bindings().echo }, { echo: { method: "*", defaultTimeoutMs: 5000 } }, JSON.parse('{"__proto__":{"method":"com.example.echo.echo","defaultTimeoutMs":5000}}')]) {
    assert.throws(() => installSandboxGameApi({ ...options, window: disconnectedWindow(), methods }));
  }
  const game = installSandboxGameApi({ ...options, window: disconnectedWindow(), maxPayloadBytes: 8 });
  await assert.rejects(game.echo({ value: "way too large" }), { code: "INVALID_PAYLOAD" });
  await assert.rejects(game.echo({}), { code: "TIMEOUT" });
});

test("the standalone preload reads currentScript and needs no developer SDK calls", async () => {
  const bundle = await readFile(new URL("../dist/game.preload.js", import.meta.url), "utf8");
  const window = disconnectedWindow();
  const config = JSON.stringify({ expectedHostOrigin: "https://host.example.test", methods: bindings(), handshakeTimeoutMs: 10 });
  vm.runInNewContext(bundle, {
    window, document: { currentScript: { getAttribute: (name) => name === "data-sandbox-config" ? config : null } },
    TextEncoder, URL, setTimeout, clearTimeout,
  });
  assert.equal(typeof window.game.echo, "function");
  assert.equal(window.CodemaoSandboxGame, undefined);
  await assert.rejects(window.game.echo(null), { code: "TIMEOUT" });
  assert.throws(() => vm.runInNewContext(bundle, { TextEncoder, document: { currentScript: null } }), /preload/i);
});
