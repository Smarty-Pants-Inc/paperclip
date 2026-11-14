import type { PluginContext, PluginDefinition } from "@paperclipai/plugin-sdk";
import { fail, only, parseConfig, SAFE_ERROR, type MailConfig } from "./config.js";
import { readMailbox, runTick, safeHttp, seenKey } from "./intake.js";
import { cutoff, emptyState, isId, MAX_FAILURES, parkedWarning, parseState } from "./state.js";

type Host = Pick<PluginContext, "companies" | "config" | "state">;
const NOT_CONFIGURED = "mail intake is not configured";

// SDK types.ts:430-437,1184-1193: discover company IDs, then read saved host config.
// This plugin supports one configured company; never pick one arbitrarily.
async function configuredCompany(host: Host) {
  let result: { companyId: string; config: MailConfig } | null = null;
  for (const company of await host.companies.list()) {
    const raw = await host.config.get(company.id);
    if (Object.keys(raw).length === 0) continue;
    const config = parseConfig(raw);
    if (result !== null) fail();
    result = { companyId: company.id, config };
  }
  return result;
}

export function createMailDefinition(): PluginDefinition {
  let companyId: string | null = null;
  let invalidConfig = false;
  let running = false;
  let host: Host | null = null;
  return {
    async setup(ctx) {
      host = ctx;
      try { companyId = (await configuredCompany(ctx))?.companyId ?? null; }
      catch { /* Health and jobs retry discovery and surface a fixed error. */ }
      // Explicit one-time setup, not implicit history replay on a missing KV row.
      // SDK protocol.ts:442-460: BOARD is exposed as "user", with host company scope.
      ctx.actions.register("initialize-seen", async (params, context) => {
        if (running) fail();
        running = true;
        try {
          only(params, ["companyId", "mailbox", "seenIds"]);
          const activeCompany = companyId;
          if (invalidConfig || !activeCompany || context.companyId !== activeCompany ||
              context.actor.companyId !== activeCompany || params.companyId !== activeCompany) fail();
          const config = parseConfig(await ctx.config.get(activeCompany));
          if (config.enabled || params.mailbox !== config.mailbox || !Array.isArray(params.seenIds) ||
              !params.seenIds.every(isId) ||
              new Set(params.seenIds).size !== params.seenIds.length) fail();
          const key = seenKey(activeCompany, config.mailbox);
          if (await ctx.state.get(key) !== null) fail();
          const since = cutoff(config.scanWindowDays);
          const messages = (await readMailbox(ctx, activeCompany, config,
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
          if (invalidConfig) fail();
          // Cron has no ambient company. Reconstruct from durable host config every tick.
          const binding = await configuredCompany(ctx);
          companyId = binding?.companyId ?? null;
          if (!binding) fail(); // A missing company is a FAILED run, never a quiet success.
          await runTick(ctx, binding.companyId, binding.config);
        } catch { fail(); }
        finally { running = false; }
      });
    },
    // SDK README:127 documents onHealth() for the host's health dashboard.
    // Read durable state so parked diagnostics survive worker restarts; no mail/secret calls.
    async onHealth() {
      try {
        if (!host) return { status: "error", message: NOT_CONFIGURED };
        if (invalidConfig) fail();
        const binding = await configuredCompany(host);
        companyId = binding?.companyId ?? null;
        if (!binding) return { status: "error", message: NOT_CONFIGURED };
        const state = parseState(await host.state.get(seenKey(binding.companyId, binding.config.mailbox)));
        const parked = state.failures.filter(m => m.attempts >= MAX_FAILURES);
        return { status: parked.length ? "degraded" : "ok",
          ...(parked.length ? { message: parkedWarning(parked) } : {}),
          details: { parked: parked.map(m => ({ id: m.id, attempts: m.attempts,
            lastFailureAt: m.lastFailureAt ?? null })) } };
      } catch { return { status: "error", message: SAFE_ERROR }; }
    },
    async onConfigChanged(raw, context) {
      invalidConfig = true;
      try {
        if (!context?.companyId || (companyId !== null && context.companyId !== companyId)) fail();
        parseConfig(raw);
        companyId = context.companyId;
        invalidConfig = false;
      } catch { fail(); }
    },
    async onValidateConfig(raw) {
      try { parseConfig(raw); return { ok: true }; }
      catch { return { ok: false, errors: [SAFE_ERROR] }; }
    },
  };
}
