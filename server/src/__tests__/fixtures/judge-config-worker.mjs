import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { definePlugin, startWorkerRpcHost } from '@paperclipai/plugin-sdk';

export function start(deniedCompany) {
  const changes = [];
  const latest = {};
  const completed = [];
  let deniedCode;
  const plugin = definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      try { await ctx.companies.get(deniedCompany); }
      catch (error) { deniedCode = error.code; }
      ctx.data.register('snapshot', async () => ({ pid: process.pid, changes, latest, completed, deniedCode }));
      ctx.jobs.register('daily', async () => {
        for (const [id, config] of Object.entries(latest)) if (config.enabled) completed.push(id);
      });
    },
    async onConfigChanged(config, context) {
      if (config.gate) {
        writeFileSync(`${config.gate}.entered`, 'entered');
        const deadline = Date.now() + 15000;
        while (!existsSync(config.gate)) {
          if (Date.now() >= deadline) throw new Error('judge gate timed out');
          await delay(10);
        }
      }
      changes.push({ companyId: context.companyId, config });
      latest[context.companyId] = config;
    },
  });
  startWorkerRpcHost({ plugin });
}
