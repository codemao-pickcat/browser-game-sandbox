import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { z } from "zod";
import {
  SandboxHostSession,
  connectSandboxHtmlSdk,
  defineMethod,
  defineSandboxPlugin,
} from "../dist/index.js";

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

  const plugin = defineSandboxPlugin({
    id: "com.example.echo",
    version: "1.0.0",
    methods: {
      echo: defineMethod({
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
      }),
    },
  });

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

  return { gameWindow, host, plugin };
}

test("connects a plain HTML game to the bridge and typed SDK", async () => {
  const { gameWindow, host, plugin } = createHarness();
  const game = await connectSandboxHtmlSdk({
    window: gameWindow,
    expectedHostOrigin: HOST_ORIGIN,
    plugins: { echo: plugin },
  });

  assert.deepEqual(await game.call("sandbox.ping", {}), { ok: true });
  assert.deepEqual(await game.sdk.echo.echo({ value: "hello" }), { value: "hello" });

  game.close("test complete");
  host.terminate();
});

test("requires a browser window when the HTML adapter is used without injection", async () => {
  await assert.rejects(
    connectSandboxHtmlSdk({ expectedHostOrigin: HOST_ORIGIN }),
    /requires a browser window/,
  );
});

test("publishes a standalone global HTML SDK bundle", async () => {
  const bundle = await readFile(new URL("../dist/game.global.js", import.meta.url), "utf8");
  const context = { TextEncoder };
  vm.runInNewContext(bundle, context);

  assert.equal(typeof context.CodemaoSandboxGame.connectSandboxHtmlSdk, "function");
  assert.equal(typeof context.CodemaoSandboxGame.acceptSandboxBridge, "function");
});
