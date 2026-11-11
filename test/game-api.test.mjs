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
  assert.deepEqual({ ...composed.gameApi }, { echo: "com.example.echo.echo" });
  assert.deepEqual(composed.capabilities, []);
  assert.equal(Object.isFrozen(composed.gameApi), true);
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
    methods: { echo: "com.example.echo.echo" },
  });
  assert.match(tag, /^<script src="\/sandbox\/game.preload.js" data-sandbox-config="/);
  assert.match(tag, /&quot;expectedHostOrigin&quot;/);
  assert.match(tag, /><\/script>$/);
  assert.doesNotMatch(tag, /\b(?:async|defer|type=)|<script[^>]*>[^<]+<\/script>/);
  for (const src of ["https://evil.test/a.js", "//evil.test/a.js", "/../evil.js", "/a.js?x=1", '/a\" onload=\"evil.js']) {
    assert.throws(() => renderSandboxGamePreloadScript({ src, expectedHostOrigin: "https://host.example.test", methods: {} }));
  }
  assert.throws(() => renderSandboxGamePreloadScript({ src: "/a.js", expectedHostOrigin: "*", methods: {} }));
});

test("installs window.game synchronously and bounds/cancels calls awaiting the host", async () => {
  const window = disconnectedWindow();
  const game = installSandboxGameApi({
    window, expectedHostOrigin: "https://host.example.test", methods: { echo: "com.example.echo.echo" },
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
  const options = { expectedHostOrigin: "https://host.example.test", methods: { echo: "com.example.echo.echo" }, handshakeTimeoutMs: 10 };
  const occupied = Object.assign(disconnectedWindow(), { game: "existing" });
  assert.throws(() => installSandboxGameApi({ ...options, window: occupied }), /already exists/);
  assert.equal(occupied.game, "existing");
  assert.equal(occupied.listeners.size, 0);
  for (const methods of [{ then: "com.example.echo.echo" }, { echo: "*" }, JSON.parse('{"__proto__":"com.example.echo.echo"}')]) {
    assert.throws(() => installSandboxGameApi({ ...options, window: disconnectedWindow(), methods }));
  }
  const game = installSandboxGameApi({ ...options, window: disconnectedWindow(), maxPayloadBytes: 8 });
  await assert.rejects(game.echo({ value: "way too large" }), { code: "INVALID_PAYLOAD" });
  await assert.rejects(game.echo({}), { code: "TIMEOUT" });
});

test("the standalone preload reads currentScript and needs no developer SDK calls", async () => {
  const bundle = await readFile(new URL("../dist/game.preload.js", import.meta.url), "utf8");
  const window = disconnectedWindow();
  const config = JSON.stringify({ expectedHostOrigin: "https://host.example.test", methods: { echo: "com.example.echo.echo" }, handshakeTimeoutMs: 10 });
  vm.runInNewContext(bundle, {
    window, document: { currentScript: { getAttribute: (name) => name === "data-sandbox-config" ? config : null } },
    TextEncoder, URL, setTimeout, clearTimeout,
  });
  assert.equal(typeof window.game.echo, "function");
  assert.equal(window.CodemaoSandboxGame, undefined);
  await assert.rejects(window.game.echo(null), { code: "TIMEOUT" });
  assert.throws(() => vm.runInNewContext(bundle, { TextEncoder, document: { currentScript: null } }), /preload/i);
});
