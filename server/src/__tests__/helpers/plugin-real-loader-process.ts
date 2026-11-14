// One real Paperclip server in its own OS process, so a test can SIGKILL it.
// Run: node --import tsx plugin-real-loader-process.ts
// Env: REAL_LOADER_DATABASE_URL (required), REAL_LOADER_INSTALL (optional package dir).
// Prints one `REAL_LOADER_READY {json}` line once it serves; SIGTERM shuts it down.
import { createDb } from "@paperclipai/db";
import { startRealPluginLoader } from "./plugin-real-loader.js";

const url = process.env.REAL_LOADER_DATABASE_URL;
if (!url) throw new Error("REAL_LOADER_DATABASE_URL is required");
const db = createDb(url);
const runtime = await startRealPluginLoader(db);
const plugin = process.env.REAL_LOADER_INSTALL ? await runtime.install(process.env.REAL_LOADER_INSTALL) : undefined;
process.stdout.write(`REAL_LOADER_READY ${JSON.stringify({ pid: process.pid, baseUrl: runtime.baseUrl, pluginId: plugin?.id ?? null })}\n`);
process.once("SIGTERM", () => {
  void runtime.close().finally(() => db.$client.end({ timeout: 1 })).finally(() => process.exit(0));
});
setInterval(() => undefined, 1 << 30);
