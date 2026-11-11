import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  composeHostPlugins,
  createHostPlugin,
  defineMethod,
  defineSandboxPlugin,
} from "../dist/index.js";

function makeEchoPlugin(output = z.object({ value: z.string() })) {
  return defineSandboxPlugin({
    id: "com.example.echo",
    version: "1.0.0",
    methods: {
      echo: defineMethod({
        defaultTimeoutMs: 5000,
        capability: "com.example.echo",
        input: z.object({ value: z.string() }),
        output,
      }),
    },
  });
}

test("composes a host plugin into the existing host method seam", async () => {
  const plugin = makeEchoPlugin();
  const seen = [];
  const composed = composeHostPlugins([
    createHostPlugin(plugin, {
      echo: async (input, context) => {
        seen.push({ input, context });
        return input;
      },
    }),
  ], {
    grantedCapabilities: ["com.example.echo"],
  });

  assert.deepEqual(composed.capabilities, ["com.example.echo"]);
  const method = composed.methods["com.example.echo.echo"];
  assert.ok(method);
  method.validate({ value: "ok" });
  const result = await method.handler(
    { value: "ok" },
    {
      signal: new AbortController().signal,
      capabilities: composed.capabilities,
      requestId: "request-1",
      methodName: "com.example.echo.echo",
    },
  );

  assert.deepEqual(result, { value: "ok" });
  assert.equal(seen[0].context.pluginId, "com.example.echo");
  assert.equal(seen[0].context.requestId, "request-1");
});

test("parses plugin input once in the host adapter", async () => {
  let transforms = 0;
  const plugin = defineSandboxPlugin({
    id: "com.example.transform",
    version: "1.0.0",
    methods: {
      echo: defineMethod({
        defaultTimeoutMs: 5000,
        input: z.object({ value: z.string() }).transform((value) => {
          transforms += 1;
          return value;
        }),
        output: z.object({ value: z.string() }),
      }),
    },
  });
  const composed = composeHostPlugins([
    createHostPlugin(plugin, { echo: (input) => input }),
  ], { grantedCapabilities: [] });
  const method = composed.methods["com.example.transform.echo"];
  const parsed = await method.parse({ value: "ok" });
  await method.handler(parsed, {
    signal: new AbortController().signal,
    capabilities: [],
    requestId: "request-1",
    methodName: "com.example.transform.echo",
  });

  assert.equal(transforms, 1);
});

test("does not grant plugin capabilities without host approval", () => {
  const plugin = makeEchoPlugin();
  const composed = composeHostPlugins([
    createHostPlugin(plugin, { echo: (input) => input }),
  ]);

  assert.deepEqual(composed.capabilities, []);
});

test("carries plugin method limits into the host adapter", () => {
  const plugin = defineSandboxPlugin({
    id: "com.example.limited",
    version: "1.0.0",
    methods: {
      slow: defineMethod({
        defaultTimeoutMs: 500,
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        limits: {
          maxPayloadBytes: 128,
          maxConcurrent: 2,
          timeoutMs: 1000,
        },
      }),
    },
  });
  const composed = composeHostPlugins([
    createHostPlugin(plugin, { slow: async () => ({ ok: true }) }),
  ]);
  const method = composed.methods["com.example.limited.slow"];
  assert.equal(method.maxPayloadBytes, 128);
  assert.equal(method.maxConcurrent, 2);
  assert.equal(method.timeoutMs, 1000);
});

test("rejects prototype-chain handler fallthrough", () => {
  const plugin = defineSandboxPlugin({
    id: "com.example.prototype",
    version: "1.0.0",
    methods: {
      toString: defineMethod({
        defaultTimeoutMs: 5000,
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      }),
    },
  });

  assert.throws(
    () => composeHostPlugins([createHostPlugin(plugin, {})]),
    /Missing handler/,
  );
});

test("fills omitted method timeouts without mutating the supplied definition", () => {
  for (const definition of [
    { input: z.string(), output: z.string() },
    { input: z.string(), output: z.string(), defaultTimeoutMs: undefined },
  ]) {
    const method = defineMethod(definition);
    assert.equal(method.defaultTimeoutMs, 5000);
    assert.equal(definition.defaultTimeoutMs, undefined);
    const plugin = defineSandboxPlugin({
      id: "com.example.default", version: "1.0.0",
      methods: { echo: definition }, gameApi: { echo: "echo" },
    });
    const composed = composeHostPlugins([createHostPlugin(plugin, { echo: (input) => input })]);
    assert.deepEqual(composed.gameApi.echo, { method: "com.example.default.echo", defaultTimeoutMs: 5000 });
    // Raw JavaScript contracts can bypass both helpers and still get defaults.
    const raw = composeHostPlugins([createHostPlugin({
      ...plugin, methods: { echo: definition },
    }, { echo: (input) => input })]);
    assert.equal(raw.gameApi.echo.defaultTimeoutMs, 5000);
  }
});

test("rejects explicitly invalid plugin method defaults", () => {
  for (const defaultTimeoutMs of [null, 0, -1, NaN, Infinity, -Infinity, "", "1000"]) {
    const method = { input: z.string(), output: z.string(), defaultTimeoutMs };
    assert.throws(() => defineMethod(method), /defaultTimeoutMs/);
    const definition = {
      id: "com.example.timeout", version: "1.0.0", methods: { echo: method },
    };
    assert.throws(() => defineSandboxPlugin(definition), /defaultTimeoutMs/);
    // JavaScript callers can bypass both definition helpers. Composition must
    // also reject invalid defaults, even for methods not exposed on window.game.
    assert.throws(() => composeHostPlugins([createHostPlugin({
      ...definition, bridgeProtocol: 1, capabilities: [],
    }, { echo: (input) => input })]), /defaultTimeoutMs/);
  }
  assert.equal(defineMethod({ input: z.string(), output: z.string(), defaultTimeoutMs: 250 }).defaultTimeoutMs, 250);
});

test("rejects duplicate plugin IDs and duplicate full method names", () => {
  const first = makeEchoPlugin();
  const second = makeEchoPlugin();
  assert.throws(
    () => composeHostPlugins([
      createHostPlugin(first, { echo: () => ({ value: "a" }) }),
      createHostPlugin(second, { echo: () => ({ value: "b" }) }),
    ]),
    /Duplicate plugin ID/,
  );
});
