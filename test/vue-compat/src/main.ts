import { createApp } from "vue";
import App from "./App.vue";
import sandboxConfig from "./sandbox.config";
import { createSandboxVuePlugin } from "@codemao-pickcat/browser-game-sandbox/vue";

createApp(App)
  .use(createSandboxVuePlugin(sandboxConfig))
  .mount("#app");
