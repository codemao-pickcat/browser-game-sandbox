import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config.mjs";

export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL("./browser", import.meta.url)),
  use: { ...base.use, channel: "msedge" },
});
