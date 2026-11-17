import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { createCaptureHandler, stubRecorder } from './capture.mjs';
import { TOOL } from './manifest.mjs';

const plugin = definePlugin({
  async setup(ctx) {
    ctx.tools.register(TOOL.name, TOOL, createCaptureHandler({
      db: ctx.db, config: ctx.config, logger: ctx.logger, recorder: stubRecorder,
    }));
  },
  async onHealth() {
    return { status: 'ok', message: 'Screen capture policy ready; recorder is stub-only.' };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
