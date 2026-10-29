<script setup lang="ts">
import { vuePlugins } from "./sandbox.config";
import { useSandboxReady, useSandboxSdk } from "@codemao-pickcat/browser-game-sandbox/vue";

const sdk = useSandboxSdk<typeof vuePlugins>();
const ready = useSandboxReady<typeof vuePlugins>();
const emit = defineEmits<{ called: [value: string] }>();

async function callNativeComponentAction(): Promise<void> {
  await ready;
  const result = await sdk.value!.echo.echo({ value: "vue" });
  emit("called", result.value);
}
</script>

<template>
  <button type="button" @click="callNativeComponentAction">Run sandbox call</button>
</template>
