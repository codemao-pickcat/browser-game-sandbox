import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

const bootstrap = await build({
  entryPoints: ["src/package-bootstrap.ts"], bundle: true, format: "iife",
  globalName: "SandboxPackageBootstrap", platform: "browser", target: ["es2022"],
  minify: true, legalComments: "none", write: false,
});
await writeFile("dist/package-bootstrap-source.js", `export const PACKAGE_BOOTSTRAP_SOURCE = ${JSON.stringify(bootstrap.outputFiles[0].text)};\n`);
await writeFile("dist/package-bootstrap-source.d.ts", "export declare const PACKAGE_BOOTSTRAP_SOURCE: string;\n");

await build({
  entryPoints: ["dist/index.js"], bundle: true, format: "esm",
  outfile: "dist/package.runtime.js", platform: "browser", target: ["es2022"],
  minify: true, sourcemap: true, legalComments: "none",
});

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
