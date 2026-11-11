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

function createHarness() {
  const hostWindow = new FakeWindow();
  const gameWindow = new FakeWindow();
  const hostTarget = {
    postMessage(message, targetOrigin, transfer = []) {
      assert.equal(targetOrigin, HOST_ORIGIN);
      hostWindow.dispatch({
        data: message,
        origin: GAME_ORIGIN,
        source: gameTarget,
        ports: transfer,
      });
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
    methods: {
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
  const methods = { echo: "com.example.echo.echo" };
  const game = installSandboxGameApi({ window: gameWindow, expectedHostOrigin: HOST_ORIGIN, methods });
  methods.echo = "missing.method";
  const first = game.echo({ value: "first" });
  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await game.echo({ value: "second" }), { value: "second" });
  assert.equal(await Promise.resolve(game), game);
  host.terminate("done");
  await new Promise(setImmediate);
  await assert.rejects(game.echo({ value: "closed" }), { code: "BRIDGE_CLOSED" });
});
