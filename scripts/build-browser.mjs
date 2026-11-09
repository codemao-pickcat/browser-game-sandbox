import { build } from "esbuild";

await build({
  entryPoints: ["src/html.ts"],
  bundle: true,
  format: "iife",
  globalName: "CodemaoSandboxGame",
  outfile: "dist/game.global.js",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  minify: true,
  legalComments: "none",
});
