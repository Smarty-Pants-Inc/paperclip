import { AsyncResource } from "node:async_hooks";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// Use the real SDK's event/job dispatch and AsyncLocalStorage propagation.
const plugin = definePlugin({
  async setup(ctx) {
    const proactive = new AsyncResource("plugin-proactive-work");
    let events = 0;
    let completed = 0;
    let held = false;
    let rows;
    let config;
    let releaseEvent;
    ctx.events.on("issue.updated", async (event) => {
      events++;
      if (event.payload.hold) {
        await new Promise((resolve) => {
          releaseEvent = resolve;
          held = true;
        });
      }
      held = false;
      completed++;
    });
    ctx.jobs.register("query", async () => {
      rows = await ctx.db.query("SELECT 1 AS value");
    });
    ctx.jobs.register("unscoped", async () => {
      await proactive.runInAsyncScope(() => ctx.db.query("SELECT 1 AS value"));
    });
    ctx.jobs.register("company", async () => {
      await ctx.companies.get("company-b");
    });
    ctx.jobs.register("config-configured", async () => {
      config = await ctx.config.get("company-a");
    });
    ctx.jobs.register("config-unconfigured", async () => {
      await ctx.config.get("company-b");
    });
    ctx.jobs.register("config-unscoped", async () => {
      await ctx.config.get();
    });
    ctx.jobs.register("fail", async () => { throw new Error("job failed"); });
    ctx.jobs.register("wait", async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    ctx.data.register("snapshot", async () => ({ events, completed, held, rows }));
    ctx.data.register("config-snapshot", async () => config);
    ctx.data.register("release", async () => { releaseEvent?.(); return {}; });
    ctx.data.register("unscoped-query", async () => ctx.db.query("SELECT 1 AS value"));
  },
});
runWorker(plugin, import.meta.url);
