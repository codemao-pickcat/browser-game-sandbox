import { createApp } from "vue";
import App from "./App.vue";

// The platform preload, not a Vue plugin or content SDK, installs window.game.
createApp(App).mount("#app");
