import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  SandboxSdkValidationError,
  composeHostPlugins,
  createHostPlugin,
  createSandboxSdk,
  defineMethod,
  defineSandboxPlugin,
} from "../dist/index.js";

function makeEchoPlugin(output = z.object({ value: z.string() })) {
  return defineSandboxPlugin({
    id: "com.example.echo",
    version: "1.0.0",
    methods: {
      echo: defineMethod({
        capability: "com.example.echo",
        input: z.object({ value: z.string() }),
        output,
      }),
    },
  });
}

test("creates a typed-at-build-time SDK with namespaced runtime calls", async () => {
  const plugin = makeEchoPlugin();
  const calls = [];
  const sdk = createSandboxSdk(
    {
      call: async (method, payload) => {
        calls.push({ method, payload });
        return payload;
      },
    },
    { echo: plugin },
  );

  assert.deepEqual(await sdk.echo.echo({ value: "hello" }), { value: "hello" });
  assert.deepEqual(calls, [
    {
      method: "com.example.echo.echo",
      payload: { value: "hello" },
    },
  ]);
});

test("validates plugin input and output at the game-side SDK seam", async () => {
  const plugin = makeEchoPlugin();
  let calls = 0;
  const sdk = createSandboxSdk(
    {
      call: async () => {
        calls += 1;
        return { value: 123 };
      },
    },
    { echo: plugin },
  );

  await assert.rejects(
    sdk.echo.echo({ value: 123 }),
    (error) =>
      error instanceof SandboxSdkValidationError &&
      error.direction === "input" &&
      error.pluginId === "com.example.echo",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    sdk.echo.echo({ value: "hello" }),
    (error) => error instanceof SandboxSdkValidationError && error.direction === "output",
  );
  assert.equal(calls, 1);
});

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

test("rejects thenable SDK method names", () => {
  const plugin = defineSandboxPlugin({
    id: "com.example.thenable",
    version: "1.0.0",
    methods: {
      then: defineMethod({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      }),
    },
  });

  assert.throws(
    () => createSandboxSdk({ call: async () => ({ ok: true }) }, { plugin }),
    /cannot be then/,
  );
});

test("parses plugin input once in the host adapter", async () => {
  let transforms = 0;
  const plugin = defineSandboxPlugin({
    id: "com.example.transform",
    version: "1.0.0",
    methods: {
      echo: defineMethod({
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
