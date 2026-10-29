<script setup lang="ts">
import { ref } from "vue";
import { z } from "zod";
import {
  createSandboxSdk,
  defineMethod,
  defineSandboxPlugin,
  type SandboxCallTransport,
} from "@codemao/browser-game-sandbox";

const echoPlugin = defineSandboxPlugin({
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

const transport: SandboxCallTransport = {
  async call<T>(_method: string, payload: unknown): Promise<T> {
    return payload as T;
  },
};

const sdk = createSandboxSdk(transport, { echo: echoPlugin });
const message = ref("ready");

async function runTypedCall(): Promise<void> {
  const result = await sdk.echo.echo({ value: "vue" });
  message.value = result.value;
}
</script>

<template>
  <button type="button" @click="runTypedCall">Run sandbox call</button>
  <output>{{ message }}</output>
</template>
