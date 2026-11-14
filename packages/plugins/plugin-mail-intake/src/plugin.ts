import type { PluginContext, PluginDefinition } from "@paperclipai/plugin-sdk";
import { fail, only, parseConfig, record, SAFE_ERROR, type MailConfig } from "./config.js";
import { readMailbox, runTick, safeHttp, seenKey } from "./intake.js";
import { cutoff, emptyState, isId, MAX_FAILURES, parkedWarning, parseState } from "./state.js";

type Host = Pick<PluginContext, "companies" | "config" | "state">;
const NOT_CONFIGURED = "mail intake is not configured";

// SDK types.ts:430-437,1184-1193: discover company IDs, then read saved host config.
// This plugin supports one configured company; never pick one arbitrarily.
async function configuredCompany(host: Host) {
  let result: { companyId: string; config: MailConfig } | null = null;
  for (const company of await host.companies.list()) {
    let raw: Record<string, unknown>;
    try {
      raw = await host.config.get(company.id);
    } catch (error) {
      // Setup/health/job callbacks may not carry a company invocation scope.
      // The host rejects config.get for companies outside the saved-config
      // proactive scope. Treat only that explicit scope denial as "not this
      // company's config"; transport and host failures remain fatal.
      if (error instanceof Error && error.message.includes('company context is required')) continue;
      throw error;
    }
    if (Object.keys(raw).length === 0) continue;
    let config: MailConfig;
    try { config = parseConfig(raw); } catch { fail("config invalid"); }
    if (result !== null) fail("multiple companies configured");
    result = { companyId: company.id, config };
  }
  return result;
}

export function createMailDefinition(): PluginDefinition {
  let companyId: string | null = null;
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
        if (running) fail("state exists");
        running = true;
        let failure = "params invalid";
        try {
          // The host action route always forwards renderEnvironment (server routes/
          // plugins.ts:1772, `body?.renderEnvironment ?? null`) and the SDK merges it
          // into params unless undefined (sdk worker-rpc-host.ts:2115-2120). Accept
          // and ignore it; every other unknown key is still refused.
          only(params, ["companyId", "mailbox", "seenIds", "renderEnvironment"]);
          if (params.renderEnvironment !== undefined && params.renderEnvironment !== null &&
              !record(params.renderEnvironment)) fail();
          failure = "config invalid";
          const activeCompany = companyId;
          if (!activeCompany) fail("not configured");
          if (context.companyId !== activeCompany || context.actor.companyId !== activeCompany ||
              params.companyId !== activeCompany) fail("actor/company mismatch");
          const config = parseConfig(await ctx.config.get(activeCompany));
          if (config.enabled || params.mailbox !== config.mailbox || !Array.isArray(params.seenIds) ||
              !params.seenIds.every(isId) ||
              new Set(params.seenIds).size !== params.seenIds.length) fail();
          const key = seenKey(activeCompany, config.mailbox);
          failure = "state exists";
          if (await ctx.state.get(key) !== null) fail("state exists");
          const since = cutoff(config.scanWindowDays);
          failure = "mailbox read failed";
          const messages = (await readMailbox(ctx, activeCompany, config,
            safeHttp(ctx, config, AbortSignal.timeout(240_000)))).filter(m => m.internalDate >= since);
          // Baseline only explicitly approved IDs in the same complete query window.
          const dates = new Map(messages.map(m => [m.id, m.internalDate]));
          if (params.seenIds.some(id => !dates.has(id))) fail();
          await ctx.state.set(key, { ...emptyState(), notBefore: since,
            seen: params.seenIds.map(id => ({ id, internalDate: dates.get(id)! })) });
          return { initialized: true };
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (["not configured", "params invalid", "config invalid", "actor/company mismatch", "state exists",
            "multiple companies configured", "mailbox read failed"].includes(code)) fail(code);
          fail(failure);
        }
        finally { running = false; }
      });
      ctx.jobs.register("mail-intake", async () => {
        if (running) fail("state exists");
        running = true;
        try {
          // Cron has no ambient company. Reconstruct from durable host config every tick.
          const binding = await configuredCompany(ctx);
          companyId = binding?.companyId ?? null;
          if (!binding) fail("not configured"); // A missing company is a FAILED run, never a quiet success.
          if (binding.config.enabled) {
            // Missing or malformed seen state is not a mailbox read failure; name it.
            try { parseState(await ctx.state.get(seenKey(binding.companyId, binding.config.mailbox))); }
            catch { fail("state invalid"); }
          }
          await runTick(ctx, binding.companyId, binding.config);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (["not configured", "config invalid", "multiple companies configured", "state exists",
            "state invalid"].includes(code)) fail(code);
          fail("mailbox read failed");
        }
        finally { running = false; }
      });
    },
    // SDK README:127 documents onHealth() for the host's health dashboard.
    // Read durable state so parked diagnostics survive worker restarts; no mail/secret calls.
    async onHealth() {
      try {
        if (!host) return { status: "error", message: NOT_CONFIGURED };
        const binding = await configuredCompany(host);
        companyId = binding?.companyId ?? null;
        if (!binding) return { status: "error", message: NOT_CONFIGURED };
        let state: ReturnType<typeof parseState>;
        try { state = parseState(await host.state.get(seenKey(binding.companyId, binding.config.mailbox))); }
        catch { fail("state invalid"); }
        const parked = state.failures.filter(m => m.attempts >= MAX_FAILURES);
        return { status: parked.length ? "degraded" : "ok",
          ...(parked.length ? { message: parkedWarning(parked) } : {}),
          details: { parked: parked.map(m => ({ id: m.id, attempts: m.attempts,
            lastFailureAt: m.lastFailureAt ?? null })) } };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const allowed = ["config invalid", "multiple companies configured", "mailbox read failed", "state invalid"];
        return { status: "error", message: allowed.includes(code) ? code : "config invalid" };
      }
    },
    async onConfigChanged(raw, context) {
      try {
        if (!context?.companyId || (companyId !== null && context.companyId !== companyId)) fail("actor/company mismatch");
        parseConfig(raw);
        companyId = context.companyId;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        fail(code === "actor/company mismatch" ? code : "config invalid");
      }
    },
    async onValidateConfig(raw) {
      try { parseConfig(raw); return { ok: true }; }
      catch { return { ok: false, errors: [SAFE_ERROR] }; }
    },
  };
}
