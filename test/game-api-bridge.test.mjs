import assert from "node:assert/strict";
import test from "node:test";
import { SandboxHostSession } from "../dist/index.js";
import { installSandboxGameApi } from "../dist/game-api.js";

const HOST_ORIGIN = "https://host.example.test";
const GAME_ORIGIN = "https://game.example.test";

class FakePort {
  onmessage = null;
  onmessageerror = null;
  peer = null;
  closed = false;

  postMessage(message) {
    if (this.closed) throw new Error("Port is closed");
    queueMicrotask(() => {
      if (!this.peer?.closed) this.peer?.onmessage?.({ data: message });
    });
  }

  start() {}

  close() {
    this.closed = true;
  }
}

class FakeWindow {
  listeners = new Set();
  parent = null;

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }

  dispatch(event) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function fakeChannelFactory() {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

function createHarness({ methods, readyDelayMs = 0 } = {}) {
  const hostWindow = new FakeWindow();
  const gameWindow = new FakeWindow();
  const hostTarget = {
    postMessage(message, targetOrigin, transfer = []) {
      assert.equal(targetOrigin, HOST_ORIGIN);
      const deliver = () => hostWindow.dispatch({
        data: message,
        origin: GAME_ORIGIN,
        source: gameTarget,
        ports: transfer,
      });
      if (readyDelayMs > 0) setTimeout(deliver, readyDelayMs);
      else deliver();
    },
  };
  const gameTarget = {
    postMessage(message, targetOrigin, transfer = []) {
      assert.equal(targetOrigin, GAME_ORIGIN);
      gameWindow.dispatch({
        data: message,
        origin: HOST_ORIGIN,
        source: hostTarget,
        ports: transfer,
      });
    },
  };
  gameWindow.parent = hostTarget;

  const host = new SandboxHostSession({
    window: hostWindow,
    iframe: { contentWindow: gameTarget },
    gameOrigin: GAME_ORIGIN,
    channelFactory: fakeChannelFactory,
    methods: methods ?? {
      "com.example.echo.echo": {
        handler: (payload) => payload,
      },
    },
  });
  host.start();

  return { gameWindow, host };
}

test("native methods queue before handshake settlement, snapshot mappings and reject after termination", async () => {
  const { gameWindow, host } = createHarness();
  const methods = { echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 } };
  const game = installSandboxGameApi({ window: gameWindow, expectedHostOrigin: HOST_ORIGIN, methods });
  methods.echo.method = "missing.method";
  methods.echo.defaultTimeoutMs = 1;
  const first = game.echo({ value: "first" });
  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await game.echo({ value: "second" }), { value: "second" });
  assert.equal(await Promise.resolve(game), game);
  host.terminate("done");
  await new Promise(setImmediate);
  await assert.rejects(game.echo({ value: "closed" }), { code: "BRIDGE_CLOSED" });
});

test("connected calls use method defaults and can extend or shorten them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let cancelled = 0;
  const { gameWindow, host } = createHarness({ methods: {
    "com.example.echo.echo": { handler: (payload) => payload },
    "com.example.echo.slow": { handler: (payload, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(payload), 40);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        cancelled += 1;
        reject(new Error("cancelled"));
      }, { once: true });
    }) },
  } });
  t.after(() => host.terminate("done"));
  const game = installSandboxGameApi({
    window: gameWindow, expectedHostOrigin: HOST_ORIGIN,
    methods: {
      echo: { method: "com.example.echo.echo", defaultTimeoutMs: 5000 },
      slow: { method: "com.example.echo.slow", defaultTimeoutMs: 20 },
    },
  });
  await game.echo({});
  const timedOut = assert.rejects(game.slow({ value: "default" }), { code: "TIMEOUT" });
  await new Promise(setImmediate);
  t.mock.timers.tick(20);
  await timedOut;
  await new Promise(setImmediate);
  assert.equal(cancelled, 1);

  const extended = game.slow({ value: "extended" }, { timeoutMs: 100 });
  await new Promise(setImmediate);
  t.mock.timers.tick(40);
  assert.deepEqual(await extended, { value: "extended" });

  const shortened = assert.rejects(game.slow({ value: "shortened" }, { timeoutMs: 10 }), { code: "TIMEOUT" });
  await new Promise(setImmediate);
  t.mock.timers.tick(10);
  await shortened;
  await new Promise(setImmediate);
  assert.equal(cancelled, 2);
});

test("method timeout budgets include time already spent waiting for the handshake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let started = false;
  const { gameWindow, host } = createHarness({ readyDelayMs: 20, methods: {
    "com.example.echo.slow": { handler: () => { started = true; return new Promise(() => {}); } },
  } });
  t.after(() => host.terminate("done"));
  const game = installSandboxGameApi({
    window: gameWindow, expectedHostOrigin: HOST_ORIGIN,
    methods: { slow: { method: "com.example.echo.slow", defaultTimeoutMs: 50 } },
  });
  let settled = false;
  const call = assert.rejects(game.slow({}), { code: "TIMEOUT" }).then(() => { settled = true; });
  t.mock.timers.tick(20);
  await new Promise(setImmediate);
  assert.equal(started, true);
  t.mock.timers.tick(29);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await call;
});
