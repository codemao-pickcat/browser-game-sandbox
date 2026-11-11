import { z } from "zod";
import {
  composeHostPlugins,
  createHostPlugin,
  defineMethod,
  defineSandboxPlugin,
  renderSandboxGamePreloadScript,
} from "../../src/index.js";
// @ts-expect-error Manual bridge entry is private, not a content-side package API.
import { acceptSandboxBridge } from "../../src/index.js";
// @ts-expect-error SDK constructors have been retired from the public entry.
import { createSandboxSdk } from "../../src/index.js";
// @ts-expect-error The installer is an internal preload implementation.
import { installSandboxGameApi } from "../../src/index.js";
void acceptSandboxBridge;
void createSandboxSdk;
void installSandboxGameApi;

const echoPlugin = defineSandboxPlugin({
  id: "com.example.echo",
  version: "1.0.0",
  methods: {
    echo: defineMethod({
      defaultTimeoutMs: 5000,
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
  gameApi: { echo: "echo" },
});

const hostPlugin = createHostPlugin(echoPlugin, {
  echo: async (input, context) => {
    const hostValue: string = input.value;
    const requestId: string = context.requestId;
    void hostValue;
    void requestId;
    // @ts-expect-error Host input types still come from the plugin schema.
    const invalidValue: number = input.value;
    void invalidValue;
    return input;
  },
});
const defaultMethod = defineMethod({ input: z.string(), output: z.string() });
const filledTimeout: number = defaultMethod.defaultTimeoutMs;
void filledTimeout;
defineMethod({ input: z.string(), output: z.string(), defaultTimeoutMs: undefined });
const rawPlugin = defineSandboxPlugin({
  id: "com.example.defaulttimeout",
  version: "1.0.0",
  methods: {
    echo: { input: z.string(), output: z.string() },
  },
  gameApi: { echo: "echo" },
});
const rawExtensions = composeHostPlugins([createHostPlugin(rawPlugin, { echo: (input) => input })]);
const rawTimeout: number = rawExtensions.gameApi.echo!.defaultTimeoutMs;
void rawTimeout;

const extensions = composeHostPlugins([hostPlugin]);
const timeout: number = extensions.gameApi.echo!.defaultTimeoutMs;
const target: string = extensions.gameApi.echo!.method;
void timeout;
void target;
renderSandboxGamePreloadScript({
  src: "/sandbox/game.preload.js",
  expectedHostOrigin: "https://host.example.test",
  methods: extensions.gameApi,
});
defineSandboxPlugin({
  id: "com.example.invalid",
  version: "1.0.0",
  methods: echoPlugin.methods,
  // @ts-expect-error Native mappings must reference an existing plugin method.
  gameApi: { echo: "missing" },
});
