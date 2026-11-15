import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { syncFiles } from "./file-sync.js";
import { parseHttpDate } from "./http-date.js";
import { createReadySpareClaimStore, ReadySpareKeeper, READY_SPARE_TTL_SECONDS, readySpareConfigHash, readySpareCount, readySpareDemandWindowMinutes,
  readySpareEnvironmentIds, readySpareIdleMinutes, readySpareMax, readySparePoolKey,
  type ReadySpare, type ReadySpareClaimStore, type ReadySpareKey, type ReadySpareOperations } from "./ready-spares.js";
import { stageGuardian, type GuardianPreflight } from "./guardian-stage.js";
import { BoatIdleActivity, trackBoatHooks } from "./idle-activity.js";
import { assertBoatActivityAdmission, gateBoatHooks, withBoatLeaseActivity } from "./lease-gates.js";
import { BoatDuplexChannels, BoatDuplexError, type DuplexLease } from "./duplex.js";
import { BoatSshCarrier, connectSsh, SSH_RETIRE_ATTEMPTS, type SshRetireWarning } from "./ssh-carrier.js";
import { acquireRunnerIngress, DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS, effectiveTtlSeconds, ingressScopeKey,
  privateRunnerEndpoint, resumeSentinelMetadata, runnerIngressGenerationStore, verifyWorkspaceSentinel,
  workspaceDirectory, writeWorkspaceSentinel, type RunnerConfig } from "./runner-support.js";
import { definePlugin, PluginEnvironmentCreationCleanupError, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams, PluginEnvironmentDestroyLeaseParams, PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult, PluginEnvironmentLease, PluginEnvironmentProbeParams, PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams, PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams, PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams, PluginEnvironmentValidationResult, PluginEnvironmentCreationCleanup,
  PluginEnvironmentInspectLeaseParams, PluginEnvironmentLeaseObservation,
  PluginEnvironmentRunnerIngressEndpointParams, PluginEnvironmentRunnerIngressEndpoint, PluginContext,
} from "@paperclipai/plugin-sdk";

type Config = RunnerConfig & { provider: string; setupTimeoutSeconds: number; retainOnDestroy: boolean; labels: Record<string, string>; duplexCarrier: "off" | "ssh" };
const API = "https://boat.dev/api/v1";
const SPARE_ACTIVITY_EVENTS = ["agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled",
  "issue.comment.created", "issue.created", "issue.updated"] as const;
const idleActivity = new BoatIdleActivity();
const readySpares = new ReadySpareKeeper();
type KnownSparePool = { key: ReadySpareKey; ttlSeconds: number; desired: number; baseDesired: number; spareMax: number; demandWindowMinutes: number;
  idleMinutes: number; operations: ReadySpareOperations; idleStopped: boolean };
type CompanySpareActivity = { lastActivityAt?: number; lastLeaseAcquiredAt?: number };
type AcquireOutcomeReason = "no_ready_spare" | "refill_in_flight" | "env_not_listed" | "config_mismatch" | "claim_conflict" | "spares_disabled" | "idle";
type AcquireOutcomeCounts = { spare: number; cold: number; reasons: Partial<Record<AcquireOutcomeReason, number>> };
type CompanyAcquireOutcomes = Map<string, AcquireOutcomeCounts>;
const knownSparePools = new Map<string, KnownSparePool>();
const companySpareActivity = new Map<string, CompanySpareActivity>();
const companySpareActivityLoads = new Map<string, Promise<CompanySpareActivity>>();
const companySpareActivityWrites = new Map<string, Promise<void>>();
const companyAcquireOutcomes = new Map<string, CompanyAcquireOutcomes>();
const companyAcquireOutcomeLoads = new Map<string, Promise<CompanyAcquireOutcomes>>();
const companyAcquireOutcomeWrites = new Map<string, Promise<void>>();
const SPARE_ACTIVITY_NAMESPACE = "boat-ready-spares";
const SPARE_ACTIVITY_STATE_KEY = "company-activity";
const SPARE_ACQUIRE_OUTCOMES_STATE_KEY = "acquire-outcomes";
let activityUnsubscribers: Array<() => void> = [];
const activitySubscriptionCompanies = new Set<string>();
let pluginContext: PluginContext | undefined;
let spareClaimStore: ReadySpareClaimStore | undefined;
let spareRefreshTimer: ReturnType<typeof setInterval> | undefined;
let spareMaintenanceWork: Promise<void> | undefined;
let shuttingDown = false;
const inFlightAcquisitions = new Set<Promise<PluginEnvironmentLease>>();
function subscribeCompanyActivity(companyId: string): void {
  if (!pluginContext?.events?.on || activitySubscriptionCompanies.has(companyId)) return;
  for (const eventType of SPARE_ACTIVITY_EVENTS) {
    activityUnsubscribers.push(pluginContext.events.on(eventType, { companyId }, async event => {
      if (event.companyId !== companyId) return;
      await recordCompanySpareActivity(companyId, false, true);
    }));
  }
  activitySubscriptionCompanies.add(companyId);
}
const BOAT_CALL_BUDGET_MS = 30_000;
const BOAT_MAX_ATTEMPTS = 3;
function activityKey(config: Config, id: string): string { return createHash("sha256").update(`${API}\0${config.apiKey}\0${id}`).digest("hex"); }
function stateTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
async function loadCompanySpareActivity(companyId: string): Promise<CompanySpareActivity> {
  const cached = companySpareActivity.get(companyId);
  if (cached) return cached;
  const pending = companySpareActivityLoads.get(companyId);
  if (pending) return pending;
  const work = (async () => {
    let activity: CompanySpareActivity = {};
    const stateClient = pluginContext?.state;
    if (!stateClient?.get) {
      companySpareActivity.set(companyId, activity);
      return activity;
    }
    try {
      const state = await stateClient.get({ scopeKind: "company", scopeId: companyId,
        namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_ACTIVITY_STATE_KEY });
      if (state && typeof state === "object" && !Array.isArray(state)) {
        const value = state as Record<string, unknown>;
        activity = { lastActivityAt: stateTimestamp(value.lastActivityAt), lastLeaseAcquiredAt: stateTimestamp(value.lastLeaseAcquiredAt) };
      }
    } catch {
      duplexLogger?.warn("Boat spare activity state read failed", { companyId });
    }
    companySpareActivity.set(companyId, activity);
    return activity;
  })();
  companySpareActivityLoads.set(companyId, work);
  try { return await work; }
  finally { if (companySpareActivityLoads.get(companyId) === work) companySpareActivityLoads.delete(companyId); }
}
async function persistCompanySpareActivity(companyId: string, activity: CompanySpareActivity): Promise<void> {
  if (!pluginContext?.state?.set) return;
  const previous = companySpareActivityWrites.get(companyId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => pluginContext!.state.set({ scopeKind: "company", scopeId: companyId,
    namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_ACTIVITY_STATE_KEY }, activity));
  companySpareActivityWrites.set(companyId, write);
  try { await write; }
  catch { duplexLogger?.warn("Boat spare activity state write failed", { companyId }); }
  finally { if (companySpareActivityWrites.get(companyId) === write) companySpareActivityWrites.delete(companyId); }
}
async function loadCompanyAcquireOutcomes(companyId: string): Promise<CompanyAcquireOutcomes> {
  const cached = companyAcquireOutcomes.get(companyId);
  if (cached) return cached;
  const pending = companyAcquireOutcomeLoads.get(companyId);
  if (pending) return pending;
  const work = (async () => {
    const outcomes: CompanyAcquireOutcomes = new Map();
    try {
      const state = await pluginContext?.state?.get?.({ scopeKind: "company", scopeId: companyId,
        namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_ACQUIRE_OUTCOMES_STATE_KEY });
      if (state && typeof state === "object" && !Array.isArray(state)) {
        const rows = (state as Record<string, unknown>).environments;
        if (Array.isArray(rows)) for (const row of rows) {
          if (!row || typeof row !== "object" || Array.isArray(row)) continue;
          const value = row as Record<string, unknown>;
          if (typeof value.environmentId !== "string" || !value.environmentId) continue;
          const reasons: AcquireOutcomeCounts["reasons"] = {};
          if (value.reasons && typeof value.reasons === "object" && !Array.isArray(value.reasons)) {
            for (const reason of ["no_ready_spare", "refill_in_flight", "env_not_listed", "config_mismatch", "claim_conflict", "spares_disabled", "idle"] as const) {
              const count = (value.reasons as Record<string, unknown>)[reason];
              if (Number.isInteger(count) && Number(count) >= 0) reasons[reason] = Number(count);
            }
          }
          outcomes.set(value.environmentId, {
            spare: Number.isInteger(value.spare) && Number(value.spare) >= 0 ? Number(value.spare) : 0,
            cold: Number.isInteger(value.cold) && Number(value.cold) >= 0 ? Number(value.cold) : 0,
            reasons,
          });
        }
      }
    } catch { duplexLogger?.warn("Boat acquire outcome state read failed", { companyId }); }
    companyAcquireOutcomes.set(companyId, outcomes);
    return outcomes;
  })();
  companyAcquireOutcomeLoads.set(companyId, work);
  try { return await work; }
  finally { if (companyAcquireOutcomeLoads.get(companyId) === work) companyAcquireOutcomeLoads.delete(companyId); }
}
async function persistCompanyAcquireOutcomes(companyId: string, outcomes: CompanyAcquireOutcomes): Promise<void> {
  if (!pluginContext?.state?.set) return;
  const previous = companyAcquireOutcomeWrites.get(companyId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => pluginContext!.state.set({ scopeKind: "company", scopeId: companyId,
    namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_ACQUIRE_OUTCOMES_STATE_KEY }, {
      environments: [...outcomes].map(([environmentId, counts]) => ({ environmentId, spare: counts.spare, cold: counts.cold, reasons: { ...counts.reasons } })),
    }));
  companyAcquireOutcomeWrites.set(companyId, write);
  try { await write; }
  catch { duplexLogger?.warn("Boat acquire outcome state write failed", { companyId }); }
  finally { if (companyAcquireOutcomeWrites.get(companyId) === write) companyAcquireOutcomeWrites.delete(companyId); }
}
async function recordAcquireOutcome(companyId: string, environmentId: string, outcome: "spare" | "cold", reason?: AcquireOutcomeReason): Promise<void> {
  const outcomes = await loadCompanyAcquireOutcomes(companyId);
  const counts = outcomes.get(environmentId) ?? { spare: 0, cold: 0, reasons: {} };
  counts[outcome]++;
  if (outcome === "cold" && reason) counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1;
  outcomes.set(environmentId, counts);
  companyAcquireOutcomes.set(companyId, outcomes);
  await persistCompanyAcquireOutcomes(companyId, outcomes);
  const message = `[boat] acquire outcome=${outcome}${reason ? ` reason=${reason}` : ""} env=${encodeURIComponent(environmentId)}`;
  try { duplexLogger?.debug(message, { companyId, environmentId, outcome, ...(reason ? { reason } : {}) }); } catch { /* Logging never changes allocation outcome. */ }
}
function acquireOutcomeTotals(): { spare: number; cold: number } {
  let spare = 0, cold = 0;
  for (const outcomes of companyAcquireOutcomes.values()) for (const counts of outcomes.values()) {
    spare += counts.spare; cold += counts.cold;
  }
  return { spare, cold };
}
async function companySpareIsActive(companyId: string, idleMinutes: number): Promise<boolean> {
  const activity = await loadCompanySpareActivity(companyId);
  const latest = Math.max(activity.lastActivityAt ?? Number.NEGATIVE_INFINITY,
    activity.lastLeaseAcquiredAt ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(latest) && Date.now() - latest <= idleMinutes * 60_000;
}
async function recordCompanySpareActivity(companyId: string, leaseAcquired = false, waitForWake = false): Promise<void> {
  if (!companyId) return;
  const previous = await loadCompanySpareActivity(companyId);
  const now = Date.now();
  const activity: CompanySpareActivity = {
    lastActivityAt: Math.max(previous.lastActivityAt ?? Number.NEGATIVE_INFINITY, now),
    ...(leaseAcquired ? { lastLeaseAcquiredAt: Math.max(previous.lastLeaseAcquiredAt ?? Number.NEGATIVE_INFINITY, now) }
      : previous.lastLeaseAcquiredAt !== undefined ? { lastLeaseAcquiredAt: previous.lastLeaseAcquiredAt } : {}),
  };
  companySpareActivity.set(companyId, activity);
  await persistCompanySpareActivity(companyId, activity);
  const wake = wakeCompanySparePools(companyId);
  if (waitForWake) await wake;
  else void wake.catch(() => undefined);
}
function parse(raw: Record<string, unknown>): Config {
  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    provider: typeof raw.provider === "string" ? raw.provider : "boat",
    duplexCarrier: raw.duplexCarrier === "ssh" ? "ssh" : "off",
    ...(typeof raw.snapshot === "string" ? { snapshot: raw.snapshot } : {}),
    type: typeof raw.type === "string" ? raw.type : "small",
    ttlSeconds: Number(raw.ttlSeconds ?? 1800),
    setupTimeoutSeconds: Number(raw.setupTimeoutSeconds ?? 180),
    reuseLease: raw.reuseLease === true,
    runnerLifecycleMode: (raw.runnerLifecycleMode ?? "inherit") as RunnerConfig["runnerLifecycleMode"],
    runnerIdleTimeoutMs: Number(raw.runnerIdleTimeoutMs ?? DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS),
    ...(typeof raw.warmRunnerIdleTimeoutMs === "number" ? { warmRunnerIdleTimeoutMs: raw.warmRunnerIdleTimeoutMs } : {}),
    ...(typeof raw.runnerReconnectGraceMs === "number" ? { runnerReconnectGraceMs: raw.runnerReconnectGraceMs } : {}),
    retainOnDestroy: true, // Compatibility key only. Sandbox data is never deleted.
    labels: raw.labels && typeof raw.labels === "object" && !Array.isArray(raw.labels) ? raw.labels as Record<string, string> : {},
    ...(typeof raw.setupScript === "string" ? { setupScript: raw.setupScript } : {}),
    ...(typeof raw.from === "string" ? { from: raw.from } : {}),
    ...(typeof raw.pinnedSnapshotId === "string" ? { pinnedSnapshotId: raw.pinnedSnapshotId } : {}),
    ...(typeof raw.boatEnvironment === "string" ? { boatEnvironment: raw.boatEnvironment } : {}),
  };
}
type RequestErrorCategory = "request_error" | "network_error" | "http_error" | "parse_error" | "ambiguous_404";
/** Never retain provider/transport diagnostics, even as a cause. Only these safe
 * fields may cross the worker boundary; scrub the key from our own stack too. */
