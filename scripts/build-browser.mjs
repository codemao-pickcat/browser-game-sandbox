import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const systemJsLicense = await readFile(new URL("../node_modules/systemjs/LICENSE", import.meta.url), "utf8");
const systemJsSource = (await readFile(new URL(import.meta.resolve("systemjs/dist/system.min.js")), "utf8"))
  .replace(/^\/\/# sourceMappingURL=.*$/m, "");
await writeFile("dist/systemjs-LICENSE.txt", systemJsLicense);
await writeFile("dist/package-systemjs-source.js", `export const PACKAGE_SYSTEMJS_SOURCE = ${JSON.stringify(`/*\n${systemJsLicense}\n*/\n${systemJsSource}`)};\n`);

const preparation = await build({
  entryPoints: ["src/package-prepare-worker.ts"], bundle: true, format: "iife",
  platform: "browser", target: ["es2022"], minify: true, legalComments: "none", write: false,
});
await writeFile("dist/package-prepare-worker-source.js", `export const PACKAGE_PREPARE_WORKER_SOURCE = ${JSON.stringify(preparation.outputFiles[0].text)};\n`);
await writeFile("dist/package-prepare-worker-source.d.ts", "export declare const PACKAGE_PREPARE_WORKER_SOURCE: string;\n");

const bootstrap = await build({
  entryPoints: ["dist/package-bootstrap.js"], bundle: true, format: "iife",
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
