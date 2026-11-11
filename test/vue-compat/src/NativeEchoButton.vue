<script setup lang="ts">
const emit = defineEmits<{ called: [value: string] }>();

async function callNativeComponentAction(): Promise<void> {
  const result = await window.game.echo({ value: "vue" });
  emit("called", result.value);
}
</script>

<template>
  <button type="button" @click="callNativeComponentAction">Run sandbox call</button>
</template>
