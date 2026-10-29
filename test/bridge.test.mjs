import assert from "node:assert/strict";
import test from "node:test";
import {
  SandboxBridgeError,
  SandboxBridgeClient,
  SandboxHostSession,
  acceptSandboxBridge,
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

function createHarness(options = {}) {
  const {
    autoReady = true,
    deliverParentMessages = true,
    ...hostOptions
  } = options;
  const channels = [];
  const hostWindow = new FakeWindow();
  const gameWindow = new FakeWindow();

  const hostTarget = {
    targetOrigins: [],
    postMessage(message, targetOrigin, transfer = []) {
      hostTarget.targetOrigins.push(targetOrigin);
      if (!deliverParentMessages) return;
      hostWindow.dispatch({
        data: message,
        origin: GAME_ORIGIN,
        source: gameTarget,
        ports: transfer,
      });
    },
  };

  const gameTarget = {
    targetOrigins: [],
    postMessage(message, targetOrigin, transfer = []) {
      gameTarget.targetOrigins.push(targetOrigin);
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
    channelFactory: () => {
      const channel = fakeChannelFactory();
      channels.push(channel);
      return channel;
    },
    ...hostOptions,
  });

  host.start();
  const clientPromise = acceptSandboxBridge({
    window: gameWindow,
    expectedHostOrigin: HOST_ORIGIN,
    handshakeTimeoutMs: 250,
    idFactory: (() => {
      let next = 0;
      return () => `req_${++next}`;
    })(),
  });

  if (autoReady) {
    hostTarget.postMessage(
      { type: "sandbox:ready", version: 1 },
      HOST_ORIGIN,
    );
  }

  return {
    host,
    clientPromise,
    hostWindow,
    gameWindow,
    gameTarget,
    hostTarget,
    channels,
  };
}

async function connect(options = {}) {
  const harness = createHarness(options);
  const client = await harness.clientPromise;
  await harness.host.connected;
  return { ...harness, client };
}

test("performs a MessageChannel handshake and serves core calls", async () => {
  const { client, host, gameTarget } = await connect({ capabilities: ["storage.local"] });

  assert.deepEqual(await client.call("sandbox.ping", {}), { ok: true });
  assert.deepEqual(await client.call("sandbox.getCapabilities", {}), {
    capabilities: ["storage.local"],
  });
  assert.deepEqual(await client.call("sandbox.getInfo", {}), {
    protocolVersion: 1,
  });
  assert.deepEqual(gameTarget.targetOrigins, [GAME_ORIGIN]);

  host.terminate("test complete");
});

test("dispatches a validated host extension method", async () => {
  const { client, host } = await connect({
    capabilities: ["test.echo"],
    methods: {
      "test.echo": {
        capability: "test.echo",
        validate(payload) {
          if (!payload || typeof payload !== "object") {
            throw new TypeError("payload must be an object");
          }
        },
        handler: (payload) => payload,
      },
    },
  });

  assert.deepEqual(await client.call("test.echo", { value: 42 }), { value: 42 });
  await assert.rejects(
    client.call("test.echo", "wrong"),
    (error) => error instanceof SandboxBridgeError && error.code === "INVALID_PAYLOAD",
  );

  host.terminate();
});

test("rejects unknown and non-capability methods", async () => {
  const { client, host } = await connect({
    methods: {
      "test.denied": {
        capability: "not-granted",
        handler: () => true,
      },
    },
  });

  await assert.rejects(
    client.call("test.unknown", {}),
    (error) => error instanceof SandboxBridgeError && error.code === "UNKNOWN_METHOD",
  );
  await assert.rejects(
    client.call("test.denied", {}),
    (error) => error instanceof SandboxBridgeError && error.code === "NOT_ALLOWED",
  );

  host.terminate();
});

test("ignores a ready message from the wrong origin or window", async () => {
  const harness = createHarness({ autoReady: false, deliverParentMessages: false });
  harness.host.connected.catch(() => {});
  harness.hostWindow.dispatch({
    data: { type: "sandbox:ready", version: 1 },
    origin: "https://attacker.example.test",
    source: harness.gameTarget,
    ports: [],
  });

  await assert.rejects(
    harness.clientPromise,
    (error) => error instanceof SandboxBridgeError && error.code === "TIMEOUT",
  );
  harness.host.terminate();
});

test("cancels an in-flight call and propagates abort to the host", async () => {
  let hostAborted = false;
  const { client, host } = await connect({
    capabilities: ["test.wait"],
    methods: {
      "test.wait": {
        capability: "test.wait",
        handler: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              hostAborted = true;
              reject(new Error("aborted"));
            });
          }),
      },
    },
  });

  const controller = new AbortController();
  const call = client.call("test.wait", {}, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    call,
    (error) => error instanceof SandboxBridgeError && error.code === "CANCELLED",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostAborted, true);
  host.terminate();
});

