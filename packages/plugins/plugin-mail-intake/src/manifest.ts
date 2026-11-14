import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { configSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "smarty.mail-intake", apiVersion: 1, version: "0.1.4",
  displayName: "Mail intake", author: "Smarty Pants", categories: ["automation"],
  description: "Code-only Gmail watcher; new message IDs trigger the existing routing routine.",
  capabilities: ["jobs.schedule", "http.outbound", "secrets.read-ref", "plugin.state.read", "plugin.state.write", "companies.read"],
  entrypoints: { worker: "./dist/worker.js" }, instanceConfigSchema: configSchema,
  jobs: [{ jobKey: "mail-intake", displayName: "Mail intake", schedule: "*/2 * * * *",
    description: "Two-minute metadata scan; no model work on quiet ticks." }],
};
export default manifest;
