import type { PluginContext, PluginDefinition } from "@paperclipai/plugin-sdk";
import { fail, only, parseConfig, record, SAFE_ERROR, type MailConfig } from "./config.js";
import { initKey, readMailbox, runTick, safeHttp, seenKey } from "./intake.js";
import { cutoff, emptyState, isId, MAX_FAILURES, MAX_SEEN_IDS, parkedWarning, parsePending, parseState,
  type PendingInit } from "./state.js";

type Host = Pick<PluginContext, "companies" | "config" | "state">;
type Binding = { companyId: string; config: MailConfig };
const NOT_CONFIGURED = "mail intake is not configured";
export const INITIALIZING = "initializing";
// One fixed code per step (review-fleet-2 F2). Anything else is SAFE_ERROR.
export const CODES = Object.freeze([
  "params invalid", "actor/company mismatch", "not configured", "busy",
  "host read failed", "config read failed", "config invalid", "config enabled", "multiple companies configured",
  "state read failed", "state invalid", "state exists", "state write failed", "initialization pending",
  "seenIds not in window", "mailbox read failed",
] as const);
type Code = typeof CODES[number];
const codeOf = (error: unknown): Code | null => {
  const message = error instanceof Error ? error.message : "";
  return (CODES as readonly string[]).includes(message) ? message as Code : null;
};
/** Run one step; any failure that is not already a step code becomes `code`. */
async function step<T>(code: Code, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (error) { fail(codeOf(error) ?? code); }
}
// The host action RPC is capped at 30 s (server/src/services/plugin-worker-manager.ts:82
// DEFAULT_RPC_TIMEOUT_MS; routes/plugins.ts:1765-1773 passes no override). A job gets
// 5 minutes (server/src/services/plugin-job-scheduler.ts:50,85-88; app.ts:890 keeps the
// default). The mailbox read therefore runs only in the job, inside this budget.
const READ_BUDGET_MS = 240_000;

// SDK types.ts:430-437,1184-1193: discover company IDs, then read saved host config.
// This plugin supports one configured company; never pick one arbitrarily.
//
// `configured` (KnownCompanies below) holds every company the HOST told this plugin it has a saved config
// row for: the loader replays configChanged for each stored row at worker start
// (server/src/services/plugin-loader.ts:2497-2501) from the same rows that seed the
// proactive company scopes (plugin-loader.ts:2461), and every config save sends
// configChanged (routes/plugins.ts:2469-2473). A config save refreshes those scopes
// first but swallows a refresh failure (routes/plugins.ts:2457-2466). So a scope
// denial ("company context is required", sdk host-client-factory.ts:639/668) for a
// company NOT in this set is "no config here"; for a company IN it, it is a
// configured company the worker cannot read, which must fail loudly.
//
// The set is also kept in the plugin's OWN durable state (review-fleet-2 F1
// residual). The host replays configChanged only when the loader activates the
// plugin (plugin-loader.ts:2497-2501). A crashed worker is respawned by the
// worker manager alone: handle exit -> scheduleRestart -> startInternal
// (server/src/services/plugin-worker-manager.ts:3179,3253-3276,3354-3383; the
// only configChanged there is a listener, :4315), which
// spawns a fresh process and replays nothing, while the handle keeps its
// proactive scope set (plugin-worker-manager.ts:1112-1115). An in-memory set
// would be empty after that respawn and a refused configured company would be
// skipped again. It is instance-scoped state on purpose: a company-scoped row
// for a refused company could not be read either (the same gate refuses
// scopeKind "company" for it, sdk host-client-factory.ts:595-598), while an
// instance-scoped key names no company and is not gated (host-client-factory.ts:
// 614). No host route deletes a company's config row (registry deleteConfig,
// plugin-registry.ts:475, has no caller), so the set only grows.
const CONFIGURED_KEY = Object.freeze({ scopeKind: "instance" as const, namespace: "mail-intake",
  stateKey: "configured-companies" });