function requestError(config: Config, method: string, path: string, httpStatus: number | null, category: RequestErrorCategory): Error & { httpStatus: number | null; category: RequestErrorCategory } {
  const redact = (text: string) => config.apiKey ? text.split(config.apiKey).join("[REDACTED]") : text;
  const error = Object.assign(new Error(redact(`Boat ${method} ${path} failed (${httpStatus ?? "unavailable"}): ${category}`)), { httpStatus, category });
  if (error.stack) error.stack = redact(error.stack);
  return error;
}
async function request(config: Config, path: string, init: RequestInit = {}, allowMissing = false, responseOptions: { onHeaders?: (headers: Headers) => void; requireJson?: boolean; strictMissing?: boolean } = {}): Promise<any> {
  let category: RequestErrorCategory = "request_error";
  let httpStatus: number | null = null;
  try {
    if (init.method && init.method !== "GET") assertBoatActivityAdmission();
    const allocation = /^\/sandboxes\/([^/?]+)/.exec(path)?.[1];
    if (allocation) idleActivity.resource(activityKey(config, decodeURIComponent(allocation)));
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.apiKey}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const requestBody = init.body;
    const isStreamBody = requestBody !== null && typeof requestBody === "object" &&
      (typeof (requestBody as { getReader?: unknown }).getReader === "function" || typeof (requestBody as { pipe?: unknown }).pipe === "function");
    let response: Response;
    const deadline = Date.now() + BOAT_CALL_BUDGET_MS;
    const signal = init.signal ?? AbortSignal.timeout(BOAT_CALL_BUDGET_MS);
    const method = (init.method ?? "GET").toUpperCase();
    const retryable429Routes: { method: string; pattern: RegExp }[] = [
      // POST /sandboxes (create): docs/llms-full.txt lines 9864, 9889-9890, 2174.
      { method: "POST", pattern: /^\/sandboxes$/ },
      // POST /sandboxes/{sandboxId}/fork: docs/llms-full.txt lines 13240, 9889-9890.
      { method: "POST", pattern: /^\/sandboxes\/[^/?]+\/fork$/ },
      // POST /sandboxes/{sandboxId}/resume: docs/llms-full.txt lines 9889-9890 (resume is a start).
      { method: "POST", pattern: /^\/sandboxes\/[^/?]+\/resume$/ },
    ];
    // Not allowlisted: POST commands can execute (docs lines 1415-1416, 2115-2127); upload-url (1397-1398) and PUT files (1559-1560) lack a 429 no-execution guarantee.
    const retryableStart = retryable429Routes.some(route => route.method === method && route.pattern.test(path));
    for (let attempt = 1; ; attempt++) {
      category = "network_error";
      httpStatus = null;
      response = await fetch(`${API}${path}`, { ...init, headers, redirect: "error", signal });
      httpStatus = response.status;
      if (response.status !== 429) break;
      category = "http_error";
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterText = retryAfter ?? "<missing>";
      let retryAfterMs = 2_000;
      if (retryAfter !== null) {
        const seconds = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(retryAfter);
        const parsedDate = seconds ? NaN : Date.parse(retryAfter);
        if (seconds) retryAfterMs = Number(seconds[1]) * 1_000;
        else if (Number.isFinite(parsedDate)) retryAfterMs = Math.max(0, parsedDate - Date.now());
      }
      let errorCode: unknown;
      const body = await response.clone().json().catch(() => null);
      if (body && typeof body === "object") {
        const code = (body as any).code ?? (body as any).error?.code;
        if (typeof code === "string") errorCode = code;
      }
      const route = path.replace(/^\/sandboxes\/[^/]+/, "/sandboxes/{sandboxId}");
      duplexLogger?.warn("Boat API 429", {
        method, route, attempt: `${attempt}/${BOAT_MAX_ATTEMPTS}`, retryAfter: retryAfterText,
        rateLimit: response.headers.get("RateLimit"), rateLimitPolicy: response.headers.get("RateLimit-Policy"),
        ...(errorCode ? { code: errorCode } : {}),
      });
      await response.body?.cancel();
      if (!retryableStart || isStreamBody || attempt >= BOAT_MAX_ATTEMPTS || !["rate_limited", "limit_reached", "member_limit_reached"].includes(String(errorCode))) throw new Error(category);
      const remainingMs = deadline - Date.now();
      if (retryAfterMs > remainingMs || remainingMs <= 0) throw new Error(category);
      const waitMs = Math.min(remainingMs, retryAfterMs + Math.random() * retryAfterMs * 0.2);
      await delay(waitMs, undefined, { signal });
    }
    responseOptions.onHeaders?.(response.headers);
    if (allowMissing && response.status === 404) {
      if (!responseOptions.strictMissing) { await response.body?.cancel(); return null; }
      category = "ambiguous_404";
      // Boat's 404 'not_found' also covers an unknown route (details.path).
      const missing = await response.json();
      if (missing?.code === "not_found" && missing?.error?.details?.path === undefined) return null;
      throw new Error(category);
    }
    if (!response.ok) {
      category = "http_error";
      // Do not parse or retain provider message, nested error, or statusText.
      await response.body?.cancel();
      throw new Error(category);
    }
    category = "parse_error";
    const body = response.status === 204 ? null : await response.json().catch(error => {
      if (responseOptions.requireJson) throw error;
      return null;
    });
    if (responseOptions.requireJson && body === null) throw new Error(category);
    return body;
  } catch {
    throw requestError(config, init.method ?? "GET", path, httpStatus, category);
  }
}
/** Conservative inventory guard, NOT key-scope detection. Count Personal and
 * inactive rows too; active is only the default wallet for new sandboxes.
 * https://docs.boat.dev/api/reference/account/list-organizations.md */
async function soleBoatOrgId(config: Config): Promise<string | undefined> {
  const result = await request(config, "/orgs", { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000) }, false, { requireJson: true });
  if (result?.ok !== true || !Array.isArray(result.orgs) || result.orgs.length !== 1) return undefined;
  const org = result.orgs[0];
  return org?.type === "org" && typeof org.id === "string" && org.id.trim() ? org.id : undefined;
}
/** Strict RFC 3339 deadline parsing: reject Date.parse's permissive grammar and
 * calendar rollover, just as observedAt rejects impossible HTTP dates. */
function parseDeadline(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? value : null;
}
function assertSandboxId(sandbox: any, id: string): void {
  if (sandbox?.id !== id) throw new Error("Boat response returned a different allocation.");
}
/** Only the latest exact-ID observation can authorize retirement. team:null is
 * personal billing; omission is unknown, never the account's current wallet.
 * https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md (Sandbox.team) */
function boatOwnershipForLease(sandbox: any, id: string): { boatOrgId?: string; boatOwner?: { kind: "personal" } } {
  assertSandboxId(sandbox, id);
  if (sandbox.team === null) return { boatOwner: { kind: "personal" } };
  const orgId = sandbox.team?.id;
  return typeof orgId === "string" && orgId.trim() ? { boatOrgId: orgId } : {};
}
export type BoatSnapshotIdentity = { provider: "boat"; requestedRef: string; id: string; name: string; createdAt: string };
/** Resolve the mutable create name to its immutable artifact; never use the UUID as create.from. */
export async function resolveBoatSnapshotIdentity(config: Record<string, unknown>): Promise<BoatSnapshotIdentity> {
  const c = parse(config);
  if (!c.apiKey || !c.from || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(c.from)) throw new Error("Boat snapshot resolution requires apiKey and a valid saved-snapshot name in from.");
  // out/runner/boat-docs/get-saved-snapshot.md:36-54,61-72,86-135.
  const result = await request(c, `/saved-snapshots/${encodeURIComponent(c.from)}`);
  const snapshot = result?.snapshot;
  if (snapshot?.status !== "ready" || snapshot.name !== c.from || typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId.trim()
      || typeof snapshot.createdAt !== "string" || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new Error("Boat saved snapshot is not ready or omitted a valid matching identity.");
  }
  return { provider: "boat", requestedRef: c.from, id: snapshot.snapshotId, name: snapshot.name, createdAt: snapshot.createdAt };
}
type ResolvedSnapshot = { id: string; name: string; createdAt: string };
export type BoatLeaseSnapshotIdentity = ResolvedSnapshot & { provider: string; requestedRef: string; organizationId: string };
const SNAPSHOT_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
function snapshotConfigError(raw: Record<string, unknown>): string | null {
  if (raw.snapshot === undefined) return null;
  if (typeof raw.snapshot !== "string" || (!SNAPSHOT_UUID.test(raw.snapshot) && !SNAPSHOT_NAME.test(raw.snapshot))) {
    return "Boat snapshot must be a saved-snapshot name or UUID, without surrounding whitespace.";
  }
  if (raw.from !== undefined || raw.pinnedSnapshotId !== undefined) return "Boat snapshot cannot be combined with from or pinnedSnapshotId.";
  return null;
}
/** Boat create.from only accepts names. Resolve pins without substituting another
 * artifact, then re-read that exact name immediately before allocation. */
