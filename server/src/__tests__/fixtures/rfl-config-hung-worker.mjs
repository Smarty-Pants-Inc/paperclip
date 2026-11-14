import { writeFileSync } from 'node:fs';
import { definePlugin, startWorkerRpcHost } from '@paperclipai/plugin-sdk';

// Additional RFL 09:08Z hung-callback case; the original gated fixture is intact.
export function start() {
  const state = { pid: process.pid, history: [], latest: {} };
  startWorkerRpcHost({ plugin: definePlugin({
    multiCompanyConfig: true,
    async setup(ctx) { ctx.data.register('state', async () => state); },
    async onConfigChanged(config, { companyId }) {
      if (config.gate) {
        writeFileSync(`${config.gate}.entered`, 'entered');
        // Intentionally no deadline, throw, release handler, or return path.
        await new Promise(() => {});
      }
      state.history.push({ companyId, revision: config.revision, enabled: config.enabled });
      state.latest[companyId] = config;
    },
  }) });
}
