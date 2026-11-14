import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";

export function start(companyId, unconfiguredCompanyId) {
  const changes = [];
  const enabledCompanies = new Set();
  const completed = [];
  let setupCompany;
  let unconfiguredError;
  const plugin = definePlugin({
    async setup(ctx) {
      setupCompany = (await ctx.companies.get(companyId)).id;
      try {
        await ctx.companies.get(unconfiguredCompanyId);
      } catch (error) {
        unconfiguredError = error.code;
      }
      ctx.jobs.register("daily-work", async () => {
        for (const id of enabledCompanies) completed.push(id);
      });
      ctx.data.register("snapshot", async () => ({
        pid: process.pid, changes, setupCompany, unconfiguredError, completed,
      }));
    },
    async onConfigChanged(config, context) {
      changes.push({ companyId: context.companyId, config });
      if (config.enabled) enabledCompanies.add(context.companyId);
      else enabledCompanies.delete(context.companyId);
    },
  });
  startWorkerRpcHost({ plugin });
}