async function resolveSnapshotForCreate(config: Config): Promise<ResolvedSnapshot> {
  const reference = config.snapshot!;
  const pinned = SNAPSHOT_UUID.test(reference);
  let name = reference;
  if (pinned) {
    // Documented SavedSnapshotListResponse.snapshots; no limit/cursor supported:
    // https://docs.boat.dev/api/reference/snapshots/list-saved-snapshots.md
    const result = await request(config, "/saved-snapshots");
    if (!Array.isArray(result?.snapshots) || result.snapshots.some((s: unknown) => !s || typeof s !== "object" || Array.isArray(s))) {
      throw new Error("Boat saved-snapshot list omitted a valid snapshots array; sandbox creation refused.");
    }
    const matches = result.snapshots.filter((s: { snapshotId?: unknown }) => s.snapshotId === reference);
    if (matches.length === 0) throw new Error(`Boat pinned snapshot ${reference} not found; sandbox creation refused.`);
    if (matches.length !== 1) throw new Error(`Boat pinned snapshot ${reference} is ambiguous; sandbox creation refused.`);
    name = matches[0].name;
  }
  if (typeof name !== "string" || !SNAPSHOT_NAME.test(name)) throw new Error("Boat saved snapshot omitted a valid name identity.");
  const result = await request(config, `/saved-snapshots/${encodeURIComponent(name)}`);
  const snapshot = result?.snapshot;
  if (snapshot?.status !== "ready" || snapshot.name !== name
    || typeof snapshot.snapshotId !== "string" || !SNAPSHOT_UUID.test(snapshot.snapshotId)
    || typeof snapshot.createdAt !== "string" || !Number.isFinite(Date.parse(snapshot.createdAt))) {
    throw new Error("Boat saved snapshot is not ready or omitted a valid matching identity; sandbox creation refused.");
  }
  if (pinned && snapshot.snapshotId !== reference) throw new Error("Boat saved-snapshot identity mismatch at re-read; sandbox creation refused.");
  // For names, name === reference; for pins, snapshotId === reference. Preserve
  // the provider timestamp and requestedRef exactly, not a normalized surrogate.
  return { id: snapshot.snapshotId, name: snapshot.name, createdAt: snapshot.createdAt };
}
function q(v: string): string { return `'${v.replace(/'/g, `'"'"'`)}'`; }
function validEnv(env: Record<string, string> = {}): void {
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable: ${k}`);
}
async function waitReady(config: Config, id: string, allowArchived = false): Promise<any> {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const result = await request(config, `/sandboxes/${encodeURIComponent(id)}`);
    const s = result.sandbox ?? result;
    assertSandboxId(s, id);
    if (["ready", "idle", "running"].includes(s.state)) return s;
    if (s.state === "error" || (!allowArchived && s.state === "archived")) throw new Error(`Boat sandbox ${id} entered ${s.state}`);
    // Bounded transition observation only; no idle worker poller. Ready webhook
    // delivery belongs to the host; this acquisition has no callback endpoint.
    await delay(Math.min(500, Math.max(0, until - Date.now())));
  }
  throw new Error(`Boat sandbox ${id} readiness timed out`);
}
async function waitSetup(config: Config, id: string): Promise<any> {
  const until = Date.now() + config.setupTimeoutSeconds * 1000;
  while (Date.now() < until) {
    const result = await request(config, `/sandboxes/${encodeURIComponent(id)}`);
    const s = result.sandbox ?? result;
    assertSandboxId(s, id);
    if (s.setupStatus === "done") return s;
    if (s.setupStatus === "failed") {
      const detail = typeof s.setupError === "string" ? s.setupError : typeof s.setupErrorText === "string" ? s.setupErrorText : typeof s.error === "string" ? s.error : s.error?.message;
      throw new Error(`Boat sandbox ${id} setup failed${detail ? `: ${detail}` : "."}`);
    }
    await delay(Math.min(2000, Math.max(0, until - Date.now())));
  }
  throw new Error(`Boat sandbox ${id} setup timed out after ${config.setupTimeoutSeconds} seconds`);
}
async function stopSandbox(config: Config, id: string): Promise<{ providerLeaseId: string; state: "stopped" }> {
  idleActivity.resource(activityKey(config, id));
  const proof = idleActivity.proof(activityKey(config, id));
  const stopped = await request(config, `/sandboxes/${encodeURIComponent(id)}/stop`, { method: "POST", body: JSON.stringify({}) });
  // Boat documents the operation as `stop`; OpenAPI may expose `operation`.
  // https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox.md
  const operation = stopped?.stop ?? stopped?.operation ?? stopped?.sandbox?.stop;
  const stopId = typeof operation?.id === "string" && operation.id.trim() ? operation.id : undefined;
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    // Boat's documented poll is GET /sandboxes/{id}; it also confirms a 200
    // already-stopped response before we report success without an operation id.
    const result = await request(config, `/sandboxes/${encodeURIComponent(id)}`);
    const sandbox = result.sandbox ?? result;
    assertSandboxId(sandbox, id);
    const seen = sandbox.stop ?? result.stop ?? result.operation;
    const stop = seen ?? operation;
    // A completed stop counts only when GET confirms the id returned by POST /stop.
    if (["archived", "stopped"].includes(sandbox.state) || (stopId !== undefined && seen?.id === stopId && seen?.status === "completed")) {
      idleActivity.confirm(proof); return { providerLeaseId: id, state: "stopped" };
    }
    // A missing id on 202 is not failure: observe the sandbox until its stop
    // appears/completes or it reaches the documented archived state.
    const observedId = typeof stop?.id === "string" && stop.id.trim() ? stop.id : stopId;
    if (observedId && stop?.status && !["pending", "failing", "completed"].includes(stop.status)) {
      throw new Error(`Boat stop ${observedId} entered ${stop.status}`);
    }
    // Boat retries failing saves; never force a stop or discard unsaved files.
    await delay(1500);
  }
  throw new Error(`Boat stop ${stopId ?? id} did not complete`);
}
// Existing SDK ownership envelope, consumed by core's creation inspection/reaper.
function cleanupIdentity(config: Config, id: string, owner: { companyId: string; environmentId: string; runId?: string }, attemptId: string): PluginEnvironmentCreationCleanup {
  return { providerLeaseId: id, observedProviderLeaseId: id, companyId: owner.companyId,
    environmentId: owner.environmentId, runId: owner.runId, attemptId,
    accountFingerprint: createHash("sha256").update(`${API}\n${config.apiKey}`).digest("hex"),
    labels: { "paperclip-acquire": attemptId } };
}
async function acquisitionMatches(config: Config, attemptId: string, owner: { companyId: string; environmentId: string; runId?: string }): Promise<string[]> {
  // Documented repeated label=key=value and pageInfo.nextCursor; do not scan all accounts.
  // https://docs.boat.dev/api/reference/sandboxes/list-sandboxes.md
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ label: `paperclip-acquire=${attemptId}`, limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const result = await request(config, `/sandboxes?${query}`, { signal: AbortSignal.timeout(10_000) });
    if (!Array.isArray(result?.sandboxes)) throw new Error("Boat acquisition lookup omitted sandboxes");
    for (const sandbox of result.sandboxes) {
      if (typeof sandbox?.id !== "string" || !sandbox.id || sandbox.labels?.["paperclip-acquire"] !== attemptId ||
          sandbox.labels.owner !== `paperclip:${owner.companyId}` || sandbox.labels.environment !== owner.environmentId ||
          (owner.runId !== undefined && sandbox.labels.run !== owner.runId)) throw new Error("Boat acquisition lookup returned foreign ownership");
      ids.add(sandbox.id);
    }
    cursor = result.pageInfo?.nextCursor ?? undefined;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 100)) throw new Error("Boat acquisition lookup pagination did not converge");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...ids];
}
async function cleanupAcquisition(config: Config, ids: string[], owner: { companyId: string; environmentId: string; runId?: string }, attemptId: string, cause: unknown): Promise<void> {
  const failures: unknown[] = []; let firstFailed: string | undefined;
  for (const id of ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await stopSandbox(config, id); break; }
      catch (error) {
        if (attempt === 2) { firstFailed ??= id; failures.push(error); }
        else await delay(250 * 2 ** attempt);
      }
    }
  }
  if (firstFailed) throw new PluginEnvironmentCreationCleanupError([cause, ...failures],
    `Boat acquire failed and cleanup of ${firstFailed} was not confirmed.`, cleanupIdentity(config, firstFailed, owner, attemptId));
}
async function runCommand(config: Config, id: string, command: string, timeoutMs: number, cwd?: string, signal?: AbortSignal): Promise<PluginEnvironmentExecuteResult> {
  const timeoutSeconds = Math.max(1, Math.min(600, Math.ceil(timeoutMs / 1000)));
  const started = await request(config, `/sandboxes/${encodeURIComponent(id)}/commands`, {
    method: "POST", signal: signal ?? AbortSignal.timeout(timeoutMs > 600_000 ? 30_000 : timeoutSeconds * 1000 + 5_000),
    body: JSON.stringify({ command, timeoutSeconds, detached: timeoutMs > 600_000, ...(cwd !== undefined ? { cwd } : {}) }),
  });
  if (!started.processId) return {
    exitCode: Number.isInteger(started.exitCode) ? started.exitCode : null,
    timedOut: started.timedOut === true,
    stdout: started.stdout ?? "", stderr: started.stderr ?? "",
  };
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await request(config, `/sandboxes/${encodeURIComponent(id)}/commands/${encodeURIComponent(started.processId)}`, { signal });
    if (result.running === false || result.status === "completed" || result.status === "exited") return {
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      timedOut: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
      signal: result.signal ?? null,
    };
    await delay(1000, undefined, { signal });
  }
  await request(config, `/sandboxes/${encodeURIComponent(id)}/commands/${encodeURIComponent(started.processId)}`, { method: "DELETE", signal }).catch(() => undefined);
  return { exitCode: null, timedOut: true, stdout: "", stderr: "Command exceeded Paperclip timeout and was stopped." };
}
function leaseActivityKey(params: Omit<DuplexLease, "providerLeaseId">, id: string): string {
  return createHash("sha256").update(JSON.stringify([params.driverKey, ingressScopeKey(params, parse(params.config), id)])).digest("hex");
}
let duplexContext: PluginContext["duplexChannel"] | undefined;
let duplexLogger: PluginContext["logger"] | undefined;
const sshCarrier = new BoatSshCarrier(lease => {
  const config = parse(lease.config);
  return { request: (path, init) => request(config, path, init), run: (command, timeout, signal) => runCommand(config, lease.providerLeaseId, command, timeout, undefined, signal) };
});
const duplexChannels = new BoatDuplexChannels({
  prepare: lease => sshCarrier.prepare(lease), connect: connectSsh,
  notify: { data: (...args) => duplexContext?.data(...args), exit: (...args) => duplexContext?.exit(...args) },
  activity: (lease, run) => withBoatLeaseActivity(leaseActivityKey(lease, lease.providerLeaseId), async () => {
    assertBoatActivityAdmission(); return run();
  }),
});
async function bindDuplexLease(params: Omit<DuplexLease, "providerLeaseId">, id: string, guardianPreflight?: GuardianPreflight): Promise<void> {
  const lease = { driverKey: params.driverKey, companyId: params.companyId, environmentId: params.environmentId, config: params.config, providerLeaseId: id, guardianPreflight };
  if (params.config.duplexCarrier !== "ssh") {
    await duplexChannels.suspend(lease); await sshCarrier.retire(lease); return;
  }
  // Never expose a newly bound route while old-key cleanup is still pending.
  // Otherwise a concurrent hook can authenticate before acquire/resume returns.
  await duplexChannels.suspend(lease);
  try { await sshCarrier.prewarm(lease); }
  catch (error) {
    await duplexChannels.suspend(lease, error instanceof BoatDuplexError ? error : undefined);
    throw error;
  }
  duplexChannels.bind(lease);
}
async function retireForLifecycle(lease: DuplexLease): Promise<SshRetireWarning[]> {
  if (lease.config.duplexCarrier === "ssh" || sshCarrier.hasState(lease)) {
    // Finish any in-flight install before deciding whether guest file/command
    // retirement is safe; duplex suspension above prevents new opens racing it.
    await sshCarrier.waitForPending(lease);
    const config = parse(lease.config);
    const result = await request(config, `/sandboxes/${encodeURIComponent(lease.providerLeaseId)}`);
    const sandbox = result.sandbox ?? result;
    assertSandboxId(sandbox, lease.providerLeaseId);
    // Key retirement uploads a helper to /files and runs /commands. Neither may
    // be sent after Boat archived the box, because direct calls can start it.
    if (["archived", "stopped"].includes(sandbox.state)) {
      await sshCarrier.deferRetireUntilResume(lease);
      return [];
    }
  }
  try { await sshCarrier.retire(lease); return []; }
  catch (error) {
    if (!(error instanceof BoatDuplexError) || error.code !== "BOAT_SSH_RETIRE_FAILED") throw error;
    const warning: SshRetireWarning = { code: error.code, attempts: SSH_RETIRE_ATTEMPTS };
    duplexLogger?.warn(warning.code, { ...warning, companyId: lease.companyId, environmentId: lease.environmentId, providerLeaseId: lease.providerLeaseId });
    return [warning];
  }
}
function createSandboxBody(config: Config, ttlSeconds: number, labels: Record<string, unknown>, from?: string): Record<string, unknown> {
  return {
    type: config.type, ttlSeconds, labels,
    ...(config.boatEnvironment === undefined ? { noEnv: true } : {}),
    ...(config.setupScript !== undefined ? { setupScript: config.setupScript } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(config.boatEnvironment !== undefined ? { environment: config.boatEnvironment } : {}),
  };
}
function readySpareHash(config: Config, ttlSeconds: number, from: string | undefined, snapshot?: ResolvedSnapshot | BoatSnapshotIdentity): string {
  return readySpareConfigHash({
    ...createSandboxBody(config, ttlSeconds, config.labels, from),
    configuredSnapshot: config.snapshot ?? null,
    resolvedSnapshot: snapshot ? { id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt } : null,
    pinnedSnapshotId: config.pinnedSnapshotId ?? null,
    accountFingerprint: createHash("sha256").update(`${API}\n${config.apiKey}`).digest("hex"),
  });
}
async function listBoatSandboxes(config: Config, labels: Array<[string, string]>): Promise<any[]> {
  const sandboxes: any[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "200" });
    for (const [key, value] of labels) query.append("label", `${key}=${value}`);
    if (cursor) query.set("cursor", cursor);
    const result = await request(config, `/sandboxes?${query}`, { signal: AbortSignal.timeout(2500) }, false, { requireJson: true });
    if (!Array.isArray(result?.sandboxes)) throw new Error("Boat sandbox inventory omitted a sandboxes array");
    for (const sandbox of result.sandboxes) {
      if (!sandbox || typeof sandbox !== "object" || typeof sandbox.id !== "string" || !sandbox.id || !sandbox.labels || typeof sandbox.labels !== "object") {
        throw new Error("Boat sandbox inventory returned an incomplete sandbox record");
      }
      sandboxes.push(sandbox);
    }
    cursor = result.pageInfo?.nextCursor ?? undefined;
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 100)) {
      throw new Error("Boat sandbox inventory pagination did not converge");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return sandboxes;
}
function readySpareFromSandbox(sandbox: any, ttlSeconds: number): ReadySpare {
  const labels = Object.fromEntries(Object.entries(sandbox.labels ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const owner = typeof labels.owner === "string" && labels.owner.startsWith("paperclip:") ? labels.owner.slice("paperclip:".length) : "";
  const key: ReadySpareKey = { companyId: owner, environmentId: labels.environment ?? "", configHash: labels.configHash ?? "" };
  const name = typeof sandbox.name === "string" ? sandbox.name : "";
  const expiresAt = parseDeadline(sandbox.archiveAfter) ?? parseDeadline(sandbox.expiresAt) ?? parseDeadline(sandbox.autoStopAt) ?? labels.expiry ?? "";
  return {
    id: sandbox.id, key, state: typeof sandbox.state === "string" ? sandbox.state : "unknown",
    warmed: name === `paperclip-spare:ready:${key.configHash}`, expiresAt, ttlSeconds, name, labels,
    providerObservation: sandbox as Record<string, unknown>,
  };
}
async function createAndWarmSpare(config: Config, key: ReadySpareKey, ttlSeconds: number, from?: string): Promise<ReadySpare> {
  const expiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const labels = { ...config.labels, owner: `paperclip:${key.companyId}`, purpose: "spare", expiry,
    environment: key.environmentId, configHash: key.configHash };
  const created = await request(config, "/sandboxes", {
    method: "POST", signal: AbortSignal.timeout(30_000), headers: { "Idempotency-Key": randomUUID() },
    body: JSON.stringify(createSandboxBody(config, ttlSeconds, labels, from)),
  });
  const sandbox = created?.sandbox ?? created;
  if (typeof sandbox?.id !== "string" || !sandbox.id) throw new Error("Boat spare create response omitted sandbox.id");
  idleActivity.resource(activityKey(config, sandbox.id));
  try {
    const ready = await waitReady(config, sandbox.id);
    const setup = config.setupScript === undefined ? ready : await waitSetup(config, sandbox.id);
    const warmCommand = `printf '{"type":"get_state","id":"1"}\\n' | PI_CODING_AGENT_DIR=/home/user/.pi/agent timeout 25 pi --mode rpc --no-session >/dev/null`;
    const warmed = await runCommand(config, sandbox.id, warmCommand, 25_000);
    if (warmed.exitCode !== 0 || warmed.timedOut) throw new Error("Boat spare Pi warm-up did not complete successfully");
    const name = `paperclip-spare:ready:${key.configHash}`;
    const updated = await request(config, `/sandboxes/${encodeURIComponent(sandbox.id)}`, {
      method: "PATCH", signal: AbortSignal.timeout(5_000), body: JSON.stringify({ name, ttlSeconds }),
    }, false, { requireJson: true });
    const warmedSandbox = updated?.sandbox ?? updated;
    if (warmedSandbox?.id !== sandbox.id || !["ready", "idle", "running"].includes(warmedSandbox.state)) {
      throw new Error("Boat spare was not running after Pi warm-up");
    }
    const observation = { ...setup, ...warmedSandbox, id: sandbox.id, name };
    return readySpareFromSandbox({ ...observation, labels }, ttlSeconds);
  } catch (error) {
    try { await stopSandbox(config, sandbox.id); } catch { /* Boat-side TTL remains the crash-safe stop. */ }
    throw error;
  }
}
function createReadySpareOperations(config: Config, key: ReadySpareKey, ttlSeconds: number, from?: string): ReadySpareOperations {
  const scoped = [["owner", `paperclip:${key.companyId}`], ["environment", key.environmentId], ["purpose", "spare"]] as Array<[string, string]>;
  return {
    async list() {
      const sandboxes = await listBoatSandboxes(config, scoped);
      return sandboxes.filter(sandbox => sandbox.labels.owner === `paperclip:${key.companyId}` && sandbox.labels.environment === key.environmentId && sandbox.labels.purpose === "spare")
        .map(sandbox => readySpareFromSandbox(sandbox, ttlSeconds));
    },
    create: () => createAndWarmSpare(config, key, ttlSeconds, from),
    async claim(spare, name, claimTtlSeconds) {
      const result = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "PATCH", signal: AbortSignal.timeout(2500), body: JSON.stringify({ name, ttlSeconds: claimTtlSeconds }),
      }, false, { requireJson: true });
      const patched = result?.sandbox ?? result;
      if (patched?.id !== spare.id || !["ready", "idle", "running"].includes(patched.state) || (patched.name && patched.name !== name)) return false;
      const observed = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
      }, false, { requireJson: true });
      const sandbox = observed?.sandbox ?? observed;
      if (sandbox?.id !== spare.id || !["ready", "idle", "running"].includes(sandbox.state) || sandbox.name !== name) return false;
      spare.name = name;
      spare.state = sandbox.state;
      spare.expiresAt = parseDeadline(sandbox.archiveAfter) ?? parseDeadline(sandbox.expiresAt) ?? new Date(Date.now() + claimTtlSeconds * 1000).toISOString();
      spare.ttlSeconds = claimTtlSeconds;
      spare.providerObservation = { ...(spare.providerObservation ?? {}), ...sandbox, id: spare.id, name };
      return true;
    },
    async refresh(spare, refreshTtlSeconds) {
      const requestedAt = Date.now();
      const result = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "PATCH", signal: AbortSignal.timeout(5_000), body: JSON.stringify({ ttlSeconds: refreshTtlSeconds }),
      }, false, { requireJson: true });
      const sandbox = result?.sandbox ?? result;
      if (sandbox?.id !== spare.id || !["ready", "idle", "running"].includes(sandbox.state)) throw new Error("Boat spare TTL refresh returned an unhealthy sandbox");
      const expiresAt = parseDeadline(sandbox.archiveAfter) ?? parseDeadline(sandbox.expiresAt);
      if (!expiresAt || Math.abs(Date.parse(expiresAt) - (requestedAt + refreshTtlSeconds * 1000)) > 120_000) throw new Error("Boat spare TTL refresh was not confirmed");
      return { ...spare, state: sandbox.state, expiresAt, ttlSeconds: refreshTtlSeconds,
        providerObservation: { ...(spare.providerObservation ?? {}), ...sandbox } };
    },
    stop: async spare => { await stopSandbox(config, spare.id); },
    async allowCreate() {
      const inventory = await listBoatSandboxes(config, [["owner", `paperclip:${key.companyId}`], ["purpose", "spare"]]);
      const cutoff = Date.now() - 60 * 60 * 1000;
      let recent = 0;
      for (const sandbox of inventory) {
        if (sandbox.labels.owner !== `paperclip:${key.companyId}` || sandbox.labels.purpose !== "spare") throw new Error("Boat hourly spare inventory returned foreign ownership");
        const createdAt = Date.parse(sandbox.createdAt);
        if (!Number.isFinite(createdAt)) return false;
        if (createdAt >= cutoff) recent++;
      }
      return recent < 12;
    },
  };
}
function clearSpareRefreshTimerIfIdle(): void {
  if ([...knownSparePools.values()].some(pool => pool.desired > 0)) return;
  if (spareRefreshTimer) clearInterval(spareRefreshTimer);
  spareRefreshTimer = undefined;
}
function ensureSpareRefreshTimer(): void {
  if (spareRefreshTimer || shuttingDown) return;
  spareRefreshTimer = setInterval(() => { void maintainReadySpares().catch(() => undefined); }, 15_000);
  spareRefreshTimer.unref?.();
}
function queueSpareReconciliation(key: ReadySpareKey, desired: number, ttlSeconds: number, operations: ReadySpareOperations,
  idleMinutes = readySpareIdleMinutes(undefined), policy = { baseDesired: desired, spareMax: desired, demandWindowMinutes: 10 }): void {
  if (shuttingDown) return;
  if (desired <= 0) {
    for (const pool of knownSparePools.values()) {
      if (pool.key.companyId !== key.companyId || pool.key.environmentId !== key.environmentId || pool.desired <= 0) continue;
      pool.desired = 0;
      void readySpares.reconcile(pool.key, 0, pool.operations).catch(() => undefined);
    }
    clearSpareRefreshTimerIfIdle();
    return;
  }
  ensureSpareRefreshTimer();
  const poolId = readySparePoolKey(key);
  for (const [oldPoolId, oldPool] of knownSparePools) {
    if (oldPool.key.companyId !== key.companyId || oldPool.key.environmentId !== key.environmentId
        || oldPool.key.configHash === key.configHash || oldPool.desired === 0) continue;
    oldPool.desired = 0;
    // A create already in flight under the previous config may finish after the
    // first retire pass. Reconcile again after it settles, but only if it left a
    // cached candidate; claimed run leases are absent from that cache.
    void readySpares.reconcile(oldPool.key, 0, oldPool.operations).catch(() => undefined).finally(() => {
      if (readySpares.ready(oldPool.key).length) void readySpares.reconcile(oldPool.key, 0, oldPool.operations).catch(() => undefined);
    });
    knownSparePools.set(oldPoolId, oldPool);
  }
  knownSparePools.set(poolId, { key, ttlSeconds, desired, ...policy, idleMinutes, operations, idleStopped: false });
  void readySpares.reconcile(key, desired, operations).catch(() => {
    duplexLogger?.warn("Boat ready spare reconciliation failed", { companyId: key.companyId, environmentId: key.environmentId });
  });
}
async function wakeCompanySparePools(companyId: string): Promise<void> {
  const work: Promise<void>[] = [];
  for (const pool of knownSparePools.values()) {
    if (pool.key.companyId !== companyId || pool.baseDesired <= 0) continue;
    pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
    pool.idleStopped = false;
    work.push(readySpares.reconcile(pool.key, pool.desired, pool.operations).catch(error => {
      duplexLogger?.warn("Boat ready spare wake reconciliation failed", { companyId, environmentId: pool.key.environmentId });
      throw error;
    }));
  }
  await Promise.all(work);
}
async function maintainReadySpares(reconcile = false): Promise<void> {
  if (shuttingDown || ![...knownSparePools.values()].some(pool => pool.desired > 0)) return;
  if (spareMaintenanceWork) return spareMaintenanceWork;
  const work = (async () => {
    const activeByPool = new Map<string, boolean>();
    for (const [poolId, pool] of knownSparePools) {
      if (shuttingDown) return;
      activeByPool.set(poolId, await companySpareIsActive(pool.key.companyId, pool.idleMinutes));
    }
    await readySpares.refreshDue(READY_SPARE_TTL_SECONDS, key => {
      const poolId = readySparePoolKey(key);
      return activeByPool.get(poolId) ? knownSparePools.get(poolId)?.operations : undefined;
    });
    // The periodic timer has no host-derived invocation scope, so it cannot
    // perform claim-store queries. Scoped health calls and company events do
    // the full reconciliation; the timer only renews cached warm leases.
    if (!reconcile) return;
    for (const [poolId, pool] of knownSparePools) {
      if (shuttingDown) return;
      pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
      const active = activeByPool.get(poolId) === true;
      if (!active) {
        if (!pool.idleStopped) {
          await readySpares.reconcile(pool.key, 0, pool.operations);
          pool.idleStopped = true;
        }
        continue;
      }
      const wasIdleStopped = pool.idleStopped;
      pool.idleStopped = false;
      if (wasIdleStopped || pool.desired !== readySpares.ready(pool.key).length || readySpares.isRefilling(pool.key)) {
        await readySpares.reconcile(pool.key, pool.desired, pool.operations);
      }
    }
  })();
  spareMaintenanceWork = work;
  try { await work; }
  finally { if (spareMaintenanceWork === work) spareMaintenanceWork = undefined; }
}
async function finishAcquisition(
  params: PluginEnvironmentAcquireLeaseParams,
  config: Config,
  id: string,
  ready: any,
  labels: Record<string, unknown>,
  remoteCwd: string,
  snapshot: ResolvedSnapshot | undefined,
  claimName: string | null,
  claimedSpare?: ReadySpare,
): Promise<PluginEnvironmentLease> {
  if (claimedSpare) {
    if (!claimedSpare.warmed || !["ready", "idle", "running"].includes(ready?.state)
        || ready?.name !== claimName || claimedSpare.labels.owner !== `paperclip:${params.companyId}`
        || claimedSpare.labels.environment !== params.environmentId || claimedSpare.labels.purpose !== "spare"
        || claimedSpare.labels.configHash !== claimedSpare.key.configHash) {
      throw new Error("Boat ready spare ownership or health check failed");
    }
  }
  const ownership = boatOwnershipForLease(ready, id);
  let snapshotIdentity: BoatLeaseSnapshotIdentity | undefined;
  if (params.resolveSnapshotIdentity === true && snapshot) {
    const organizationId = ownership.boatOrgId;
    if (typeof organizationId !== "string" || !organizationId.trim()) {
      throw new Error("Boat snapshot identity requires a team organizationId on the created sandbox.");
    }
    snapshotIdentity = { provider: config.provider, requestedRef: config.snapshot!, ...snapshot, organizationId };
  }
  const expiry = ready.archiveAfter ?? ready.expiresAt ?? ready.autoStopAt ?? null;
  const workspaceSentinel = await writeWorkspaceSentinel(params, config, id, remoteCwd, {
    request: (path, init) => request(config, path, init), run: (command, timeout) => runCommand(config, id, command, timeout),
  });
  const guardianPreflight = await stageGuardian(params.config, id, {
    request: (path, init) => request(config, path, init), run: (command, timeout) => runCommand(config, id, command, timeout),
  });
  await bindDuplexLease(params, id, guardianPreflight);
  return { providerLeaseId: id, expiresAt: expiry, metadata: { provider: config.provider, sandboxId: id, remoteCwd,
    ...ownership,
    ...(guardianPreflight ? { guardianPreflight, runnerGuardianVersion: 1 } : {}),
    ...(config.snapshot === undefined ? {} : { snapshot: config.snapshot }),
    ...(snapshotIdentity ? { snapshotIdentity } : {}),
    adapterType: params.adapterType ?? null, reuseLease: config.reuseLease, resumedLease: false, labels: config.labels,
    providerLabels: labels, providerClaimName: claimName,
    workspaceSentinel, ...("allocationFiles" in workspaceSentinel ? { workspaceAllocationFiles: workspaceSentinel.allocationFiles } : {}) } };
}

const plugin = definePlugin(trackBoatHooks(gateBoatHooks({
  async setup(ctx) {
    shuttingDown = false;
    readySpares.start();
    knownSparePools.clear();
    pluginContext = ctx; duplexContext = ctx.duplexChannel; duplexLogger = ctx.logger;
    for (const unsubscribe of activityUnsubscribers) unsubscribe();
    activityUnsubscribers = [];
    activitySubscriptionCompanies.clear();
    try {
      spareClaimStore = ctx.db?.namespace && /^[a-z][a-z0-9_]*$/.test(ctx.db.namespace)
        ? createReadySpareClaimStore(ctx.db)
        : undefined;
    } catch { spareClaimStore = undefined; }
    readySpares.setClaimStore(spareClaimStore);
    if (spareRefreshTimer) clearInterval(spareRefreshTimer);
    spareRefreshTimer = undefined;
    ctx.logger.info("Boat sandbox provider ready; guardian requires per-lease SSH preflight");
  },
  multiCompanyConfig: true,
  async onConfigChanged(newConfig, context) {
    // Company/global plugin config is NOT the environment's effective config.
    // Company spare policy is instance config; environment lease config remains
    // the source for Boat credentials and create-shaping fields.
    const companyId = context?.companyId;
    if (!companyId) return;
    subscribeCompanyActivity(companyId);
    const configuredCount = readySpareCount(newConfig);
    const environments = readySpareEnvironmentIds(newConfig);
    const spareMax = readySpareMax(newConfig);
    const demandWindowMinutes = readySpareDemandWindowMinutes(newConfig);
    const idleMinutes = readySpareIdleMinutes(newConfig);
    const active = await companySpareIsActive(companyId, idleMinutes);
    for (const pool of knownSparePools.values()) {
      if (pool.key.companyId !== companyId) continue;
      pool.baseDesired = environments.includes(pool.key.environmentId) ? configuredCount : 0;
      pool.spareMax = spareMax;
      pool.demandWindowMinutes = demandWindowMinutes;
      pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
      pool.idleMinutes = idleMinutes;
      try {
        await readySpares.reconcile(pool.key, active ? pool.desired : 0, pool.operations);
        pool.idleStopped = !active;
      } catch {
        duplexLogger?.warn("Boat ready spare config reconciliation failed", { companyId, environmentId: pool.key.environmentId });
      }
    }
    clearSpareRefreshTimerIfIdle();
  },
  onDuplexChannelOpen: params => duplexChannels.open(params),
  onDuplexChannelWrite: params => duplexChannels.write(params),
  onDuplexChannelStop: params => duplexChannels.stop(params),
  onDuplexChannelClose: params => duplexChannels.close(params),
  async onHealth() {
    try {
      let checked = 0;
      for (const lease of duplexChannels.activeLeases().filter(lease => lease.guardianPreflight?.usable)) {
        await withBoatLeaseActivity(leaseActivityKey(lease, lease.providerLeaseId), async () => {
          if (!duplexChannels.isActive(lease)) return;
          await sshCarrier.health(lease); checked++;
        });
      }
      await maintainReadySpares(true);
      const totals = acquireOutcomeTotals();
      const status = checked ? `Boat resident status probes passed for ${checked} bound leases (not live Boat qualification).` : "Boat sandbox provider healthy";
      return { status: "ok", message: `${status}; acquire outcomes spare=${totals.spare} cold=${totals.cold}` };
    } catch {
      const totals = acquireOutcomeTotals();
      return { status: "error", message: `Boat SSH guardian status probe failed; acquire outcomes spare=${totals.spare} cold=${totals.cold}` };
    }
  },
  async onShutdown() {
    shuttingDown = true;
    readySpares.stop();
    for (const unsubscribe of activityUnsubscribers) unsubscribe();
    activityUnsubscribers = [];
    activitySubscriptionCompanies.clear();
    if (spareRefreshTimer) clearInterval(spareRefreshTimer);
    spareRefreshTimer = undefined;
    try {
      try {
        await Promise.allSettled([...inFlightAcquisitions]);
        if (spareMaintenanceWork) await spareMaintenanceWork.catch(() => undefined);
        await readySpares.drain();
        await Promise.all([...companySpareActivityWrites.values(), ...companyAcquireOutcomeWrites.values()].map(write => write.catch(() => undefined)));
      } finally {
        try { await duplexChannels.shutdown(); } finally { await sshCarrier.close(); }
      }
    } finally {
      readySpares.reset();
      knownSparePools.clear();
      spareClaimStore = undefined;
      duplexContext = undefined; duplexLogger = undefined; pluginContext = undefined; runnerIngressGenerationStore.reset();
      // The host process exits after this hook. Clearing the transition flag
      // also lets in-process worker harnesses start their next simulated worker.
      shuttingDown = false;
    }
    knownSparePools.clear(); companySpareActivity.clear(); companySpareActivityLoads.clear(); companySpareActivityWrites.clear();
    companyAcquireOutcomes.clear(); companyAcquireOutcomeLoads.clear(); companyAcquireOutcomeWrites.clear();
    duplexContext = undefined; duplexLogger = undefined; pluginContext = undefined; runnerIngressGenerationStore.reset();
  },
  async onIdleDrain() { return idleActivity.present() || duplexChannels.present() || readySpares.present() ? "present" : "none"; },
  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams): Promise<PluginEnvironmentValidationResult> {
    const c = parse(params.config); const errors: string[] = [];
    if (!c.apiKey) errors.push("Boat apiKey is required.");
    if (params.config.duplexCarrier !== undefined && !["off", "ssh"].includes(String(params.config.duplexCarrier))) errors.push("duplexCarrier must be off or ssh.");
    const snapshotError = snapshotConfigError(params.config);
    if (snapshotError) errors.push(snapshotError);
    if (params.config.reuseLease !== undefined && typeof params.config.reuseLease !== "boolean") errors.push("reuseLease must be a boolean.");
    if (!["inherit", "per_turn", "warm"].includes(c.runnerLifecycleMode)) errors.push("runnerLifecycleMode must be inherit, per_turn, or warm.");
    if (!Number.isInteger(c.runnerIdleTimeoutMs) || c.runnerIdleTimeoutMs < 1000 || c.runnerIdleTimeoutMs > 86_400_000) errors.push("runnerIdleTimeoutMs must be an integer from 1000 through 86400000.");
    for (const field of ["warmRunnerIdleTimeoutMs", "runnerReconnectGraceMs"] as const) {
      const value = params.config[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 86_400_000)) errors.push(`${field} must be an integer from 0 through 86400000.`);
    }
    if (params.config.retainOnDestroy !== undefined && typeof params.config.retainOnDestroy !== "boolean") errors.push("retainOnDestroy must be a boolean.");
    if (params.config.setupScript !== undefined && typeof params.config.setupScript !== "string") errors.push("setupScript must be a string.");
    for (const field of ["from", "boatEnvironment", "pinnedSnapshotId"]) {
      if (params.config[field] !== undefined && (typeof params.config[field] !== "string" || !(params.config[field] as string).trim())) errors.push(`${field} must be a non-empty string.`);
    }
    if (params.config.pinnedSnapshotId !== undefined && !c.from?.trim()) errors.push("pinnedSnapshotId requires a saved-snapshot name in from.");
    if (c.setupScript !== undefined && new TextEncoder().encode(c.setupScript).length > 16 * 1024) errors.push("setupScript must be at most 16 KiB.");
    if (!["small", "default", "large", "xlarge"].includes(c.type)) errors.push("type must be small, default, large, or xlarge.");
    if (!Number.isInteger(c.ttlSeconds) || c.ttlSeconds < 60 || c.ttlSeconds > 2_592_000) errors.push("ttlSeconds must be an integer from 60 through 2592000.");
    if (!Number.isInteger(c.setupTimeoutSeconds) || c.setupTimeoutSeconds < 1 || c.setupTimeoutSeconds > 600) errors.push("setupTimeoutSeconds must be an integer from 1 through 600.");
    if (Object.keys(c.labels).length > 15 || Object.entries(c.labels).some(([k,v]) => !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/.test(k) || typeof v !== "string" || new TextEncoder().encode(v).length > 256)) errors.push("labels must have valid Boat keys, values <=256 bytes, and at most 15 entries (ownership labels are added).");
    return errors.length ? { ok: false, errors } : { ok: true, normalizedConfig: {
      ...c, ...(params.config.duplexCarrier === undefined ? {} : { duplexCarrier: params.config.duplexCarrier }),
    } };
  },
  async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    try { const result = await request(parse(params.config), "/limits"); return { ok: true, summary: "Boat API reachable.", metadata: { provider: "boat", limits: result } }; }
    catch (e) { return { ok: false, summary: "Boat API probe failed.", metadata: { provider: "boat", error: e instanceof Error ? e.message : String(e) } }; }
  },
  onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    if (shuttingDown) return Promise.reject(new Error("Boat provider is shutting down"));
    let outcomeRecorded = false;
    const recordOutcomeOnce = async (outcome: "spare" | "cold", reason?: AcquireOutcomeReason) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      await recordAcquireOutcome(params.companyId, params.environmentId, outcome, reason);
    };
    const work = (async (): Promise<PluginEnvironmentLease> => {
      await recordCompanySpareActivity(params.companyId, true);
    const c = parse(params.config);
    const snapshotError = snapshotConfigError(params.config);
    if (snapshotError) throw new Error(snapshotError);
    // Boat archiveAfter is a sliding auto-stop deadline, not a hard lifetime.
    // SDK protocol.ts:684-695 forbids promising a bound the provider cannot enforce.
    // out/runner/boat-docs/get-sandbox.md:320-337. Do not allocate a login/probe
    // sandbox that can outlive its caller's independent deadline.
    if (params.requestedExpiresAt != null) throw new Error("Boat auto-stop TTL cannot enforce a hard requestedExpiresAt deadline.");
    const ttl = effectiveTtlSeconds(c);
    const remoteCwd = workspaceDirectory(params.requestedCwd ?? "/home/user/paperclip-workspace");
    const attemptId = params.creationOperationId ?? randomUUID();
    const labels = { ...c.labels, owner: `paperclip:${params.companyId}`, purpose: params.purpose ?? "run", expiry: params.requestedExpiresAt ?? new Date(Date.now() + ttl * 1000).toISOString(), environment: params.environmentId, run: params.runId, ...(params.creationOperationId ? { creation: params.creationOperationId } : {}), "paperclip-acquire": attemptId };
    // Check outside allocation cleanup: no create was attempted on a failed pin check.
    // Lead measurement 11-12: create.from accepts a NAME, not the snapshot UUID.
    let pinnedIdentity: BoatSnapshotIdentity | undefined;
    if (params.config.pinnedSnapshotId !== undefined) {
      if (!c.pinnedSnapshotId?.trim()) throw new Error("Boat pinnedSnapshotId must be a non-empty string.");
      pinnedIdentity = await resolveBoatSnapshotIdentity(params.config);
      if (pinnedIdentity.id !== c.pinnedSnapshotId) throw new Error("Boat saved-snapshot identity changed: pinnedSnapshotId mismatch; sandbox creation refused.");
    }
    const snapshot = c.snapshot === undefined ? undefined : await resolveSnapshotForCreate(c);
    const from = snapshot?.name ?? c.from;
    const spareHash = readySpareHash(c, ttl, from, snapshot ?? pinnedIdentity);
    const spareKey: ReadySpareKey = { companyId: params.companyId, environmentId: params.environmentId, configHash: spareHash };
    let baseSpares = 0, spareMax = 3, demandWindowMinutes = 10;
    let spareIdleMinutes = readySpareIdleMinutes(undefined), hasSpareSetting = false, listedEnvironment = false;
    if (pluginContext?.config && typeof pluginContext.config.get === "function") {
      try {
        const companyConfig = await pluginContext.config.get(params.companyId);
        const environments = readySpareEnvironmentIds(companyConfig);
        listedEnvironment = environments.includes(params.environmentId);
        baseSpares = listedEnvironment ? readySpareCount(companyConfig) : 0;
        spareMax = readySpareMax(companyConfig);
        demandWindowMinutes = readySpareDemandWindowMinutes(companyConfig);
        spareIdleMinutes = readySpareIdleMinutes(companyConfig);
        hasSpareSetting = true;
      } catch { duplexLogger?.warn("Boat ready spare setting lookup failed", { companyId: params.companyId }); }
    }
    const spareOperations = hasSpareSetting ? createReadySpareOperations(c, spareKey, ttl, from) : undefined;
    const policy = { baseDesired: baseSpares, spareMax, demandWindowMinutes };
    const createOrdinaryLease = async (): Promise<PluginEnvironmentLease> => {
      let id: string | undefined;
      try {
        if (shuttingDown) throw new Error("Boat provider is shutting down");
        const created = await request(c, "/sandboxes", { method: "POST", signal: AbortSignal.timeout(30_000), headers: { "Idempotency-Key": attemptId }, body: JSON.stringify(createSandboxBody(c, ttl, labels, from)) });
        const sb = created?.sandbox ?? created; if (typeof sb?.id !== "string" || !sb.id) throw new Error("Boat create response did not contain sandbox.id");
        id = sb.id;
        idleActivity.resource(activityKey(c, sb.id));
        const ready = await waitReady(c, sb.id);
        const ownershipObservation = c.setupScript !== undefined ? await waitSetup(c, sb.id) : ready;
        return await finishAcquisition(params, c, sb.id, { ...ready, ...ownershipObservation }, labels, remoteCwd, snapshot, null);
      } catch (error) {
        if (shuttingDown && !id) throw error;
        const ids = id ? [id] : await acquisitionMatches(c, attemptId, params);
        if (id) {
          await duplexChannels.suspend({ ...params, providerLeaseId: id });
          await retireForLifecycle({ ...params, providerLeaseId: id });
        }
        await cleanupAcquisition(c, ids, params, attemptId, error);
        throw error;
      }
    };
    if (!hasSpareSetting) await recordOutcomeOnce("cold", "config_mismatch");
    else if (!listedEnvironment) {
      if (spareOperations) queueSpareReconciliation(spareKey, 0, ttl, spareOperations, spareIdleMinutes, policy);
      await recordOutcomeOnce("cold", "env_not_listed");
    } else if (baseSpares === 0) {
      if (spareOperations) queueSpareReconciliation(spareKey, 0, ttl, spareOperations, spareIdleMinutes, policy);
      await recordOutcomeOnce("cold", "spares_disabled");
    } else if (spareClaimStore && spareOperations) {
      const desiredSpares = readySpares.demandTarget(spareKey, baseSpares, spareMax, demandWindowMinutes);
      let id: string | undefined;
      let adoptionTask: Promise<void> | undefined;
      if (desiredSpares > 0 && readySpares.ready(spareKey).length === 0) {
        // Recovery inventory is asynchronous: a cache miss never waits on Boat
        // before following the established create path. A healthy adopted
        // candidate becomes available to the next acquire.
        adoptionTask = readySpares.adopt(spareKey, spareOperations).catch(() => undefined);
      }
      const claimAttempt = `${encodeURIComponent(params.runId ?? "unknown")}:${encodeURIComponent(attemptId)}`;
      const claimResult = await readySpares.claimWithOutcome(spareKey, claimAttempt, ttl, spareOperations, params.runId ?? "unknown");
      if (shuttingDown) throw new Error("Boat provider is shutting down");
      if (claimResult.outcome === "spare") {
        const claimedSpare = claimResult.spare;
        readySpares.recordDemand({ companyId: params.companyId, environmentId: params.environmentId });
        const demandedSpares = readySpares.demandTarget(spareKey, baseSpares, spareMax, demandWindowMinutes);
        await recordOutcomeOnce("spare");
        id = claimedSpare.id;
        const claimName = `paperclip-claim:${claimAttempt}`;
        const observation = claimedSpare.providerObservation;
        const ready = observation ?? { id, state: claimedSpare.state, name: claimName, labels: claimedSpare.labels };
        // Immediately begin the replacement while shared lease preparation
        // runs; no claims can see the transferred ID again.
        queueSpareReconciliation(spareKey, demandedSpares, ttl, spareOperations, spareIdleMinutes, policy);
        return await finishAcquisition(params, c, id, ready, claimedSpare.labels, remoteCwd, snapshot, claimName, claimedSpare);
      }
      await recordOutcomeOnce("cold", claimResult.reason);
      if (shuttingDown) throw new Error("Boat provider is shutting down");
      if (adoptionTask) void adoptionTask.then(() => queueSpareReconciliation(spareKey, desiredSpares, ttl, spareOperations, spareIdleMinutes, policy));
      else queueSpareReconciliation(spareKey, desiredSpares, ttl, spareOperations, spareIdleMinutes, policy);
      return await createOrdinaryLease();
    } else {
      await recordOutcomeOnce("cold", "no_ready_spare");
    }
    return await createOrdinaryLease();
    })();
    const countedWork = work.finally(async () => {
      if (!outcomeRecorded) await recordOutcomeOnce("cold", "config_mismatch");
    });
    inFlightAcquisitions.add(countedWork);
    return countedWork.finally(() => { inFlightAcquisitions.delete(countedWork); });
  },
  async onEnvironmentInspectLease(params: PluginEnvironmentInspectLeaseParams): Promise<PluginEnvironmentLeaseObservation> {
    const c = parse(params.config);
    if (params.creationOperation) {
      const owner = { ...params, runId: params.creationOperation.runId };
      const ids = await acquisitionMatches(c, params.creationOperation.id, owner);
      // Absence is not proof a timed-out create cannot materialize later. Throw
      // to keep core's durable intent retryable, never return an unowned null.
      if (!ids.length) throw new Error("Boat creation identity is not visible yet; retry inspection");
      return { providerLeaseId: ids[0], state: "unknown", creationCleanup: cleanupIdentity(c, ids[0], owner, params.creationOperation.id) };
    }
    idleActivity.resource(activityKey(c, params.providerLeaseId));
    const proof = idleActivity.proof(activityKey(c, params.providerLeaseId));
    let observedAt: string | null = null;
    const personal = (params.leaseMetadata?.boatOwner as { kind?: unknown } | undefined)?.kind === "personal";
    const boatOrgId = personal ? undefined : params.leaseMetadata?.boatOrgId;
    // Explicit request scope, never an inference from the mutable active wallet.
    // https://docs.boat.dev/api-keys.md (organization/account key table)
    const orgHeaders = typeof boatOrgId === "string" && boatOrgId.trim() ? { "X-Boat-Org": boatOrgId } : undefined;
    const result = await request(c, `/sandboxes/${encodeURIComponent(params.providerLeaseId)}`, { method: "GET", headers: orgHeaders, cache: "no-store", signal: AbortSignal.timeout(10_000) }, true, { requireJson: true, strictMissing: true, onHeaders: headers => {
      observedAt = parseHttpDate(headers.get("Date"));
    } });
    if (result === null) {
      // Even a valid key can see a foreign org's lease as missing. The read
      // above must name the recorded org, and the whole inventory must match.
      if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(params.providerLeaseId)) throw new Error("Boat lease absence is not proven: inspection id is not a sandbox id");
      if (personal) throw new Error("Boat personal lease absence is not proven; refusing to report it destroyed");
      if (typeof boatOrgId !== "string" || !boatOrgId.trim()) throw new Error("Boat lease absence is not proven: no recorded boatOrgId; refusing to report it destroyed");
      if (await soleBoatOrgId(c) !== boatOrgId) throw new Error("Boat lease absence is not proven: could not confirm the lease organization; inventory is not exclusively the recorded org");
      idleActivity.confirm(proof, true);
      return { providerLeaseId: params.providerLeaseId, state: "destroyed", stoppedAt: null, lastRebootAt: null, observedAt };
    }
    const sandbox = result.sandbox ?? result;
    if (sandbox.id !== params.providerLeaseId) throw new Error("Boat inspection returned a different allocation.");
    if (sandbox.state === "archived") idleActivity.confirm(proof, true);
    // Boat documents terminal cancelled/404, the state enum, stoppedAt and lastReboot:
    // https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md
    const stoppedAt = sandbox.stoppedAt ?? null;
    const state = sandbox.state === "cancelled" ? "destroyed" : sandbox.state === "archived" && stoppedAt !== null ? "stopped" : ["ready", "idle", "running"].includes(sandbox.state) ? "active" : "unknown";
    return { providerLeaseId: params.providerLeaseId, state, stoppedAt, lastRebootAt: sandbox.lastReboot?.at ?? null, observedAt };
  },
  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    await recordCompanySpareActivity(params.companyId, true);
    const c = parse(params.config), id = params.providerLeaseId;
    await duplexChannels.suspend({ ...params, providerLeaseId: id });
    await sshCarrier.invalidate({ ...params, providerLeaseId: id });
    const metadata = params.leaseMetadata;
    const remoteCwd = workspaceDirectory(metadata?.remoteCwd ?? "/home/user/paperclip-workspace");
    if (params.requestedCwd !== undefined && workspaceDirectory(params.requestedCwd) !== remoteCwd) throw new Error("The requested directory does not match the recorded Boat workspace directory.");
    const requiresProof = metadata?.adapterType === "paperclip_runner" || metadata?.workspaceSentinel !== undefined;
    const sentinel = resumeSentinelMetadata(metadata, id, remoteCwd);
    if (requiresProof && !sentinel) return { providerLeaseId: null, metadata: { expired: true, workspaceSentinel: { result: "missing" } } };
    // Existing unscoped non-Runner callers retain their SDK behavior. Every new
    // acquired scoped lease carries proof; a Runner lease never uses this branch.
    let sandbox: any;
    if (requiresProof) {
      const found = await request(c, `/sandboxes/${encodeURIComponent(id)}`, {}, true);
      if (!found) {
        if ((metadata?.boatOwner as { kind?: unknown } | undefined)?.kind === "personal") throw new Error("Boat personal lease absence is not proven; refusing to expire it");
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      sandbox = found.sandbox ?? found;
      if (sandbox.id !== id) throw new Error("Boat resume returned a different allocation.");
    }
    const resumedFromState = sandbox?.state ?? null;
    let ttlRefresh: { status: "ok" | "unconfirmed"; at: string; archiveAfter: string | null }
      | { status: "failed"; at: string; category: RequestErrorCategory; httpStatus: number | null; archiveAfter: string | null } | undefined;
    let refreshExpiresAt: string | null = null;
    if (!sandbox || !["ready", "idle", "running"].includes(sandbox.state)) {
      // boatdocs-0110c/api_reference_sandboxes_resume-sandbox.md:35-75,147-172.
      const response = await request(c, `/sandboxes/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(c), ...(c.boatEnvironment === undefined ? { noEnv: true } : {}) }) });
      const sb = response.sandbox ?? response;
      assertSandboxId(sb, id);
      sandbox = await waitReady(c, id, true);
      runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, id));
    } else {
      // Boat auto-stop counts from create/last resume, not activity:
      // https://docs.boat.dev/long-running-tasks/auto-stop.md:14-16.
      // PATCH ttlSeconds sets the deadline to now + ttlSeconds:
      // https://docs.boat.dev/api/reference/sandboxes/update-sandbox.md:91-93.
      // Renew every authorized warm handoff, never with an idle timer.
      const path = `/sandboxes/${encodeURIComponent(id)}`;
      const personal = (metadata?.boatOwner as { kind?: unknown } | undefined)?.kind === "personal";
      const boatOrgId = personal ? undefined : metadata?.boatOrgId;
      const orgHeaders = typeof boatOrgId === "string" && boatOrgId.trim() ? { "X-Boat-Org": boatOrgId } : undefined;
      const ttlSeconds = effectiveTtlSeconds(c), requestedAt = Date.now();
      const at = new Date(requestedAt).toISOString();
      try {
        const refreshed = await request(c, path, { method: "PATCH", headers: orgHeaders, body: JSON.stringify({ ttlSeconds }) }, false, { requireJson: true });
        const candidate = refreshed?.sandbox ?? refreshed;
        if (candidate?.id !== id) throw requestError(c, "PATCH", path, 200, "parse_error");
        const archiveAfter = parseDeadline(candidate.archiveAfter);
        const expectedDeadline = requestedAt + ttlSeconds * 1000;
        const confirmed = archiveAfter !== null && Math.abs(Date.parse(archiveAfter) - expectedDeadline) <= 120_000;
        ttlRefresh = { status: confirmed ? "ok" : "unconfirmed", at, archiveAfter };
        refreshExpiresAt = archiveAfter ?? parseDeadline(candidate.expiresAt);
        sandbox = candidate;
      } catch (error) {
        // request and the exact-ID check expose only our safe error fields.
        // Keep the pre-PATCH observation: neither owner nor deadline is renewed.
        const failure = error as ReturnType<typeof requestError>;
        ttlRefresh = { status: "failed", at, category: failure.category, httpStatus: failure.httpStatus, archiveAfter: sandbox.archiveAfter ?? null };
      }
      const details = { providerLeaseId: c.apiKey ? id.split(c.apiKey).join("[REDACTED]") : id, status: ttlRefresh.status,
        category: ttlRefresh.status === "failed" ? ttlRefresh.category : ttlRefresh.status === "unconfirmed" ? "deadline_mismatch" : null };
      if (ttlRefresh.status === "ok") duplexLogger?.info("Boat warm lease TTL refresh", details);
      else duplexLogger?.warn("Boat warm lease TTL refresh", details);
    }
    const workspaceSentinel = sentinel ? await verifyWorkspaceSentinel(sentinel, { request: (path, init) => request(c, path, init), run: (command, timeout) => runCommand(c, id, command, timeout) }) : undefined;
    if (workspaceSentinel && workspaceSentinel.result !== "matched") return { providerLeaseId: null, metadata: { expired: true, workspaceSentinel, ...(ttlRefresh ? { ttlRefresh } : {}) } };
    const guardianPreflight = await stageGuardian(params.config, id, {
      request: (path, init) => request(c, path, init), run: (command, timeout) => runCommand(c, id, command, timeout),
    }, metadata);
    // A disabled carrier must not inherit an earlier lease's usable receipt.
    const { guardianPreflight: _previousGuardian, runnerGuardianVersion: _previousVersion,
      boatOrgId: _previousOrg, boatOwner: _previousOwner, ttlRefresh: _previousTtlRefresh, ...retainedMetadata } = metadata ?? {};
    await bindDuplexLease(params, id, guardianPreflight);
    const ownership = boatOwnershipForLease(sandbox, id);
    return { providerLeaseId: id, expiresAt: ttlRefresh && ttlRefresh.status !== "failed" ? refreshExpiresAt : sandbox.archiveAfter ?? sandbox.expiresAt ?? sandbox.autoStopAt ?? null,
      metadata: { ...retainedMetadata, provider: c.provider, resumed: true, resumedLease: true, resumedFromState,
        ...ownership, ...(ttlRefresh ? { ttlRefresh } : {}),
        ...(guardianPreflight ? { guardianPreflight, runnerGuardianVersion: 1 } : {}), ...(workspaceSentinel ? { workspaceSentinel } : {}) } };
  },
  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams) {
    await recordCompanySpareActivity(params.companyId);
    if (!params.providerLeaseId) return;
    const c = parse(params.config); const id = params.providerLeaseId;
    await duplexChannels.suspend({ ...params, providerLeaseId: id });
    const warnings = await retireForLifecycle({ ...params, providerLeaseId: id });
    const receipt = await stopSandbox(c, id);
    runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, id));
    return { ...receipt, ...(warnings.length ? { warnings } : {}) };
  },
  async onEnvironmentStopLease(params: PluginEnvironmentReleaseLeaseParams) {
    if (!params.providerLeaseId) throw new Error("Boat stop requires an exact providerLeaseId");
    const c = parse(params.config);
    await duplexChannels.suspend({ ...params, providerLeaseId: params.providerLeaseId });
    const warnings = await retireForLifecycle({ ...params, providerLeaseId: params.providerLeaseId });
    const receipt = await stopSandbox(c, params.providerLeaseId);
    runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, params.providerLeaseId));
    return { ...receipt, ...(warnings.length ? { warnings } : {}) };
  },
  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams) {
    if (!params.providerLeaseId) return;
    const c = parse(params.config);
    if (params.leaseMetadata?.failedCreateCleanup !== undefined) {
      const cleanup = readEnvironmentCreationCleanupError({ data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup: params.leaseMetadata.failedCreateCleanup } });
      if (!cleanup || cleanup.companyId !== params.companyId || cleanup.environmentId !== params.environmentId ||
          cleanup.providerLeaseId !== params.providerLeaseId || cleanup.accountFingerprint !== cleanupIdentity(c, params.providerLeaseId, params, cleanup.attemptId).accountFingerprint ||
          cleanup.labels["paperclip-acquire"] !== cleanup.attemptId) throw new Error("Boat failed-creation cleanup ownership does not match");
      // A single create should allocate once. Still clean every labeled match,
      // including across pages; one durable row owns the complete attempt.
      const ids = await acquisitionMatches(c, cleanup.attemptId, cleanup);
      await cleanupAcquisition(c, ids.filter(id => id !== params.providerLeaseId), cleanup, cleanup.attemptId, new Error("Boat creation cleanup retry"));
      // Always confirm the row's exact ID even if listing omits it.
    }
    await duplexChannels.suspend({ ...params, providerLeaseId: params.providerLeaseId });
    const warnings = await retireForLifecycle({ ...params, providerLeaseId: params.providerLeaseId });
    const receipt = await stopSandbox(c, params.providerLeaseId);
    // A destroy request is stop-and-retain on Route A. The guest survives, so
    // never forget pending key removal on this path.
    runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, params.providerLeaseId));
    return { ...receipt, ...(warnings.length ? { warnings } : {}) };
  },
  async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const cwd = workspaceDirectory(typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : params.workspace.remotePath ?? params.workspace.localPath ?? "/home/user/paperclip-workspace");
    if (params.lease.providerLeaseId) {
      const result = await runCommand(parse(params.config), params.lease.providerLeaseId, `mkdir -p ${q(cwd)}`, 30_000);
      if (result.timedOut || result.exitCode !== 0) throw new Error("Boat workspace directory creation failed.");
    }
    return { cwd, metadata: { provider: "boat", remoteCwd: cwd } };
  },
  async onEnvironmentRunnerIngressEndpoint(params: PluginEnvironmentRunnerIngressEndpointParams): Promise<PluginEnvironmentRunnerIngressEndpoint> {
    if (params.port !== 43127) throw new Error("Boat runner ingress must use fixed port 43127.");
    if (!/^\/api\/runner\/v1\/connect\/[A-Za-z0-9_-]+$/.test(params.path)) throw new Error("Boat runner ingress path is invalid.");
    const id = params.lease.providerLeaseId;
    if (!id) throw new Error("Boat runner ingress requires a provider lease id.");
    const c = parse(params.config);
    const result = await acquireRunnerIngress("sandbox_lookup", () => request(c, `/sandboxes/${encodeURIComponent(id)}`));
    let sandbox = result.sandbox ?? result;
    if (sandbox.id !== id) throw new Error("Boat runner ingress returned a different allocation.");
    if (!["ready", "idle", "running"].includes(sandbox.state)) {
      await duplexChannels.suspend({ ...params, providerLeaseId: id });
      await sshCarrier.invalidate({ ...params, providerLeaseId: id });
      await acquireRunnerIngress("sandbox_start", () => request(c, `/sandboxes/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(c), ...(c.boatEnvironment === undefined ? { noEnv: true } : {}) }) }));
      sandbox = await acquireRunnerIngress("sandbox_refresh", () => waitReady(c, id, true));
      runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, id));
      // Only explicit acquire/resume may authorize the guardian carrier. This
      // ingress helper must not bind an arbitrary previously unbound lease.
    }
    // out/runner/boat-docs/expose-a-port.md:35-72,91-150. Runner binds
    // 0.0.0.0:43127; enabling Boat's loopback relay would steal that listener.
    const preview = await acquireRunnerIngress("private_preview", () => request(c, `/sandboxes/${encodeURIComponent(id)}/host`, {
      method: "POST", body: JSON.stringify({ port: params.port, public: false, localhost: false }),
    }));
    return { ...privateRunnerEndpoint(preview, params.path), generation: runnerIngressGenerationStore.get(ingressScopeKey(params, c, id), sandbox) };
  },
  async onEnvironmentSyncIn(params) {
    const c = parse(params.config);
    return syncFiles(params, false, {
      request: (path, init) => request(c, path, init, init?.method === "DELETE"),
      run: (command, timeout, cwd) => runCommand(c, params.lease.providerLeaseId!, command, timeout, cwd),
    });
  },
  async onEnvironmentSyncOut(params) {
    const c = parse(params.config);
    return syncFiles(params, true, {
      request: (path, init) => request(c, path, init, init?.method === "DELETE"),
      run: (command, timeout, cwd) => runCommand(c, params.lease.providerLeaseId!, command, timeout, cwd),
    });
  },
  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams): Promise<PluginEnvironmentExecuteResult> {
    const id = params.lease.providerLeaseId; if (!id) return { exitCode: 1, timedOut: false, stdout: "", stderr: "No Boat lease ID available." };
    const c = parse(params.config); validEnv(params.env);
    let stdinPath: string | null = null, envDir: string | null = null, envPath: string | null = null;
    const base = `/sandboxes/${encodeURIComponent(id)}/files`;
    const stage = async (path: string, content: string, kind: "stdin" | "env") => {
      if (Buffer.byteLength(content, "utf8") > 4_194_304) {
        // Signed PUT takes raw bytes, without Boat Authorization.
        const upload = await request(c, `${base}/upload-url`, { method: "POST", body: JSON.stringify({ path }) });
        if (typeof upload?.url !== "string" || !upload.url) throw new Error(`Boat ${kind} upload URL missing`);
        assertBoatActivityAdmission();
        const response = await fetch(upload.url, { method: "PUT", body: Buffer.from(content, "utf8"), redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Boat ${kind} upload failed (${response.status})`);
      } else {
        await request(c, base, { method: "PUT", body: JSON.stringify({ path, content, encoding: "utf8" }) });
      }
    };
    try {
      const env = Object.entries(params.env ?? {});
      if (env.length) {
        // Never include values (or names) in Boat's retained command text.
        // Keep files outside BOTH the exec cwd and the recorded copyback root.
        const roots = [params.cwd, params.lease.metadata?.remoteCwd].filter((p): p is string => typeof p === "string")
          .map(p => posix.resolve("/home/user", p));
        const uuid = randomUUID();
        envDir = [`/tmp/paperclip-boat-env-${uuid}`, `/home/user/.paperclip-boat-env-${uuid}`]
          .find(dir => roots.every(root => dir !== root && !dir.startsWith(root === "/" ? root : `${root}/`))) ?? null;
        if (!envDir) throw new Error("Boat env file requires a private directory outside the workspace.");
        envPath = `${envDir}/env.sh`;
        // No mode field in PUT /files. Precreate under umask 077 (0700/0600),
        // then enforce 0600 again before sourcing in case upload replaces it.
        // Non-recursive mkdir refuses an existing directory/symlink.
        const made = await runCommand(c, id, `umask 077 && /bin/mkdir -- ${q(envDir)} && : > ${q(envPath)}`, 30_000);
        if (made.timedOut || made.exitCode !== 0) throw new Error("Boat private env directory creation failed.");
        await stage(envPath, env.map(([k, v]) => `export ${k}=${q(v)}\n`).join(""), "env");
      }
      if (params.stdin !== undefined) {
        stdinPath = `/tmp/paperclip-stdin-${randomUUID()}`;
        await stage(stdinPath, params.stdin, "stdin");
      }
      const invocation = [q(params.command), ...(params.args ?? []).map(q)].join(" ");
      // Absolute cleanup utilities still work when the caller overrides PATH.
      const environment = envPath ? `umask 077 && /bin/chmod 600 -- ${q(envPath)} && . ${q(envPath)} && /bin/rm -f -- ${q(envPath)} && /bin/rmdir -- ${q(envDir!)} && ` : "";
      const wrapped = `${params.cwd ? `cd ${q(params.cwd)} && ` : ""}${environment}exec ${invocation}${stdinPath ? ` < ${q(stdinPath)}` : ""}`;
      return await runCommand(c, id, wrapped, params.timeoutMs ?? params.commandTimeoutMs ?? 600_000);
    } finally {
      for (const path of [envPath, stdinPath]) if (path) await request(c, `${base}?path=${encodeURIComponent(path)}`, { method: "DELETE" }).catch(() => undefined);
      if (envDir) await request(c, `${base}?path=${encodeURIComponent(envDir)}&recursive=true`, { method: "DELETE" }).catch(() => undefined);
    }
  },
}, leaseActivityKey), idleActivity));
export default plugin;
