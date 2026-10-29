import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  defineMethod,
  defineSandboxPlugin,
} from "../dist/index.js";
import {
  SANDBOX_BRIDGE_KEY,
  SANDBOX_CONTEXT_KEY,
  SANDBOX_SDK_KEY,
  createSandboxVuePlugin,
  defineSandboxVueConfig,
} from "../dist/vue.js";

const echoPlugin = defineSandboxPlugin({
  id: "com.example.vue.test",
  version: "1.0.0",
  methods: {
    echo: defineMethod({
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});

function createFakeApp() {
  const provided = new Map();
  return {
    provided,
    config: { globalProperties: {} },
    provide(key, value) {
      provided.set(key, value);
    },
  };
}

test("provides a preconfigured SDK to native Vue components", async () => {
  const config = defineSandboxVueConfig({
    plugins: { echo: echoPlugin },
    transport: {
      async call(_method, payload) {
        return payload;
      },
    },
  });
  const plugin = createSandboxVuePlugin(config);
  const app = createFakeApp();

  plugin.install(app);
  const ready = await plugin.context.ready;
  const sdk = plugin.context.sdk.value;

  assert.equal(ready.bridge, null);
  assert.ok(sdk);
  assert.equal(app.provided.get(SANDBOX_CONTEXT_KEY), plugin.context);
  assert.equal(app.provided.get(SANDBOX_BRIDGE_KEY), plugin.context.bridge);
  assert.equal(app.provided.get(SANDBOX_SDK_KEY), plugin.context.sdk);
  assert.equal(app.config.globalProperties.$sandbox, plugin.context);
  assert.deepEqual(await sdk.echo.echo({ value: "vue" }), { value: "vue" });
});