const MAX_KNOWN_COMPANIES = 10_000;
function parseKnown(value: unknown): Set<string> {
  if (value === null) return new Set();
  if (!record(value)) fail();
  only(value, ["version", "companies"]);
  if (value.version !== 1 || !Array.isArray(value.companies) || value.companies.length > MAX_KNOWN_COMPANIES ||
      !value.companies.every(id => typeof id === "string" && id.length > 0 && id.length <= 200)) fail();
  return new Set(value.companies as string[]);
}
/**
 * Companies the host has told any worker of this plugin it holds a saved config
 * row for. `reported` is this worker's own configChanged deliveries; `durable` is
 * the stored set (null until read). Every discovery loads it (once) and writes
 * back any reported company not yet stored; a read or write failure fails the
 * discovery ("state read failed" / "state write failed"), never skips a refusal.
 */
class KnownCompanies {
  private readonly reported = new Set<string>();
  private durable: Set<string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  report(companyId: string) { this.reported.add(companyId); }
  load(host: Pick<Host, "state">): Promise<ReadonlySet<string>> {
    const run = this.chain.then(() => this.sync(host));
    this.chain = run.catch(() => undefined); // Serialize read-modify-write.
    return run;
  }
  private async sync(host: Pick<Host, "state">): Promise<ReadonlySet<string>> {
    if (this.durable === null) {
      const raw = await step("state read failed", () => host.state.get(CONFIGURED_KEY));
      this.durable = await step("state invalid", () => parseKnown(raw));
    }
    const stored = this.durable;
    const missing = [...this.reported].filter(id => !stored.has(id));
    if (missing.length === 0) return stored;
    const next = new Set([...stored, ...missing]);
    if (next.size > MAX_KNOWN_COMPANIES) fail("state write failed");
    await step("state write failed", () => host.state.set(CONFIGURED_KEY, { version: 1, companies: [...next].sort() }));
    this.durable = next;
    return next;
  }
}
async function configuredCompany(host: Host, known: KnownCompanies): Promise<Binding | null> {
  const companies = await step("host read failed", () => host.companies.list());
  // Durable, so a worker-only respawn (no configChanged replay) still knows them.
  const configured = await known.load(host);
  let result: Binding | null = null;
  for (const company of companies) {
    let raw: Record<string, unknown>;
    try {
      raw = await host.config.get(company.id);
    } catch (error) {
      const denied = error instanceof Error && error.message.includes("company context is required");
      if (denied && !configured.has(company.id)) continue;
      fail("config read failed");
    }
    if (!record(raw)) fail("config read failed");
    if (Object.keys(raw).length === 0) continue;
    const config = await step("config invalid", () => parseConfig(raw));
    if (result !== null) fail("multiple companies configured");
    result = { companyId: company.id, config };
  }
  return result;
}

/**
 * The job half of initialize-seen. The action only records a validated request;
 * this read happens inside the job's budget. The baseline accepts only IDs that are
 * present in the same complete query window; nothing is fired (no history replay).
 */
async function completeInitialization(ctx: PluginContext, binding: Binding, pending: PendingInit): Promise<void> {
  const { companyId, config } = binding;
  const key = initKey(companyId, config.mailbox);
  if (pending.failure && pending.final) fail(pending.failure); // Rejected; needs a new explicit request.
  const recordFailure = async (failure: Code, final: boolean) => {
    // Best effort: the job fails with the same code even if this write fails.
    try { await ctx.state.set(key, { ...pending, failure, final, failedAt: Date.now() }); } catch { /* reported by the job */ }
    fail(failure);
  };
  const since = cutoff(config.scanWindowDays);
  let dates: Map<string, number>;
  try {
    const messages = (await readMailbox(ctx, companyId, config,
      safeHttp(ctx, config, AbortSignal.timeout(READ_BUDGET_MS)))).filter(m => m.internalDate >= since);
    dates = new Map(messages.map(m => [m.id, m.internalDate]));
  } catch { return recordFailure("mailbox read failed", false); } // Transient: the next tick retries.
  if (pending.seenIds.some(id => !dates.has(id))) return recordFailure("seenIds not in window", true);
  const seen = seenKey(companyId, config.mailbox);
  await step("state read failed", async () => { if (await ctx.state.get(seen) !== null) fail("state exists"); });
  await step("state write failed", () => ctx.state.set(seen, { ...emptyState(), notBefore: since,
    seen: pending.seenIds.map(id => ({ id, internalDate: dates.get(id)! })) }));
  // A leftover request is ignored once seen state exists, so a failed delete is harmless.
  try { await ctx.state.delete(key); } catch { /* ignored: seen state now wins */ }
}

