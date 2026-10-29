<script setup lang="ts">
import { ref } from "vue";
import NativeEchoButton from "./NativeEchoButton.vue";

const message = ref("ready");
</script>

<template>
  <NativeEchoButton @called="message = $event" />
  <output>{{ message }}</output>
</template>
