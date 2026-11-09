import { z } from "zod";
import {
  composeHostPlugins,
  connectSandboxHtmlSdk,
  createHostPlugin,
  createSandboxSdk,
  defineMethod,
  defineSandboxPlugin,
  type SandboxCallTransport,
  type GameWindowLike,
} from "../../src/index.js";

const echoPlugin = defineSandboxPlugin({
  id: "com.example.echo",
  version: "1.0.0",
  methods: {
    echo: defineMethod({
      capability: "com.example.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});

const transport: SandboxCallTransport = {
  async call<T>() {
    return { value: "ok" } as T;
  },
};

const sdk = createSandboxSdk(transport, { echo: echoPlugin });
const result = await sdk.echo.echo({ value: "hello" });
const value: string = result.value;
void value;

// @ts-expect-error The plugin input schema requires a string value.
await sdk.echo.echo({ value: 123 });

const htmlGame = await connectSandboxHtmlSdk({
  window: {} as GameWindowLike,
  expectedHostOrigin: "https://host.example.test",
  plugins: { echo: echoPlugin },
});
const htmlResult = await htmlGame.sdk.echo.echo({ value: "hello" });
const htmlValue: string = htmlResult.value;
void htmlValue;

const hostPlugin = createHostPlugin(echoPlugin, {
  echo: async (input, context) => {
    const hostValue: string = input.value;
    const requestId: string = context.requestId;
    void hostValue;
    void requestId;
    return input;
  },
});
composeHostPlugins([hostPlugin]);
