import { appendFileSync, readFileSync } from "node:fs";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// The test owns a copy of this directory. It reads every execution of the job
// (start and end, with this worker's pid) from runs.ndjson, and sets how long
// the next execution sleeps in sleep-ms.
const file = name => new URL(name, import.meta.url);
const record = entry => appendFileSync(file("runs.ndjson"),
  `${JSON.stringify({ ...entry, pid: process.pid, at: new Date().toISOString() })}\n`);

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("sleep", async job => {
      record({ event: "start", runId: job.runId, trigger: job.trigger, scheduledAt: job.scheduledAt });
      const ms = Number(readFileSync(file("sleep-ms"), "utf8"));
      await new Promise(resolve => setTimeout(resolve, ms));
      record({ event: "end", runId: job.runId });
    });
  },
});
export default plugin;
runWorker(plugin, import.meta.url);
