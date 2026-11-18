import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { definePlugin, startWorkerRpcHost } from '@paperclipai/plugin-sdk';

export function start(deniedCompany) {
  const state = { pid: process.pid, history: [], latest: {}, jobs: [] };
  startWorkerRpcHost({ plugin: definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) {
      ctx.data.register('state', async () => state);
      ctx.jobs.register('check-access', async () => {
        const observations = [];
        for (const companyId of [...Object.keys(state.latest), deniedCompany]) {
          try {
            const company = await ctx.companies.get(companyId);
            observations.push({ companyId, read: company.id });
          } catch (error) {
            observations.push({ companyId, error: error.code });
          }
        }
        state.jobs.push(observations);
      });
    },
    async onConfigChanged(config, { companyId }) {
      if (config.gate) {
        writeFileSync(`${config.gate}.entered`, 'entered');
        const deadline = Date.now() + (config.gateBudgetMs ?? 12000);
        while (!existsSync(config.gate)) {
          if (Date.now() > deadline) throw new Error('fixture gate timed out');
          await sleep(5);
        }
      }
      state.history.push({ companyId, revision: config.revision, enabled: config.enabled });
      state.latest[companyId] = config;
    },
  }) });
}
