import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "smarty.g12-backstop",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "G12 backstop",
  description: "Code-only safety net: detect missing App reviews and failing checks, then wake the configured PR owner with at-least-once delivery.",
  author: "Smarty Pants",
  categories: ["automation"],
  capabilities: [
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.wakeup",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: configSchema,
  jobs: [{
    jobKey: "g12-backstop",
    displayName: "G12 backstop",
    description: "Five-minute GitHub webhook/review-check safety net; no model run on quiet ticks.",
    schedule: "*/5 * * * *",
  }],
};
export default manifest;
