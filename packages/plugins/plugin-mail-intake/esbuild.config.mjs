import { build } from "esbuild";

// Bundle worker runtime (including SDK); the day-one tgz needs no registry dependencies.
await build({
  entryPoints: ["src/manifest.ts", "src/worker.ts"], outdir: "dist", bundle: true,
  platform: "node", format: "esm", target: "node24", external: ["react", "react-dom"],
});
