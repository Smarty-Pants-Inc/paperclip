import type { PluginDefinition } from "@paperclipai/plugin-sdk";
import { fail, only, parseConfig, SAFE_ERROR } from "./config.js";
import { runTick, seenKey } from "./intake.js";

export function createMailDefinition(): PluginDefinition {
  let companyId: string | null = null;
  let configured = false;
  let running = false;
  return {
    async setup(ctx) {
      // Explicit one-time setup, not implicit history replay on a missing KV row.
      // Authoring guide:482 and the authenticated company-scoped actions bridge.
      ctx.actions.register("initialize-seen", async (params, context) => {
        if (running) fail();
        running = true;
        try {
          only(params, ["companyId", "mailbox", "seenIds"]);
          if (!configured || !companyId || context.companyId !== companyId ||
              context.actor.companyId !== companyId || params.companyId !== companyId) fail();
          const config = parseConfig(await ctx.config.get(companyId));
          if (config.enabled || params.mailbox !== config.mailbox || !Array.isArray(params.seenIds) ||
              !params.seenIds.every(id => typeof id === "string" && /^[0-9a-f]{1,64}$/.test(id)) ||
              new Set(params.seenIds).size !== params.seenIds.length) fail();
          const key = seenKey(companyId, config.mailbox);
          if (await ctx.state.get(key) !== null) fail();
          await ctx.state.set(key, [...params.seenIds]);
          return { initialized: true };
        } catch { fail(); }
        finally { running = false; }
      });
      ctx.jobs.register("mail-intake", async () => {
        if (running) fail();
        running = true;
        try {
          if (companyId === null) return;
          if (!configured) fail();
          // Cron has no ambient company. Never read instance/global config.
          await runTick(ctx, companyId, parseConfig(await ctx.config.get(companyId)));
        } catch { fail(); }
        finally { running = false; }
      });
    },
    async onConfigChanged(raw, context) {
      configured = false;
      try {
        if (!context?.companyId || (companyId !== null && context.companyId !== companyId)) fail();
        parseConfig(raw);
        companyId = context.companyId;
        configured = true;
      } catch { fail(); }
    },
    async onValidateConfig(raw) {
      try { parseConfig(raw); return { ok: true }; }
      catch { return { ok: false, errors: [SAFE_ERROR] }; }
    },
  };
}
