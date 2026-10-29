import { z } from "zod";
import {
  defineMethod,
  defineSandboxPlugin,
  type SandboxCallTransport,
} from "@codemao-pickcat/browser-game-sandbox";
import { defineSandboxVueConfig } from "@codemao-pickcat/browser-game-sandbox/vue";

export const echoPlugin = defineSandboxPlugin({
  id: "com.example.vue",
  version: "1.0.0",
  methods: {
    echo: defineMethod({
      capability: "com.example.vue.echo",
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    }),
  },
});

export const vuePlugins = { echo: echoPlugin };

const transport: SandboxCallTransport = {
  async call<T>(_method: string, payload: unknown): Promise<T> {
    return payload as T;
  },
};

export default defineSandboxVueConfig({
  transport,
  plugins: vuePlugins,
});
