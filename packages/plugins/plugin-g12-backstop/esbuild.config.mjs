import { build } from "esbuild";

await build({
  entryPoints: ["src/manifest.ts", "src/worker.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@paperclipai/plugin-sdk"],
});
