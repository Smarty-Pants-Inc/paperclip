import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await Promise.all([
  build({
    entryPoints: ["src/manifest.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: "dist/manifest.js",
    external: ["@paperclipai/plugin-sdk"],
  }),
  build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: "dist/worker.js",
    external: ["@paperclipai/plugin-sdk"],
  }),
]);
