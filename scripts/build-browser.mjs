import { build } from "esbuild";

await build({
  entryPoints: ["src/game-preload.ts"],
  bundle: true,
  format: "iife",
  outfile: "dist/game.preload.js",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  minify: true,
  legalComments: "none",
});