test("rejects pending calls when the host terminates", async () => {
  const { client, host } = await connect({
    capabilities: ["test.wait"],
    methods: {
      "test.wait": {
        capability: "test.wait",
        handler: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    },
  });

  const call = client.call("test.wait", {});
  host.terminate("revoked");

  await assert.rejects(
    call,
    (error) => error instanceof SandboxBridgeError && error.code === "BRIDGE_CLOSED",
  );
});

test("enforces request rate limits", async () => {
  const { client, host } = await connect({ maxRequestsPerSecond: 1 });

  await client.call("sandbox.ping", {});
  await assert.rejects(
    client.call("sandbox.ping", {}),
    (error) => error instanceof SandboxBridgeError && error.code === "RATE_LIMITED",
  );

  host.terminate();
});

test("rejects a correct-origin handshake from the wrong window", async () => {
  const harness = createHarness({ autoReady: false, deliverParentMessages: false });
  harness.host.connected.catch(() => {});
  const attackerWindow = {};
  harness.hostWindow.dispatch({
    data: { type: "sandbox:ready", version: 1 },
    origin: GAME_ORIGIN,
    source: attackerWindow,
    ports: [],
  });

  await assert.rejects(
    harness.clientPromise,
    (error) => error instanceof SandboxBridgeError && error.code === "TIMEOUT",
  );
  harness.host.terminate();
});

test("does not replace an established channel after a replayed handshake", async () => {
  const { client, host, hostTarget, channels } = await connect();
  assert.equal(channels.length, 1);

  hostTarget.postMessage(
    { type: "sandbox:ready", version: 1 },
    HOST_ORIGIN,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(channels.length, 1);
  assert.deepEqual(await client.call("sandbox.ping", {}), { ok: true });
  host.terminate();
});

test("ignores malformed requests instead of invoking a host method", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    methods: {
      "test.elevate": {
        handler: () => {
          calls += 1;
          return { elevated: true };
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "missing-payload",
    method: "test.elevate",
  });
  gamePort.postMessage({
    type: "request",
    version: 999,
    id: "wrong-version",
    method: "test.elevate",
    payload: {},
  });
  gamePort.postMessage({
    type: "event",
    version: 1,
    name: "test.elevate",
    payload: {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  host.terminate();
});

test("does not treat a payload field as a capability grant", async () => {
  let calls = 0;
  const { client, host } = await connect({
    methods: {
      "test.elevate": {
        capability: "admin",
        handler: () => {
          calls += 1;
          return { elevated: true };
        },
      },
    },
  });

  await assert.rejects(
    client.call("test.elevate", { capability: "admin" }),
    (error) => error instanceof SandboxBridgeError && error.code === "NOT_ALLOWED",
  );
  assert.equal(calls, 0);
  host.terminate();
});

test("rejects duplicate active request IDs", async () => {
  let calls = 0;
  let release;
  const { host, channels } = await connect({
    capabilities: ["test.wait"],
    methods: {
      "test.wait": {
        capability: "test.wait",
        handler: () => {
          calls += 1;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  const request = {
    type: "request",
    version: 1,
    id: "same-id",
    method: "test.wait",
    payload: {},
  };
  gamePort.postMessage(request);
  await new Promise((resolve) => setImmediate(resolve));
  gamePort.postMessage(request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  release({ done: true });
  await new Promise((resolve) => setImmediate(resolve));
  host.terminate();
});

test("enforces request and response payload limits", async () => {
  let calls = 0;
  const { client, host } = await connect({
    maxPayloadBytes: 64,
    methods: {
      "test.largeResponse": {
        handler: () => {
          calls += 1;
          return "x".repeat(100);
        },
      },
    },
  });

  await assert.rejects(
    client.call("test.largeResponse", {}),
    (error) => error instanceof SandboxBridgeError && error.code === "INVALID_PAYLOAD",
  );
  assert.equal(calls, 1);

  await assert.rejects(
    client.call("sandbox.ping", "x".repeat(100)),
    (error) => error instanceof SandboxBridgeError && error.code === "INVALID_PAYLOAD",
  );
  host.terminate();
});

test("does not expose host method errors to the sandbox", async () => {
  const { client, host } = await connect({
    methods: {
      "test.secret": {
        handler: () => {
          throw new Error("database password=do-not-leak");
        },
      },
    },
  });

  await assert.rejects(
    client.call("test.secret", {}),
    (error) =>
      error instanceof SandboxBridgeError &&
      error.code === "INTERNAL_ERROR" &&
      error.message === "Host method failed" &&
      !error.message.includes("database password"),
  );
  host.terminate();
});

test("terminates an unresponsive handshake", async () => {
  const harness = createHarness({
    autoReady: false,
    deliverParentMessages: false,
    handshakeTimeoutMs: 10,
  });
  harness.host.connected.catch(() => {});
  harness.clientPromise.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(harness.host.state, "terminated");
});

test("ignores requests arriving after termination", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    methods: {
      "test.afterTerminate": {
        handler: () => {
          calls += 1;
          return true;
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  host.terminate();
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "late",
    method: "test.afterTerminate",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("rejects a forged init from the wrong parent window", async () => {
  const harness = createHarness({ autoReady: false, deliverParentMessages: false });
  harness.host.connected.catch(() => {});
  const attacker = {};
  const attackerChannel = fakeChannelFactory();
  harness.gameWindow.dispatch({
    data: {
      type: "sandbox:init",
      version: 1,
      capabilities: [],
      maxPayloadBytes: 1024,
    },
    origin: HOST_ORIGIN,
    source: attacker,
    ports: [attackerChannel.port2],
  });

  await assert.rejects(
    harness.clientPromise,
    (error) => error instanceof SandboxBridgeError && error.code === "TIMEOUT",
  );
  harness.host.terminate();
});

test("rejects a forged init with multiple transferred ports", async () => {
  const harness = createHarness({ autoReady: false, deliverParentMessages: false });
  harness.host.connected.catch(() => {});
  const channelA = fakeChannelFactory();
  const channelB = fakeChannelFactory();
  harness.gameWindow.dispatch({
    data: {
      type: "sandbox:init",
      version: 1,
      capabilities: [],
      maxPayloadBytes: 1024,
    },
    origin: HOST_ORIGIN,
    source: harness.hostTarget,
    ports: [channelA.port2, channelB.port2],
  });

  await assert.rejects(
    harness.clientPromise,
    (error) => error instanceof SandboxBridgeError && error.code === "TIMEOUT",
  );
  harness.host.terminate();
});

test("rejects an init when the transferred port cannot send ready", async () => {
  const harness = createHarness({ autoReady: false, deliverParentMessages: false });
  harness.host.connected.catch(() => {});
  let closed = false;
  const brokenPort = {
    onmessage: null,
    onmessageerror: null,
    postMessage() {
      throw new Error("broken port");
    },
    close() {
      closed = true;
    },
  };
  harness.gameWindow.dispatch({
    data: {
      type: "sandbox:init",
      version: 1,
      capabilities: [],
      maxPayloadBytes: 1024,
    },
    origin: HOST_ORIGIN,
    source: harness.hostTarget,
    ports: [brokenPort],
  });

  await assert.rejects(
    harness.clientPromise,
    (error) => error instanceof SandboxBridgeError && error.code === "BRIDGE_CLOSED",
  );
  assert.equal(closed, true);
  harness.host.terminate();
});

test("counts Map payloads instead of allowing structured-clone size bypass", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    maxPayloadBytes: 32,
    methods: {
      "test.map": {
        handler: () => {
          calls += 1;
          return true;
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "large-map",
    method: "test.map",
    payload: new Map(Array.from({ length: 100 }, (_, index) => [`key-${index}`, "value"])),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 0);
  host.terminate();
});

test("rejects a replay of a completed request ID", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    methods: {
      "test.once": {
        handler: () => {
          calls += 1;
          return { accepted: true };
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  const request = {
    type: "request",
    version: 1,
    id: "replay-me",
    method: "test.once",
    payload: {},
  };
  gamePort.postMessage(request);
  await new Promise((resolve) => setImmediate(resolve));
  gamePort.postMessage(request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  host.terminate();
});

test("caps remembered request IDs to prevent long-session memory growth", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    maxRequestIds: 1,
    methods: {
      "test.once": {
        handler: () => {
          calls += 1;
          return true;
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "id-1",
    method: "test.once",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "id-2",
    method: "test.once",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  host.terminate();
});

test("caps concurrent requests even when handlers never resolve", async () => {
  let calls = 0;
  const { host, channels } = await connect({
    maxConcurrentRequests: 1,
    capabilities: ["test.hang"],
    methods: {
      "test.hang": {
        capability: "test.hang",
        handler: () => {
          calls += 1;
          return new Promise(() => {});
        },
      },
    },
  });

  const gamePort = channels[0].port2;
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "hang-1",
    method: "test.hang",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  gamePort.postMessage({
    type: "request",
    version: 1,
    id: "hang-2",
    method: "test.hang",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  host.terminate();
});

test("sanitizes validator errors", async () => {
  const { client, host } = await connect({
    methods: {
      "test.validate": {
        validate: () => {
          throw new Error("secret path=/internal/credentials");
        },
        handler: () => true,
      },
    },
  });

  await assert.rejects(
    client.call("test.validate", {}),
    (error) =>
      error instanceof SandboxBridgeError &&
      error.code === "INVALID_PAYLOAD" &&
      error.message === "Invalid payload" &&
      !error.message.includes("/internal/credentials"),
  );
  host.terminate();
});

test("closes the client when a termination handler throws", async () => {
  const { client, host } = await connect({
    capabilities: ["test.wait"],
    methods: {
      "test.wait": {
        capability: "test.wait",
        handler: (_payload, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    },
  });
  client.on("sandbox.terminated", () => {
    throw new Error("handler failure");
  });

  const call = client.call("test.wait", {});
  host.terminate("test termination");

  await assert.rejects(
    call,
    (error) => error instanceof SandboxBridgeError && error.code === "BRIDGE_CLOSED",
  );
});

test("closes the client on an oversized inbound event", async () => {
  const { client, host, channels } = await connect({ maxPayloadBytes: 16 });
  channels[0].port1.postMessage({
    type: "event",
    version: 1,
    name: "test.large",
    payload: "x".repeat(100),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => client.call("sandbox.ping", {}),
    (error) => error instanceof SandboxBridgeError && error.code === "BRIDGE_CLOSED",
  );
  host.terminate();
});
