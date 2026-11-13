import type { PluginContext, PluginDefinition } from "@paperclipai/plugin-sdk";
import { fail, only, parseConfig, SAFE_ERROR } from "./config.js";
import { readMailbox, runTick, safeHttp, seenKey } from "./intake.js";
import { cutoff, emptyState, isId, MAX_FAILURES, parkedWarning, parseState } from "./state.js";

export function createMailDefinition(): PluginDefinition {
  let companyId: string | null = null;
  let configured = false;
  let running = false;
  let host: Pick<PluginContext, "config" | "state"> | null = null;
  return {
    async setup(ctx) {
      host = ctx;
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
              !params.seenIds.every(isId) ||
              new Set(params.seenIds).size !== params.seenIds.length) fail();
          const key = seenKey(companyId, config.mailbox);
          if (await ctx.state.get(key) !== null) fail();
          const since = cutoff(config.scanWindowDays);
          const messages = (await readMailbox(ctx, companyId, config,
            safeHttp(ctx, config, AbortSignal.timeout(240_000)))).filter(m => m.internalDate >= since);
          // Baseline only explicitly approved IDs in the same complete query window.
          const dates = new Map(messages.map(m => [m.id, m.internalDate]));
          if (params.seenIds.some(id => !dates.has(id))) fail();
          await ctx.state.set(key, { ...emptyState(), notBefore: since,
            seen: params.seenIds.map(id => ({ id, internalDate: dates.get(id)! })) });
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
    // SDK README:127 documents onHealth() for the host's health dashboard.
    // Read durable state so parked diagnostics survive worker restarts; no mail/secret calls.
    async onHealth() {
      try {
        if (!host || !companyId) return { status: "ok" };
        if (!configured) fail();
        const config = parseConfig(await host.config.get(companyId));
        const state = parseState(await host.state.get(seenKey(companyId, config.mailbox)));
        const parked = state.failures.filter(m => m.attempts >= MAX_FAILURES);
        return { status: parked.length ? "degraded" : "ok",
          ...(parked.length ? { message: parkedWarning(parked) } : {}),
          details: { parked: parked.map(m => ({ id: m.id, attempts: m.attempts,
            lastFailureAt: m.lastFailureAt ?? null })) } };
      } catch { return { status: "error", message: SAFE_ERROR }; }
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
