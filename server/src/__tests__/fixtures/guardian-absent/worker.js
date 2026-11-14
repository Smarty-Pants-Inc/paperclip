import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register("sweep", async () => {});
  },
});
export default plugin;
runWorker(plugin, import.meta.url);