export function createMailDefinition(): PluginDefinition {
  let companyId: string | null = null;
  let running = false;
  let host: Host | null = null;
  const known = new KnownCompanies();
  return {
    // The plugin is still single-company and fails closed on a second config
    // ("multiple companies configured"). It sets this so the SDK hands every
    // company's configChanged to onConfigChanged (sdk worker-rpc-host.ts:1979-1997)
    // instead of rejecting it with CROSS_TENANT_CONFIG, which the save route
    // swallows (routes/plugins.ts:2474-2487); otherwise a second company could be
    // invisible to `configured` above.
    multiCompanyConfig: true,
    async setup(ctx) {
      host = ctx;
      // Rebuild the configured-company set from durable state at worker init,
      // before any job or health discovery (a respawn gets no configChanged).
      try { await known.load(ctx); } catch { /* Discovery retries it and fails loudly. */ }
      try { companyId = (await configuredCompany(ctx, known))?.companyId ?? null; }
      catch { /* Health and jobs retry discovery and surface a fixed error. */ }
      // Explicit one-time setup, not implicit history replay on a missing KV row.
      // SDK protocol.ts:442-460: BOARD is exposed as "user", with host company scope.
      // Returns well inside the host's 30 s action cap: validation plus four
      // plugin-state calls; no secret, no mail, no network.
      ctx.actions.register("initialize-seen", async (params, context) => {
        if (running) fail("busy");
        running = true;
        try {
          // The host action route always forwards renderEnvironment (server routes/
          // plugins.ts:1772, `body?.renderEnvironment ?? null`) and the SDK merges it
          // into params unless undefined (sdk worker-rpc-host.ts:2115-2120). Accept
          // and ignore it; every other unknown key is still refused.
          await step("params invalid", () => {
            only(params, ["companyId", "mailbox", "seenIds", "renderEnvironment"]);
            if (params.renderEnvironment !== undefined && params.renderEnvironment !== null &&
                !record(params.renderEnvironment)) fail();
            if (typeof params.mailbox !== "string" || !Array.isArray(params.seenIds) ||
                params.seenIds.length > MAX_SEEN_IDS || !params.seenIds.every(isId) ||
                new Set(params.seenIds).size !== params.seenIds.length) fail();
          });
          const activeCompany = companyId;
          if (!activeCompany) fail("not configured");
          if (context.companyId !== activeCompany || context.actor.companyId !== activeCompany ||
              params.companyId !== activeCompany) fail("actor/company mismatch");
          const raw = await step("config read failed", () => ctx.config.get(activeCompany));
          const config = await step("config invalid", () => parseConfig(raw));
          if (config.enabled) fail("config enabled");
          if ((params.mailbox as string).toLowerCase() !== config.mailbox) fail("params invalid");
          const seen = await step("state read failed", () => ctx.state.get(seenKey(activeCompany, config.mailbox)));
          if (seen !== null) fail("state exists");
          const key = initKey(activeCompany, config.mailbox);
          const prior = await step("state read failed", () => ctx.state.get(key));
          if (prior !== null) {
            const parsed = await step("state invalid", () => parsePending(prior));
            // A failed request may be replaced; a live one may not.
            if (!parsed.failure) fail("initialization pending");
          }
          const request: PendingInit = { version: 1, seenIds: params.seenIds as string[], requestedAt: Date.now() };
          await step("state write failed", () => ctx.state.set(key, request));
          return { accepted: true };
        } catch (error) {
          fail(codeOf(error) ?? SAFE_ERROR);
        }
        finally { running = false; }
      });
      ctx.jobs.register("mail-intake", async () => {
        if (running) fail("busy");
        running = true;
        try {
          // Cron has no ambient company. Reconstruct from durable host config every tick.
          const binding = await configuredCompany(ctx, known);
          companyId = binding?.companyId ?? null;
          if (!binding) fail("not configured"); // A missing company is a FAILED run, never a quiet success.
          const seen = await step("state read failed", () => ctx.state.get(seenKey(binding.companyId, binding.config.mailbox)));
          if (!binding.config.enabled) {
            if (seen !== null) return; // Disabled and initialized: strict no-op.
            const pending = await step("state read failed", () => ctx.state.get(initKey(binding.companyId, binding.config.mailbox)));
            if (pending === null) return; // Disabled, nothing requested.
            const request = await step("state invalid", () => parsePending(pending));
            await completeInitialization(ctx, binding, request);
            return;
          }
          // Missing or malformed seen state is not a mailbox read failure; name it.
          await step("state invalid", () => parseState(seen));
          await step("mailbox read failed", () => runTick(ctx, binding.companyId, binding.config));
        } catch (error) {
          fail(codeOf(error) ?? SAFE_ERROR);
        }
        finally { running = false; }
      });
    },
    // SDK README:127 documents onHealth() for the host's health dashboard.
    // Read durable state so parked diagnostics survive worker restarts; no mail/secret calls.
    async onHealth() {
      try {
        if (!host) return { status: "error", message: NOT_CONFIGURED };
        const h = host;
        const binding = await configuredCompany(h, known);
        companyId = binding?.companyId ?? null;
        if (!binding) return { status: "error", message: NOT_CONFIGURED };
        const raw = await step("state read failed", () => h.state.get(seenKey(binding.companyId, binding.config.mailbox)));
        if (raw === null) {
          const pending = await step("state read failed", () => h.state.get(initKey(binding.companyId, binding.config.mailbox)));
          if (pending !== null) {
            const request = await step("state invalid", () => parsePending(pending));
            if (request.failure) return { status: "error", message: request.failure,
              details: { initialization: request.final ? "rejected" : "retrying", requestedAt: request.requestedAt,
                failedAt: request.failedAt ?? null } };
            return { status: "ok", message: INITIALIZING,
              details: { initialization: "pending", requestedAt: request.requestedAt } };
          }
        }
        const state = await step("state invalid", () => parseState(raw));
        const parked = state.failures.filter(m => m.attempts >= MAX_FAILURES);
        return { status: parked.length ? "degraded" : "ok",
          ...(parked.length ? { message: parkedWarning(parked) } : {}),
          details: { parked: parked.map(m => ({ id: m.id, attempts: m.attempts,
            lastFailureAt: m.lastFailureAt ?? null })) } };
      } catch (error) {
        return { status: "error", message: codeOf(error) ?? SAFE_ERROR };
      }
    },
    async onConfigChanged(raw, context) {
      // The host has a saved row for this company whatever its content; remember it,
      // durably, so a later scope denial for it is a failure, not "unconfigured",
      // even after a worker-only respawn. A failed write is retried by every
      // discovery (which fails "state write failed" until it lands).
      let persisted = true;
      if (context?.companyId) {
        known.report(context.companyId);
        if (host) { try { await known.load(host); } catch { persisted = false; } }
      }
      try {
        if (!context?.companyId || (companyId !== null && context.companyId !== companyId)) fail("actor/company mismatch");
        parseConfig(raw);
        companyId = context.companyId;
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        fail(code === "actor/company mismatch" ? code : "config invalid");
      }
      if (!persisted) fail("state write failed");
    },
    async onValidateConfig(raw) {
      try { parseConfig(raw); return { ok: true }; }
      catch { return { ok: false, errors: [SAFE_ERROR] }; }
    },
  };
}
