import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SYNC_TEMP_MAX_AGE_MS, sweepStaleSyncTemps, syncFiles } from "./file-sync.js";
import { parseHttpDate } from "./http-date.js";
import { createReadySpareClaimStore, ReadySpareKeeper, READY_SPARE_STOP_BACKOFF_MS, READY_SPARE_TTL_SECONDS, readyCreateCeilingPerHour, readySpareConfigHash, readySpareCount, readySpareDemandWindowMinutes,
  readySpareEnvironmentIds, readySpareIdleMinutes, readySpareMax, readySparePoolKey,
  type CreateCapRefusal, type ReadySpare, type ReadySpareClaimStore, type ReadySpareKey, type ReadySpareOperations, type SpareStopRecord } from "./ready-spares.js";
import { stageGuardian, type GuardianPreflight } from "./guardian-stage.js";
import { BoatIdleActivity, trackBoatHooks } from "./idle-activity.js";
import { assertBoatActivityAdmission, gateBoatHooks, withBoatLeaseActivity } from "./lease-gates.js";
import { BoatDuplexChannels, BoatDuplexError, type DuplexLease } from "./duplex.js";
import { BoatSshCarrier, connectSsh, SSH_RETIRE_ATTEMPTS, type SshRetireWarning } from "./ssh-carrier.js";
import { acquireRunnerIngress, DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS, effectiveTtlSeconds, ingressScopeKey,
  privateRunnerEndpoint, resumeSentinelMetadata, runnerIngressGenerationStore, verifyWorkspaceSentinel,
  workspaceDirectory, writeWorkspaceSentinel, type RunnerConfig } from "./runner-support.js";
import { closedTransportCode, isOwnDeadline, TRANSPORT_ERROR_CODES, transientWords } from "./provider-error-codes.js";
import { BOAT_RESTORING, BOAT_RESTORING_RESEND_MS, boatDirectFields, classifyDirectFailure, COMMAND_HISTORY_READ_MS, commandEvidence,
  commandPossiblyRanError, withCommandNonce, type BoatDirectFields, type PossiblyRanReason } from "./command-outcome.js";
import { definePlugin, PluginEnvironmentCreationCleanupError, PluginEnvironmentStopError, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams, PluginEnvironmentDestroyLeaseParams, PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult, PluginEnvironmentLease, PluginEnvironmentProbeParams, PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams, PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams, PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams, PluginEnvironmentValidationResult, PluginEnvironmentCreationCleanup, PluginEnvironmentAcquisitionDiagnostic,
  PluginEnvironmentInspectLeaseParams, PluginEnvironmentLeaseObservation,
  PluginEnvironmentRunnerIngressEndpointParams, PluginEnvironmentRunnerIngressEndpoint, PluginContext,
  EnvironmentCreationIdempotencyCode,
} from "@paperclipai/plugin-sdk";

type Config = RunnerConfig & { apiBaseUrl?: string; provider: string; setupTimeoutSeconds: number; runLeaseRenewCapSeconds: number; retainOnDestroy: boolean; labels: Record<string, string>; duplexCarrier: "off" | "ssh" };
const DEFAULT_RUN_LEASE_RENEW_CAP_SECONDS = 86400;
function validRunLeaseRenewCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_592_000;
}
const API = "https://boat.dev/api/v1";
let apiBaseUrlWarned = false;
const FAULT_PROXY_FILE = "/paperclip/boat-fault-proxy/ALLOWED";
const MOUNTINFO_FILE = "/proc/self/mountinfo";
let faultProxyTestPaths: { allowedFile: string; mountinfoFile: string } | undefined;
/** Module-only test seam; neither path is configurable by an environment/driver config. */
export function setFaultProxyPathsForTest(paths?: { allowedFile: string; mountinfoFile: string }): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Boat fault-proxy paths are test-only.");
  faultProxyTestPaths = paths;
}
/** Closed messages only: never echo a URL, filesystem exception, key or config. */
function faultProxyRefused(reason: string): never { throw new Error(`Boat apiBaseUrl refused: ${reason}.`); }
function faultProxyUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || /[\r\n\t]/.test(value.trim())) throw new Error();
    const url = new URL(value);
    const localHost = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    const containerHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(url.hostname);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href) ||
      /^[^:]+:\/+[^/]*@/.test(value.trim().replace(/\\/g, "/")) || !(localHost || containerHost)) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch { return faultProxyRefused("URL not allowed (HTTP(S), container DNS label or loopback only; no userinfo, query or fragment)"); }
}
function operatorProxyBase(): string {
  const allowedFile = faultProxyTestPaths?.allowedFile ?? FAULT_PROXY_FILE;
  const mountinfoFile = faultProxyTestPaths?.mountinfoFile ?? MOUNTINFO_FILE;
  // Check the lexical path BEFORE realpath: a symlink from a writable directory
  // to a read-only-mounted target must never confer operator authority. Include
  // /paperclip itself (and its ancestors), not just the final file.
  for (let path = allowedFile; ; path = dirname(path)) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); }
    catch { return faultProxyRefused("no operator file (or operator path is unreadable)"); }
    if (stat.isSymbolicLink()) return faultProxyRefused("operator file or parent is a symlink");
    if (path === allowedFile ? !stat.isFile() : !stat.isDirectory()) return faultProxyRefused("operator path is not a regular file and directories");
    if (dirname(path) === path) break;
  }
  let realFile: string, mountinfo: string;
  try { realFile = realpathSync(allowedFile); mountinfo = readFileSync(mountinfoFile, "utf8"); }
  catch { return faultProxyRefused("cannot verify read-only operator mount"); }
  let coveringMount: { point: string; options: string[] } | undefined;
  // mountinfo field 6 is the per-mount options, NOT the superblock options
  // after " - ". A writable child mount wins over a read-only ancestor.
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-")) continue;
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (!(realFile === point || realFile.startsWith(point === "/" ? "/" : `${point}/`))) continue;
    if (!coveringMount || point.length >= coveringMount.point.length) coveringMount = { point, options: fields[5].split(",") };
  }
  if (!coveringMount?.options.includes("ro")) return faultProxyRefused("operator file mount is not read-only");
  let content: string;
  try { content = readFileSync(allowedFile, "utf8").trim(); }
  catch { return faultProxyRefused("operator file cannot be read"); }
  if (!content || /[\r\n]/.test(content)) return faultProxyRefused("URL not allowed (operator file must contain one nonempty URL line)");
  return faultProxyUrl(content);
}
/** Recheck operator authority even for direct hooks and immediately before sends. */
function apiBase(config: Record<string, unknown>): string {
  if (config.apiBaseUrl === undefined) return API;
  const allowedBase = operatorProxyBase();
  const configuredBase = faultProxyUrl(config.apiBaseUrl);
  if (configuredBase !== allowedBase) return faultProxyRefused("URL mismatch with operator file");
  if (!apiBaseUrlWarned && duplexLogger) {
    duplexLogger.warn("Boat apiBaseUrl fault-proxy override enabled");
    apiBaseUrlWarned = true;
  }
  return allowedBase;
}
const SPARE_ACTIVITY_EVENTS = ["agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled",
  "issue.comment.created", "issue.created", "issue.updated"] as const;
const idleActivity = new BoatIdleActivity();
const readySpares = new ReadySpareKeeper();
type KnownSparePool = { key: ReadySpareKey; ttlSeconds: number; desired: number; baseDesired: number; spareMax: number; demandWindowMinutes: number;
  idleMinutes: number; operations: ReadySpareOperations; idleStopped: boolean;
  /** A replaced environment config's pool (rf-4 U1B row C): never refilled, renewed or re-targeted again. */
  retired?: boolean };
type CompanySpareActivity = { lastActivityAt?: number; lastLeaseAcquiredAt?: number };
type AcquireOutcomeReason = "no_ready_spare" | "create_capped" | "refill_in_flight" | "env_not_listed" | "config_mismatch" | "claim_conflict" | "spares_disabled" | "idle";
type AcquireOutcomeCounts = { spare: number; cold: number; reasons: Partial<Record<AcquireOutcomeReason, number>> };
type CompanyAcquireOutcomes = Map<string, AcquireOutcomeCounts>;
const knownSparePools = new Map<string, KnownSparePool>();
/**
 * Bumped at every spare setting change (company) and every 'off' applied to a
 * company environment. An acquire that read the setting before a bump raced
 * 'off' (or a newer setting) and queues no spares; the newer reader applied it.
 */
const spareSettingEpochs = new Map<string, number>();
function bumpSpareSettingEpoch(...scope: string[]): void {
  const id = JSON.stringify(scope);
  spareSettingEpochs.set(id, (spareSettingEpochs.get(id) ?? 0) + 1);
}
function spareSettingEpoch(companyId: string, environmentId: string): string {
  return `${spareSettingEpochs.get(JSON.stringify([companyId])) ?? 0}:${spareSettingEpochs.get(JSON.stringify([companyId, environmentId])) ?? 0}`;
}
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
/**
 * The #20912 stale sync-temp sweep runs at startup and then every 30 minutes,
 * with identical rules, so a killed worker's temp that was younger than
 * SYNC_TEMP_MAX_AGE_MS at startup does not wait for a later restart.
 */
const SYNC_TEMP_SWEEP_INTERVAL_MS = 30 * 60_000;
let syncTempSweepTimer: ReturnType<typeof setInterval> | undefined;
let syncTempSweepWork: Promise<void> | undefined;
let shuttingDown = false;
let boatRateLimitPauseUntil = 0;
const preparedEnvDirectories = new Map<string, string>();
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
function activityKey(config: Config, id: string): string { return createHash("sha256").update(`${apiBase(config)}\0${config.apiKey}\0${id}`).digest("hex"); }
// smarty-dev#20974: Boat's documented 409 answers (troubleshooting 'Error
// messages'; readiness.md:9-31). Only these closed values reach an error.
// snapshot_data_expired is Boat's troubleshooting.md, 'Error messages',
// '### `409 snapshot_data_expired`' (copy read 11-17, lines 17-23): "boat deleted
// this sandbox's data after it had been stopped for at least 14 days. Resume, fork
// and a saved snapshot save of this sandbox fail. You cannot get the data back."
// R8(c): boat-errors-table.md:9 (Boat llms-full:2103) also names resume_failed,
// sandbox_securing and sandbox_resuming. Naming a code does not grant retries.
const BOAT_409_CODES: ReadonlySet<string> = new Set([
  "sandbox_starting", "sandbox_not_ready", "machine_not_running", "sandbox_stopping", "snapshot_data_expired",
  "resume_failed", "sandbox_securing", "sandbox_resuming",
  // Create/fork Idempotency-Key answers (https://docs.boat.dev/llms-full.txt
  // :2242-2243, fetched 2026-11-19): still being created, or same key with another body.
  "idempotency_in_progress", "idempotency_key_reused",
]);
// API states (readiness.md:15-23) plus the stopping/stopped the 409 texts name.
const BOAT_STATES: ReadonlySet<string> = new Set([
  "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error", "stopping", "stopped",
]);
type Boat409Fields = { boatCode?: string; boatState?: string; boatRetryable?: boolean };
/** Boat's closed 409 fields from a parsed body (top level, error, error.details); never the body. */
function boat409Fields(body: unknown): Boat409Fields {
  const field = (value: unknown, key: string): unknown => {
    try { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
    catch { return undefined; }
  };
  const read = (key: string): unknown => {
    for (const source of [body, field(body, "error"), field(field(body, "error"), "details")]) {
      const value = field(source, key);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const code = read("code"), state = read("state"), retryable = read("retryable");
  return {
    ...(typeof code === "string" ? { boatCode: BOAT_409_CODES.has(code) ? code : "other" } : {}),
    ...(typeof state === "string" && BOAT_STATES.has(state) ? { boatState: state } : {}),
    ...(typeof retryable === "boolean" ? { boatRetryable: retryable } : {}),
  };
}
/** "A few minutes" after OUR resume of a box, a not-ready 409 earns one more resume. */
const BOAT_RESUME_RECOVERY_WINDOW_MS = 5 * 60_000;
/** Pause before sending a command or files call again after 409 sandbox_starting. */
const BOAT_STARTING_RESEND_MS = 1_000;
// Our successful resumes, by account-scoped box key. A recovery resume never
// renews the entry, and our own stop forgets it, so it can never wake a box we stopped.
const ourResumes = new Map<string, { at: number; recovery?: Promise<boolean>; settled?: boolean }>();
// A box's lifecycle generation (frozen8 verdict F-01). Our stop of the box ends
// a generation as it starts and again once it completes; a call bound to an older
// generation never sends again, so no in-flight 409 recovery outlives our stop.
const boxLifecycles = new Map<string, number>();
// An explicit stop also fences NEW calls under another lease scope. Only an
// explicit resume reopens recovery; a command refusal can never undo our Stop.
const stoppedBoxes = new Set<string>();
/** First wait after Boat refuses a stop (stop record `failing`); doubles per refusal. */
export const BOAT_STOP_REFUSAL_BACKOFF_MS = 60_000;
/** Cap of that doubling: 1, 2, 4, 8, 16 min, then 16 min. */
export const BOAT_STOP_REFUSAL_BACKOFF_CAP_MS = 16 * 60_000;
/** At most this many boxes' refusals are kept; the oldest is forgotten first. */
const BOAT_STOP_REFUSAL_MEMORY = 1_000;
/** Boat refused our stop: its stop record reads `failing` (Boat keeps the box
 * running, retries the save itself and only a resume ends the stop). Non-terminal
 * `recovery_incomplete` from the SDK; never forced, never deleted. */
export class BoatStopRefusedError extends PluginEnvironmentStopError {
  readonly code = "boat_stop_refused";
  constructor(readonly providerLeaseId: string, readonly stopId: string, readonly boatStatus: string,
    readonly boatError: string | null, readonly lastGoodSnapshotAt: string | null, readonly notResentBefore: string, readonly refusals: number) {
    super("recovery_incomplete");
    this.name = "BoatStopRefusedError";
    this.message = `Boat refused stop ${stopId} of ${providerLeaseId} (status ${boatStatus})${boatError ? `: ${boatError}` : ""}.`
      + ` Last good snapshot: ${lastGoodSnapshotAt ?? "not reported"}. Boat keeps the sandbox running and retries the save; a resume cancels the stop.`
      + ` Not forced; no new stop is sent before ${notResentBefore} (refusal ${refusals}).`;
  }
}
// Boat's refusals of our stop, by account-scoped box key: the refused record and
// when a new POST /stop may be sent. A resume or a confirmed stop forgets it.
const stopRefusals = new Map<string, { until: number; refusals: number; error: BoatStopRefusedError }>();
function boxLifecycle(key: string): number { return boxLifecycles.get(key) ?? 0; }
function endBoxLifecycle(key: string): void { boxLifecycles.set(key, boxLifecycle(key) + 1); }
function markOurResume(config: Config, id: string): void {
  const now = Date.now();
  // Marks past the window can never act; drop them so the map stays small
  // (an in-flight recovery keeps its own reference to its mark).
  for (const [key, mark] of ourResumes) if (now - mark.at > BOAT_RESUME_RECOVERY_WINDOW_MS) ourResumes.delete(key);
  stoppedBoxes.delete(activityKey(config, id));
  // A resume ends a pending stop (`superseded`, Boat docs /snapshots/stop), so
  // an earlier refusal no longer speaks for the box's next stop.
  stopRefusals.delete(activityKey(config, id));
  ourResumes.set(activityKey(config, id), { at: now });
}
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
            for (const reason of ["no_ready_spare", "create_capped", "refill_in_flight", "env_not_listed", "config_mismatch", "claim_conflict", "spares_disabled", "idle"] as const) {
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
/**
 * Claimed spares whose run acquire returned this box, until the run proves use
 * or the lease is released. Proof of use (#20869) is the run reaching a step on
 * the bound box: Core calls environmentExecute, the Runner ingress endpoint or a
 * duplex channel open for this exact providerLeaseId. A release, stop or
 * destroy first ends the binding, so an instant release is never use.
 */
const claimedSpareLeases = new Map<string, { companyId: string; environmentId: string; claimedAt: number }>();
const CLAIMED_SPARE_BINDING_MAX_MS = 24 * 60 * 60 * 1000;
function bindClaimedSpare(companyId: string, environmentId: string, providerLeaseId: string): void {
  for (const [id, binding] of claimedSpareLeases) if (Date.now() - binding.claimedAt > CLAIMED_SPARE_BINDING_MAX_MS) claimedSpareLeases.delete(id);
  claimedSpareLeases.set(providerLeaseId, { companyId, environmentId, claimedAt: Date.now() });
}
function unbindClaimedSpare(providerLeaseId: string | null | undefined): void {
  if (providerLeaseId) claimedSpareLeases.delete(providerLeaseId);
}
function recordSpareUse(companyId: string, providerLeaseId: string | null | undefined, step: "execute" | "runner_ingress" | "duplex_open"): void {
  if (!providerLeaseId) return;
  const binding = claimedSpareLeases.get(providerLeaseId);
  if (!binding || binding.companyId !== companyId) return;
  claimedSpareLeases.delete(providerLeaseId);
  if (!readySpares.markUsed(companyId, providerLeaseId)) return;
  try {
    duplexLogger?.debug(`[boat] spare used step=${step} env=${encodeURIComponent(binding.environmentId)}`,
      { companyId, environmentId: binding.environmentId, providerLeaseId, step, claimToUseMs: Date.now() - binding.claimedAt });
  } catch { /* Logging never changes admission. */ }
  // A pool held by the churn cap may now admit the replacement it was refused.
  for (const key of readySpares.churnCappedPools(companyId)) {
    const pool = knownSparePools.get(readySparePoolKey(key));
    if (!pool || pool.desired <= 0 || pool.idleStopped || shuttingDown) continue;
    void readySpares.reconcile(pool.key, pool.desired, pool.operations).catch(() => undefined);
  }
}
function reportCreateCapRefusal(refusal: CreateCapRefusal): void {
  const message = `[boat] create_capped reason=${refusal.reason} kind=${refusal.kind} source=${refusal.source} env=${encodeURIComponent(refusal.environmentId)}`
    + ` churn=${refusal.churnCreates}/${refusal.churnCap} all=${refusal.allCreates}/${refusal.ceiling}`;
  try { duplexLogger?.info(message, { ...refusal, refusals: { ...refusal.refusals } }); } catch { /* Logging never changes admission. */ }
}
function createCapHealth(): { message: string; details: Record<string, unknown>; ceilingHeld: boolean } {
  const refusals = readySpares.refusalTotals();
  const active = readySpares.activeCaps();
  let message = `; create refusals churn_cap=${refusals.churn_cap} ceiling=${refusals.ceiling}`;
  if (active.length) {
    message += `; create_capped ${active.map(cap => `reason=${cap.reason} kind=${cap.kind} company=${cap.companyId} env=${encodeURIComponent(cap.environmentId)}`
      + ` churn=${cap.churnCreates}/${cap.churnCap} all=${cap.allCreates}/${cap.ceiling} until=${cap.cappedUntil}`).join(", ")}`;
  }
  return { message, details: { createRefusals: refusals, createCapped: active }, ceilingHeld: active.some(cap => cap.reason === "ceiling") };
}
function acquireOutcomeTotals(): { spare: number; cold: number } {
  let spare = 0, cold = 0;
  for (const outcomes of companyAcquireOutcomes.values()) for (const counts of outcomes.values()) {
    spare += counts.spare; cold += counts.cold;
  }
  return { spare, cold };
}
function spareActivityIsRecent(activity: CompanySpareActivity, idleMinutes: number): boolean {
  const latest = Math.max(activity.lastActivityAt ?? Number.NEGATIVE_INFINITY,
    activity.lastLeaseAcquiredAt ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(latest) && Date.now() - latest <= idleMinutes * 60_000;
}
async function companySpareIsActive(companyId: string, idleMinutes: number): Promise<boolean> {
  return spareActivityIsRecent(await loadCompanySpareActivity(companyId), idleMinutes);
}
/** Bypass the cache: merge durable state with this worker's newest observation. */
async function freshCompanySpareActivity(companyId: string): Promise<CompanySpareActivity> {
  const cached = companySpareActivity.get(companyId) ?? {};
  let stored: CompanySpareActivity = {};
  try {
    const state = await pluginContext?.state?.get?.({ scopeKind: "company", scopeId: companyId,
      namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_ACTIVITY_STATE_KEY });
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const value = state as Record<string, unknown>;
      stored = { lastActivityAt: stateTimestamp(value.lastActivityAt), lastLeaseAcquiredAt: stateTimestamp(value.lastLeaseAcquiredAt) };
    }
  } catch { duplexLogger?.warn("Boat spare activity state read failed", { companyId }); }
  const newest = (a?: number, b?: number) => a === undefined ? b : b === undefined ? a : Math.max(a, b);
  const lastActivityAt = newest(cached.lastActivityAt, stored.lastActivityAt);
  const lastLeaseAcquiredAt = newest(cached.lastLeaseAcquiredAt, stored.lastLeaseAcquiredAt);
  const activity: CompanySpareActivity = { ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(lastLeaseAcquiredAt === undefined ? {} : { lastLeaseAcquiredAt }) };
  companySpareActivity.set(companyId, activity);
  return activity;
}
/** The pool's spare target under a fresh activity read; the keeper asks immediately before every spare stop. */
async function freshSpareDesired(key: ReadySpareKey): Promise<number> {
  const activity = await freshCompanySpareActivity(key.companyId);
  const pool = knownSparePools.get(readySparePoolKey(key));
  if (shuttingDown || !pool) return 0;
  return spareActivityIsRecent(activity, pool.idleMinutes) ? pool.desired : 0;
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
/** Companies whose last spare-setting re-read failed; logged once until a read succeeds. */
const spareSettingReadFailures = new Set<string>();
/**
 * rf-4 U1 F1: this environment's spare count in the company's CURRENT config,
 * read from the host's durable config (`ctx.config.get`, SDK types.ts
 * PluginConfigClient.get; the same read acquire makes). 0 when absent or not
 * listed; undefined when the read fails (logged once).
 */
async function currentSpareCount(key: ReadySpareKey): Promise<number | undefined> {
  const configClient = pluginContext?.config;
  if (!configClient || typeof configClient.get !== "function") return 0;
  try {
    const companyConfig = await configClient.get(key.companyId);
    spareSettingReadFailures.delete(key.companyId);
    return readySpareEnvironmentIds(companyConfig).includes(key.environmentId) ? readySpareCount(companyConfig) : 0;
  } catch {
    if (!spareSettingReadFailures.has(key.companyId)) {
      spareSettingReadFailures.add(key.companyId);
      try { duplexLogger?.warn("Boat ready spare setting re-read failed; no spare is created until it reads", { companyId: key.companyId, environmentId: key.environmentId }); }
      catch { /* Logging never changes admission. */ }
    }
    return undefined;
  }
}
/**
 * rf-4 U1 F1: the keeper asks right before every spare create POST (and every
 * spare TTL renewal). Only a known, unretired pool whose environment the
 * current durable setting still lists with spares > 0 is admitted. A setting
 * that reads off with no config event is applied here, as acquire applies it.
 */
const admittedSpareCreates = new Map<string, Set<string>>();
async function admitSpareCreate(key: ReadySpareKey, refillId?: string): Promise<boolean> {
  const poolId = readySparePoolKey(key);
  const pool = knownSparePools.get(poolId);
  if (shuttingDown || !pool || pool.retired || pool.baseDesired <= 0) return false;
  const count = await currentSpareCount(key);
  if (count === undefined || shuttingDown) return false;
  if (count <= 0) {
    const current = knownSparePools.get(poolId);
    if (current && current.baseDesired > 0) queueSpareReconciliation(key, 0, current.ttlSeconds, current.operations, current.idleMinutes);
    return false;
  }
  const current = knownSparePools.get(poolId);
  if (current !== pool || pool.retired || pool.baseDesired <= 0) return false;
  pool.baseDesired = count;
  pool.desired = readySpares.demandTarget(key, count, pool.spareMax, pool.demandWindowMinutes);
  if (refillId === undefined) return true; // TTL renewal does not reserve another box.
  const admitted = admittedSpareCreates.get(poolId) ?? new Set<string>();
  const others = [...admitted].filter(id => id !== refillId).length;
  if (readySpares.ready(key).length + others >= pool.desired) return false;
  admitted.add(refillId);
  admittedSpareCreates.set(poolId, admitted);
  return true;
}
/**
 * rf-4 U1 F5 and U1B row D: failed spare stops outlive the worker. Per company,
 * in the plugin's durable state (the store the spare activity already uses):
 * each pool's owed-until hold and each spare whose stop is still owed.
 */
const SPARE_STOP_OWED_STATE_KEY = "stop-owed";
type OwedSpareStops = {
  holds: Array<{ environmentId: string; configHash: string; until: number; failures: number; retries: number }>;
  owed: Array<{ environmentId: string; configHash: string; spareId: string }>;
};
const companyOwedStops = new Map<string, OwedSpareStops>();
const companyOwedStopLoads = new Map<string, Promise<OwedSpareStops>>();
const companyOwedStopWrites = new Map<string, Promise<void>>();
const owedStopRetryAt = new Map<string, number>();
/**
 * rf-4 U1c C2: the Boat config (key) this worker last held per company and
 * environment, from an acquire. The maintenance tick services those owed stops
 * with it, OFF and retired pools included; setup holds no key, so a cold worker
 * keeps the durable debt until an acquire brings one (Boat's TTL is the fallback).
 */
const owedStopKeys = new Map<string, { config: Config; companyId: string; environmentId: string }>();
/** True while a held key has an owed spare stop: the maintenance timer stays on. */
function heldStopDebt(): boolean {
  for (const held of owedStopKeys.values()) {
    if (companyOwedStops.get(held.companyId)?.owed.some(entry => entry.environmentId === held.environmentId)) return true;
  }
  return false;
}
/** From the maintenance tick: retry owed stops whose back-off has ended, for every held key. */
async function serviceOwedSpareStops(): Promise<void> {
  const now = Date.now();
  for (const held of [...owedStopKeys.values()]) {
    if (shuttingDown) return;
    const record = companyOwedStops.get(held.companyId);
    if (!record?.owed.some(entry => entry.environmentId === held.environmentId)) continue;
    // The same back-off as the keeper's: no retry before the recorded hold ends.
    if (record.holds.some(hold => hold.environmentId === held.environmentId && hold.until > now)) continue;
    try { await resumeOwedSpareStops(held.config, held.companyId, held.environmentId, true); }
    catch { duplexLogger?.warn("Boat spare stop record resume failed", { companyId: held.companyId, environmentId: held.environmentId }); }
  }
}
const owedStopWork = new Set<Promise<void>>();
async function loadOwedSpareStops(companyId: string): Promise<OwedSpareStops> {
  const cached = companyOwedStops.get(companyId);
  if (cached) return cached;
  const pending = companyOwedStopLoads.get(companyId);
  if (pending) return pending;
  const work = (async () => {
    const record: OwedSpareStops = { holds: [], owed: [] };
    try {
      const state = await pluginContext?.state?.get?.({ scopeKind: "company", scopeId: companyId,
        namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_STOP_OWED_STATE_KEY });
      const value = state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : {};
      const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
      if (Array.isArray(value.holds)) for (const row of value.holds) {
        const hold = row as Record<string, unknown> | null;
        if (hold && text(hold.environmentId) && text(hold.configHash) && Number.isFinite(hold.until)) {
          record.holds.push({ environmentId: hold.environmentId, configHash: hold.configHash, until: Number(hold.until),
            failures: Number.isInteger(hold.failures) && Number(hold.failures) > 0 ? Number(hold.failures) : 1,
            retries: Number.isInteger(hold.retries) && Number(hold.retries) > 0 ? Number(hold.retries) : 0 });
        }
      }
      if (Array.isArray(value.owed)) for (const row of value.owed) {
        const owed = row as Record<string, unknown> | null;
        if (owed && text(owed.environmentId) && text(owed.configHash) && text(owed.spareId)) {
          record.owed.push({ environmentId: owed.environmentId, configHash: owed.configHash, spareId: owed.spareId });
        }
      }
    } catch (error) {
      duplexLogger?.warn("Boat spare stop record read failed", { companyId });
      throw error; // Unknown debt must never replace the durable record with empty state.
    }
    if (!companyOwedStops.has(companyId)) companyOwedStops.set(companyId, record);
    return companyOwedStops.get(companyId)!;
  })();
  companyOwedStopLoads.set(companyId, work);
  try { return await work; }
  finally { if (companyOwedStopLoads.get(companyId) === work) companyOwedStopLoads.delete(companyId); }
}
async function persistOwedSpareStops(companyId: string, record: OwedSpareStops): Promise<void> {
  if (!pluginContext?.state?.set) throw new Error("Boat spare stop requires durable plugin state");
  const context = pluginContext;
  const previous = companyOwedStopWrites.get(companyId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => context.state.set({ scopeKind: "company", scopeId: companyId,
    namespace: SPARE_ACTIVITY_NAMESPACE, stateKey: SPARE_STOP_OWED_STATE_KEY }, { holds: [...record.holds], owed: [...record.owed] }));
  companyOwedStopWrites.set(companyId, write);
  try { await write; }
  catch (error) { duplexLogger?.warn("Boat spare stop record write failed", { companyId }); throw error; }
  finally { if (companyOwedStopWrites.get(companyId) === write) companyOwedStopWrites.delete(companyId); }
}
/** Keeper and owed-stop retries report here; the record is persisted at once. */
async function recordSpareStop(record: SpareStopRecord): Promise<void> {
  const { companyId, environmentId, configHash } = record.key;
  const owed = await loadOwedSpareStops(companyId);
  const now = Date.now();
  if (record.outcome === "stopped" && !owed.owed.some(entry => entry.spareId === record.spareId)
      && !owed.holds.some(hold => hold.environmentId === environmentId && hold.configHash === configHash)) return;
  const previous = owed.holds.find(hold => hold.environmentId === environmentId && hold.configHash === configHash);
  owed.owed = owed.owed.filter(entry => entry.spareId !== record.spareId);
  if (record.outcome !== "stopped") owed.owed.push({ environmentId, configHash, spareId: record.spareId });
  if (record.outcome === "owed") {
    if (owedStopKeys.has(JSON.stringify([companyId, environmentId]))) ensureSpareRefreshTimer();
    await persistOwedSpareStops(companyId, owed);
    return;
  }
  // A hold's time may expire, but its retry count belongs to the unpaid debt.
  owed.holds = owed.holds.filter(hold => ((hold.until > now && !(hold.environmentId === environmentId && hold.configHash === configHash)) || owed.owed.some(entry =>
    entry.environmentId === hold.environmentId && entry.configHash === hold.configHash))
    && !(record.outcome === "failed" && hold.environmentId === environmentId && hold.configHash === configHash));
  if (record.outcome === "failed") {
    owed.holds.push({ environmentId, configHash, until: record.until, failures: record.failures,
      retries: record.retries ?? previous?.retries ?? 0 });
    // rf-4 U1c C2: a stop owed under a held key keeps the maintenance tick on, even with every pool off.
    if (owedStopKeys.has(JSON.stringify([companyId, environmentId]))) ensureSpareRefreshTimer();
  } else if (!owed.owed.some(entry => entry.environmentId === environmentId && entry.configHash === configHash)) {
    // #21251: the pool owes no stop any more, so its spare creates may resume.
    readySpares.clearOwedStopRetryFailures(record.key);
  }
  await persistOwedSpareStops(companyId, owed);
}
function trackOwedStopWork(work: Promise<void>): void {
  owedStopWork.add(work);
  void work.catch(() => undefined).finally(() => owedStopWork.delete(work));
}
/**
 * At this worker's first acquire for an environment (it carries the Boat
 * credentials setup lacks): re-establish the recorded hold and retry every
 * owed spare stop, whatever the setting. A failed retry re-arms the hold.
 */
async function resumeOwedSpareStops(config: Config, companyId: string, environmentId: string, fromTick = false): Promise<void> {
  owedStopKeys.set(JSON.stringify([companyId, environmentId]), { config, companyId, environmentId });
  const record = await loadOwedSpareStops(companyId);
  const now = Date.now();
  const hashes = new Set([...record.holds, ...record.owed].filter(entry => entry.environmentId === environmentId).map(entry => entry.configHash));
  for (const configHash of hashes) {
    const hold = record.holds.find(entry => entry.environmentId === environmentId && entry.configHash === configHash);
    readySpares.restoreStopBackoff({ companyId, environmentId, configHash }, hold?.until ?? 0, hold?.failures ?? 1,
      record.owed.filter(entry => entry.environmentId === environmentId && entry.configHash === configHash).map(entry => entry.spareId));
    // #21251: a previous worker's failed retries of this pool's owed stop still hold its creates back.
    if (hold && record.owed.some(entry => entry.environmentId === environmentId && entry.configHash === configHash)) {
      readySpares.restoreOwedStopRetryFailures({ companyId, environmentId, configHash }, hold.retries);
    }
  }
  const owed = record.owed.filter(entry => entry.environmentId === environmentId);
  const retryId = JSON.stringify([companyId, environmentId]);
  if (!owed.length || now < (owedStopRetryAt.get(retryId) ?? 0)) return;
  owedStopRetryAt.set(retryId, now + READY_SPARE_STOP_BACKOFF_MS);
  trackOwedStopWork((async () => {
    for (const entry of owed) {
      if (shuttingDown) return;
      const key = { companyId, environmentId, configHash: entry.configHash };
      let sandbox: any;
      try {
        const result = await request(config, `/sandboxes/${encodeURIComponent(entry.spareId)}`, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000) }, true, { requireJson: true });
        sandbox = result === null ? null : result?.sandbox ?? result;
      } catch { continue; }
      // Gone, archived, not ours or now a run's box: nothing more is owed.
      if (sandbox === null || sandbox?.id !== entry.spareId || sandbox.state === "archived"
          || sandbox.labels?.owner !== `paperclip:${companyId}` || sandbox.labels?.environment !== environmentId
          || sandbox.labels?.purpose !== "spare" || (typeof sandbox.name === "string" && sandbox.name.startsWith("paperclip-claim:"))) {
        await recordSpareStop({ outcome: "stopped", key, spareId: entry.spareId });
        continue;
      }
      if (shuttingDown) return;
      try {
        // Persist first when possible; state availability never vetoes a safe
        // stop. Failed writes leave the existing debt in companyOwedStops.
        try { await persistOwedSpareStops(companyId, record); } catch { /* Retry the stop anyway. */ }
        await stopSandbox(config, entry.spareId);
        try { await recordSpareStop({ outcome: "stopped", key, spareId: entry.spareId }); } catch { /* Confirmed stop; stale durable debt can replay. */ }
      } catch {
        const failures = (record.holds.find(hold => hold.environmentId === environmentId && hold.configHash === entry.configHash)?.failures ?? 0) + 1;
        const until = Date.now() + READY_SPARE_STOP_BACKOFF_MS;
        // rf-4 U1c C2: a tick retry keeps the debt (never renewed) and retries after
        // the same back-off; only a stop the keeper or an acquire saw fail holds creates back.
        readySpares.restoreStopBackoff(key, fromTick ? 0 : until, failures, [entry.spareId]);
        // #21251: but a pool whose own owed stop keeps failing on retry (two or more
        // retries, the tick's included) makes no new spare create until a stop succeeds.
        const retries = (record.holds.find(hold => hold.environmentId === environmentId && hold.configHash === entry.configHash)?.retries ?? 0) + 1;
        readySpares.noteOwedStopRetryFailed(key);
        await recordSpareStop({ outcome: "failed", key, spareId: entry.spareId, until, failures, retries });
      }
    }
  })());
}
function parse(raw: Record<string, unknown>): Config {
  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    ...(raw.apiBaseUrl === undefined ? {} : { apiBaseUrl: apiBase(raw) }),
    provider: typeof raw.provider === "string" ? raw.provider : "boat",
    duplexCarrier: raw.duplexCarrier === "ssh" ? "ssh" : "off",
    ...(typeof raw.snapshot === "string" ? { snapshot: raw.snapshot } : {}),
    type: typeof raw.type === "string" ? raw.type : "small",
    ttlSeconds: Number(raw.ttlSeconds ?? 1800),
    setupTimeoutSeconds: Number(raw.setupTimeoutSeconds ?? 180),
    // Even a direct SDK caller bypassing validation cannot disable the money cap.
    runLeaseRenewCapSeconds: validRunLeaseRenewCap(raw.runLeaseRenewCapSeconds) ? raw.runLeaseRenewCapSeconds : DEFAULT_RUN_LEASE_RENEW_CAP_SECONDS,
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
 * fields may cross the worker boundary; scrub the key from our own stack too.
 * `status` (integer HTTP status) and `code` (closed errno only) are the structure
 * the host's transient-retry classification reads through the SDK diagnostic;
 * the transient words serve the server's text-only resume retry. */
function redactKey(config: Config, text: string): string { return redactProviderText(config, text); }
/** THE one source for every outbound provider diagnostic (errors, stacks, logs):
 * masks our configured key, any bearer/Authorization credential, signed-URL query
 * tokens (X-Amz-Signature/Credential/Security-Token, sig=, token=, _token=, ...)
 * and JWTs. The plugin SDK has no redactor and the server's `redactSensitiveText`
 * is not importable here (rf-4 U2 F1). */
export function redactProviderText(config: Pick<Config, "apiKey">, text: string): string {
  let out = config.apiKey ? text.split(config.apiKey).join("[REDACTED]") : text;
  out = out.replace(/(?<![A-Za-z0-9])(Bearer)(\s+)[^\s,;"'&]+/gi, "$1$2[REDACTED]")
    .replace(/(?<![A-Za-z0-9])(Basic)(\s+)[A-Za-z0-9+/]{8,}={0,2}/g, "$1$2[REDACTED]")
    .replace(/(?<![A-Za-z0-9])(Authorization|Proxy-Authorization|X-Api-Key|Api-Key|Cookie)(\s*[:=]\s*)(?!(?:Bearer|Basic)\s)(?!\[REDACTED\])[^\s,;"'&]+/gi, "$1$2[REDACTED]")
    .replace(/([?&;#\s]|^)([\w.-]*(?:token|sig|signature|credential|secret|password|passwd|api[_-]?key|access[_-]?key|session|auth)[\w.-]*=)[^&\s#"']+/gi, "$1$2[REDACTED]")
    .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, "[REDACTED]");
  return out;
}
function logHeader(config: Pick<Config, "apiKey">, value: string | null): string | null { return value === null ? null : providerWords(config, value, 200); }
/** A Boat free-text field as one bounded, sanitised line, or null. */
function providerWords(config: Pick<Config, "apiKey">, text: string, max = 500): string | null {
  const words = redactProviderText(config, text.replace(/\s+/g, " ").trim());
  return words ? words.slice(0, max) : null;
}
/** A Boat status for a diagnostic: a closed token as Boat sends it, else bounded and sanitised. */
function providerStatus(config: Pick<Config, "apiKey">, status: unknown): string {
  if (typeof status !== "string") return "unknown";
  return /^[a-z_]{1,40}$/.test(status) ? status : `unrecognised (${providerWords(config, status, 80) ?? "empty"})`;
}
/** Boat's RFC 3339 timestamp, or null: never a free-text field posing as one. */
function providerTimestamp(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function requestError(config: Config, method: string, path: string, httpStatus: number | null, category: RequestErrorCategory, code?: string, boat409?: Boat409Fields, direct?: BoatDirectFields): Error & { httpStatus: number | null; category: RequestErrorCategory; status?: number; code?: string } & Boat409Fields & BoatDirectFields {
  const redact = (text: string) => redactKey(config, text);
  const closedCode = code !== undefined && TRANSPORT_ERROR_CODES.has(code) ? code : undefined;
  const words = transientWords(httpStatus, closedCode);
  // #20974: which 409, from Boat's closed fields only, so a run records it.
  const conflict = httpStatus === 409 && boat409 ? boat409Fields({ code: boat409.boatCode, state: boat409.boatState, retryable: boat409.boatRetryable }) : {};
  const conflictText = Object.keys(conflict).length ? ` [boat 409${conflict.boatCode ? ` code=${conflict.boatCode}` : ""}${conflict.boatState ? ` state=${conflict.boatState}` : ""}${conflict.boatRetryable !== undefined ? ` retryable=${conflict.boatRetryable}` : ""}]` : "";
  // F-04: Boat's closed 5xx fields (code, retryable, the restoring token) only.
  const failed: BoatDirectFields = httpStatus !== null && httpStatus >= 500 && direct ? direct : {};
  const failedText = Object.keys(failed).length ? ` [boat ${httpStatus}${failed.boatCode ? ` code=${failed.boatCode}` : ""}${failed.boatRetryable !== undefined ? ` retryable=${failed.boatRetryable}` : ""}${failed.boatMessage ? ` message=${failed.boatMessage}` : ""}]` : "";
  const error = Object.assign(new Error(redact(`Boat ${method} ${path} failed (${httpStatus ?? "unavailable"}): ${category}${words ? ` (${words})` : ""}${conflictText}${failedText}`)),
    { httpStatus, category }, Number.isInteger(httpStatus) ? { status: httpStatus as number } : {}, closedCode ? { code: closedCode } : {}, conflict, failed);
  if (error.stack) error.stack = redact(error.stack);
  return error;
}
type RequestOptions = {
  onHeaders?: (headers: Headers) => void; requireJson?: boolean; strictMissing?: boolean;
  /** A RUN renewal emits its own closed receipt, never provider diagnostic headers. */
  closedLogs?: boolean;
  /** At most this many sends (never above BOAT_MAX_ATTEMPTS). */
  maxSends?: number;
  /** An enclosing call's budget end: no wait here crosses it. */
  deadline?: number;
  /** An enclosing call's admission check, run immediately before every send. */
  sendGuard?: () => void;
  /**
   * rf-4 U1c C1: a spare create's fresh policy read (the keeper's admitCreate
   * path), re-run at the send boundary after every wait and before every resend.
   * false (or a throw) refuses the send. Only spare-purpose creates pass it.
   */
  sendAdmission?: () => Promise<boolean>;
  /** Our own stop: it ends the box's lifecycle and is never revoked by it. */
  ownStop?: boolean;
  /** F-04B: only explicitly repeatable plugin probes retain the frozen7 transient shape. */
  intent?: "idempotent_probe";
  /** F-04: the POST /commands payload. Each send marks its command text with its own attempt nonce. */
  command?: Record<string, unknown> & { command: string };
};
async function request(config: Config, path: string, init: RequestInit = {}, allowMissing = false, responseOptions: RequestOptions = {}): Promise<any> {
  let category: RequestErrorCategory = "request_error";
  let httpStatus: number | null = null;
  let signal: AbortSignal | undefined;
  let boat409: Boat409Fields | undefined;
  let archivingCommandConflict = false;
  let resumeStateConflict = false;
  // F-04 (boat-commands-table.md lines 12-18; boat-command-history.md line 18):
  // a POST /commands whose send was under way when it failed, or that Boat
  // answered with a 5xx other than 'did not run', possibly ran. It is never sent
  // again; it surfaces as boat_command_possibly_ran with history evidence.
  const commandCall = (init.method ?? "GET").toUpperCase() === "POST" && /^\/sandboxes\/[^/?]+\/commands$/.test(path);
  const commandSend = commandCall && responseOptions.intent !== "idempotent_probe";
  let commandInFlight = false;
  let possiblyRan: PossiblyRanReason | undefined;
  let attemptCommand: string | undefined;
  let direct: BoatDirectFields | undefined;
  // The evidence read is a read of the same box: never after our stop of it or a closed admission.
  let evidenceAllowed = () => false;
  try {
    if (init.method && init.method !== "GET") assertBoatActivityAdmission();
    const allocation = /^\/sandboxes\/([^/?]+)/.exec(path)?.[1];
    const boxKey = allocation ? activityKey(config, decodeURIComponent(allocation)) : undefined;
    if (boxKey) idleActivity.resource(boxKey);
    const generation = boxKey ? boxLifecycle(boxKey) : 0;
    // F-01: immediately before EVERY send (the first, and each after any wait):
    // the lease admission (a stop/release/destroy closes it) and the box's
    // lifecycle generation (our stop ends it) must still hold, plus any check the
    // enclosing call passed down (a 409 recovery runs under its call's check).
    const sideEffecting = (init.method ?? "GET").toUpperCase() !== "GET";
    const sendGuard = () => {
      if (sideEffecting) assertBoatActivityAdmission();
      if (boxKey && sideEffecting && !responseOptions.ownStop && boxLifecycle(boxKey) !== generation) throw new Error("Boat sandbox lease is no longer active.");
      responseOptions.sendGuard?.();
      // F-03-R: a late response must not authorize another send, including a
      // recovery resume or a retry after a late ready observation.
      callSignal.throwIfAborted();
      if (Date.now() >= deadline) throw new DOMException("Boat call budget expired.", "TimeoutError");
    };
    evidenceAllowed = () => {
      if (boxKey && boxLifecycle(boxKey) !== generation) return false;
      try { assertBoatActivityAdmission(); return true; } catch { return false; }
    };
    const maxSends = Math.max(1, Math.min(BOAT_MAX_ATTEMPTS, responseOptions.maxSends ?? BOAT_MAX_ATTEMPTS));
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.apiKey}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const requestBody = init.body;
    const isStreamBody = requestBody !== null && typeof requestBody === "object" &&
      (typeof (requestBody as { getReader?: unknown }).getReader === "function" || typeof (requestBody as { pipe?: unknown }).pipe === "function");
    let response: Response;
    const deadline = Math.min(Date.now() + BOAT_CALL_BUDGET_MS, responseOptions.deadline ?? Number.POSITIVE_INFINITY);
    const callSignal = init.signal ?? AbortSignal.timeout(BOAT_CALL_BUDGET_MS);
    signal = callSignal;
    const method = (init.method ?? "GET").toUpperCase();
    const route = path.replace(/^\/sandboxes\/[^/]+/, "/sandboxes/{sandboxId}");
    const waitForRateLimitPause = async (): Promise<boolean> => {
      const pauseUntil = boatRateLimitPauseUntil;
      const remaining = pauseUntil - Date.now();
      if (remaining <= 0) return false;
      const budget = deadline - Date.now();
      if (budget <= 0 || remaining > budget) {
        duplexLogger?.warn(`Boat IP rate-limit pause until ${new Date(pauseUntil).toISOString()}, call refused without a request`, {
          method, route, deadline: new Date(deadline).toISOString(),
        });
        // Refused without a request, but for the host this is Boat's 429: the
        // same status and '(rate limit)' words as frozen7's other transient
        // errors (frozen7-VERDICT F1). The distinct code is kept; the SDK
        // diagnostic forwards only the status, never a non-errno code.
        throw Object.assign(requestError(config, init.method ?? "GET", path, 429, "http_error"), { code: "boat_ip_rate_limit_paused" });
      }
      await delay(remaining, undefined, { signal: callSignal });
      return true;
    };
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
    // #20974: the command and files calls Boat holds or refuses with a 409 while a box starts.
    const commandOrFilesCall = /^\/sandboxes\/[^/?]+\/(?:commands|files)(?:[/?]|$)/.test(path);
    // F-04: GET and PUT /files: 'A file read or write gives the same result again'
    // (boat-commands-table.md line 17), so a did-not-run 502 is sent again under the
    // command rules. A network failure on them keeps frozen8's behaviour: the table
    // gives no other rule for it, so it is surfaced, not sent again.
    const filesCall = (method === "GET" || method === "PUT") && /^\/sandboxes\/[^/?]+\/files(?:\?|$)/.test(path);
    const resumeCall = method === "POST" && /^\/sandboxes\/[^/?]+\/resume$/.test(path);
    let resumeRecoveryUsed = false;
    for (let attempt = 1; ; attempt++) {
      // rf-4 U1c C1: every resend follows a wait (Retry-After, a 409 or 5xx
      // resend wait, an IP pause), and the setting may have turned off during it.
      // The enclosing caller's fresh async admission runs after the last wait and
      // before this send; a pause that begins during that read waits and re-reads.
      let readmit = responseOptions.sendAdmission !== undefined;
      for (;;) {
        if (await waitForRateLimitPause()) readmit = true;
        if (!readmit || !responseOptions.sendAdmission) break;
        readmit = false;
        let admitted = false;
        try { admitted = await responseOptions.sendAdmission(); } catch { admitted = false; }
        if (!admitted) throw Object.assign(new Error("Boat spare create not sent: spares are no longer on for this pool"), { code: "boat_spare_create_not_admitted" });
      }
      sendGuard();
      category = "network_error";
      httpStatus = null;
      boat409 = undefined;
      archivingCommandConflict = false;
      resumeStateConflict = false;
      direct = undefined;
      // F-04: this send's own nonce, a shell no-op at the START of the command text
      // (Boat's history keeps the first 64 KiB of it: boat-command-history.md line 41).
      let sendBody = requestBody;
      if (responseOptions.command) {
        attemptCommand = withCommandNonce(responseOptions.command.command, randomUUID());
        sendBody = JSON.stringify({ ...responseOptions.command, command: attemptCommand });
      }
      commandInFlight = commandSend;
      response = await fetch(`${apiBase(config)}${path}`, { ...init, body: sendBody, headers, redirect: "error", signal: callSignal });
      commandInFlight = false;
      httpStatus = response.status;
      if ((commandSend || filesCall) && response.status >= 500) {
        category = "http_error";
        direct = boatDirectFields(await response.clone().json().catch(() => null));
        if (classifyDirectFailure(response.status, direct) === "did_not_run") {
          // Did not run (table lines 17-18): send again inside this call's budget and
          // send cap; sendGuard checks lifecycle, admission, signal and deadline first.
          // sandbox_restoring: 'Retry after 1-3 seconds' (line 18).
          const waitMs = direct.boatMessage === BOAT_RESTORING ? BOAT_RESTORING_RESEND_MS : 0;
          if (!isStreamBody && attempt < maxSends && !callSignal.aborted && waitMs < deadline - Date.now()) {
            duplexLogger?.warn(`Boat API ${response.status}`, { method, route, attempt: `${attempt}/${maxSends}`, action: "send_again", ...direct });
            await response.body?.cancel();
            if (waitMs) await delay(waitMs, undefined, { signal: callSignal });
            continue;
          }
        } else if (commandSend) {
          // 'A command with a different message possibly ran ... When retryable is
          // false, the command can still be running. Do not run it again without a
          // check.' (line 17); a 500 is no better. Never sent again.
          possiblyRan = "http_5xx";
        }
        break;
      }
      if (response.status === 409) {
        category = "http_error";
        boat409 = boat409Fields(await response.clone().json().catch(() => null));
        // R8(c): boat-errors-table.md:9 / Boat llms-full:2103: these resume
        // conflicts are still changing. Keep frozen8's usable Retry-After wait.
        resumeStateConflict = resumeCall && boatResumeStateTransition(boat409.boatCode, response.headers.get("Retry-After"), deadline - Date.now());
        // F-04D: http_error is OUR fallback, not a documented Boat refusal.
        // Unknown/unparsed command 409s require a separate readiness GET. Only
        // archiving/archived proves not-run (readiness.md:21-22); otherwise an
        // arbitrary command stays possibly_ran, regardless of the body state.
        const unknownCommand = commandCall && (boat409.boatCode === undefined || boat409.boatCode === "other");
        const documentedNotRun = ["sandbox_starting", "sandbox_not_ready", "machine_not_running"].includes(boat409.boatCode ?? "");
        archivingCommandConflict = commandCall && boat409.boatCode !== "snapshot_data_expired" && (documentedNotRun || resumeRecoveryUsed ||
          (responseOptions.intent === "idempotent_probe" && unknownCommand && !["ready", "idle", "running"].includes(boat409.boatState ?? "")));
        if (unknownCommand && commandSend && !resumeRecoveryUsed) possiblyRan = "http_409";
        const resend = await boat409Resend(config, path, method, allocation ? decodeURIComponent(allocation) : undefined, boat409, {
          attempt, maxSends, deadline, callSignal, retryAfter: response.headers.get("Retry-After"),
          commandOrFilesCall: commandOrFilesCall && !isStreamBody, resumeCall, sendGuard,
          commandCall, unknownCommand, idempotentProbe: responseOptions.intent === "idempotent_probe" && !isStreamBody,
          confirmNotRun: () => { possiblyRan = undefined; archivingCommandConflict = true; },
          resumeRecoveryUsed, useResumeRecovery: () => { resumeRecoveryUsed = true; },
        });
        if (resend === false) break;
        // F-02: a recovery resume was one of this call's sends.
        attempt += resend;
        await response.body?.cancel();
        continue;
      }
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
        if (retryAfter === null && String(errorCode) === "IP_RATE_LIMIT_EXCEEDED") {
          const bodyWait = Number((body as any).retryAfter ?? (body as any).retryAfterSeconds);
          if (Number.isFinite(bodyWait) && bodyWait >= 0) retryAfterMs = bodyWait * 1_000;
        }
      }
      const isIpLimit = String(errorCode) === "IP_RATE_LIMIT_EXCEEDED";
      // Boat's body code and headers are provider text: through the one sanitiser (rf-4 U2 F1, J16).
      if (!isIpLimit && !responseOptions.closedLogs) duplexLogger?.warn("Boat API 429", {
        method, route, attempt: `${attempt}/${maxSends}`, retryAfter: redactProviderText(config, retryAfterText),
        rateLimit: logHeader(config, response.headers.get("RateLimit")), rateLimitPolicy: logHeader(config, response.headers.get("RateLimit-Policy")),
        ...(errorCode ? { code: providerWords(config, String(errorCode), 120) } : {}),
      });
      await response.body?.cancel();
      const hasRateLimitWait = retryAfter !== null || isIpLimit;
      if (isIpLimit) {
        retryAfterMs = Math.min(retryAfterMs, 120_000);
        // Boat may give the IP start window as an absolute timestamp instead
        // of Retry-After. No spare (or other call) may send inside that pause.
        const nextStartAt = providerTimestamp(body?.nextStartAt ?? body?.error?.nextStartAt);
        if (nextStartAt) retryAfterMs = Math.max(retryAfterMs, Date.parse(nextStartAt) - Date.now());
        boatRateLimitPauseUntil = Math.max(boatRateLimitPauseUntil, Date.now() + retryAfterMs);
        if (!responseOptions.closedLogs) duplexLogger?.warn("Boat IP rate-limit pause", {
          reason: "IP_RATE_LIMIT_EXCEEDED", pauseUntil: new Date(boatRateLimitPauseUntil).toISOString(),
          retryAfter: redactProviderText(config, retryAfterText), method, route,
          rateLimit: logHeader(config, response.headers.get("RateLimit")), rateLimitPolicy: logHeader(config, response.headers.get("RateLimit-Policy")),
        });
        await waitForRateLimitPause();
      } else if (retryAfter !== null) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || retryAfterMs > remainingMs) throw new Error(category);
        await delay(retryAfterMs, undefined, { signal: callSignal });
      }
      if (!retryableStart || isStreamBody || attempt >= maxSends || !["rate_limited", "limit_reached", "member_limit_reached"].includes(String(errorCode))) throw new Error(category);
      if (!hasRateLimitWait) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error(category);
        await delay(Math.min(2_000, remainingMs), undefined, { signal: callSignal });
      }
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
      // F-04: Boat answered 2xx, so the command ran, but its answer was lost.
      if (commandSend) possiblyRan = "unreadable_response";
      if (responseOptions.requireJson || commandSend) throw error;
      return null;
    });
    if (responseOptions.requireJson && body === null) throw new Error(category);
    return body;
  } catch (error) {
    if (error && typeof error === "object" && ["boat_ip_rate_limit_paused", "boat_spare_create_not_admitted"].includes(String((error as { code?: unknown }).code))) throw error;
    if (commandSend && (commandInFlight || possiblyRan)) {
      const reason: PossiblyRanReason = possiblyRan
        ?? (isOwnDeadline(error, signal) ? "timeout" : signal?.aborted ? "aborted" : "network_error");
      // EVIDENCE ONLY, never a resend trigger: Boat's docs promise no time by which
      // the record is visible (boat-command-history.md lines 37-63), so an absent
      // record is 'unknown'. One bounded GET, none after our stop of the box.
      const allocation = /^\/sandboxes\/([^/?]+)/.exec(path)![1];
      const evidence = await commandEvidence(evidenceAllowed() ? attemptCommand : undefined, () =>
        request(config, `/sandboxes/${allocation}/command-history?limit=20&mode=commands`,
          { signal: AbortSignal.timeout(COMMAND_HISTORY_READ_MS) }, false, { maxSends: 1,
            // R5: bind the parent's admission/lifecycle to the final GET dispatch,
            // not only to the early evidence check above. A refusal means unknown.
            sendGuard: () => { if (!evidenceAllowed()) throw new Error("Boat sandbox lease is no longer active."); },
          }));
      const outcome = commandPossiblyRanError(httpStatus, category, reason, evidence, direct ?? boat409);
      if (outcome.stack) outcome.stack = redactKey(config, outcome.stack);
      throw outcome;
    }
    // Without a definite HTTP refusal, keep only a closed errno from the fetch
    // failure; our own call deadline is ETIMEDOUT. The failure itself is dropped.
    const code = httpStatus !== null && httpStatus >= 400 ? undefined
      : isOwnDeadline(error, signal) ? "ETIMEDOUT" : closedTransportCode(error);
    const failure = requestError(config, init.method ?? "GET", path, httpStatus, category, code, boat409, direct);
    if (archivingCommandConflict || resumeStateConflict) {
      // A documented or state-confirmed refusal, including a second 409 after
      // recovery, gets ONE named transient across the real RPC text predicate.
      failure.message = `boat_sandbox_state_transition: ${failure.message} (state change in progress)`;
      if (failure.stack) failure.stack = failure.stack.replace("Error: ", "Error: boat_sandbox_state_transition: ").replace("\n", " (state change in progress)\n");
      Object.assign(failure, { code: "boat_sandbox_state_transition" });
    }
    throw failure;
  }
}
/**
 * Boat's documented 409 handling, inside the call's existing bound: its signal,
 * its send cap (BOAT_MAX_ATTEMPTS, or less for a recovery resume), its admission
 * and box lifecycle checked before every send, and no wait past the call budget
 * (min of the 30 s deadline and the signal). A number: send again, after that
 * many extra sends of this call. false: surface the 409.
 * - sandbox_starting (readiness.md:29; troubleshooting): Boat held the command
 *   or files call up to 60 s; send it again after BOAT_STARTING_RESEND_MS.
 * - sandbox_not_ready / machine_not_running (readiness.md:31; troubleshooting:
 *   'Run boat resume, then retry'): command calls get ONE resume + ready wait
 *   + resend, even without a prior resume; files retain the recent-OUR-resume
 *   gate. A recent explicit resume shares one recovery across later calls.
 *   sandbox_starting only resends; Boat says 'Send it again', not resume.
 * - sandbox_stopping (troubleshooting: the resume answer carries Retry-After;
 *   'Wait that many seconds ... Then run the same resume again'): resume only.
 * - F-04D unknown/unparsed command 409: GET readiness, never infer from the
 *   error body. Archiving/archived proves not-run for ANY command. Poll until
 *   archived, resume once, wait ready, resend once. Other/unreadable states
 *   remain possibly_ran for arbitrary commands. Explicit probes retain their
 *   F-04C stopping/stopped aliases. No idle poller or new command budget.
 * - Other documented codes are surfaced as is: snapshot_data_expired
 *   (https://docs.boat.dev/troubleshooting.md, section '409 snapshot_data_expired':
 *   'Resume, fork and a saved snapshot save of this sandbox fail. You cannot get
 *   the data back.'). Unknown non-command codes are surfaced as is.
 */
async function boat409Resend(config: Config, path: string, method: string, id: string | undefined, fields: Boat409Fields, call: {
  attempt: number; maxSends: number; deadline: number; callSignal: AbortSignal; retryAfter: string | null;
  commandOrFilesCall: boolean; resumeCall: boolean; sendGuard: () => void; resumeRecoveryUsed: boolean; useResumeRecovery: () => void;
  commandCall: boolean; unknownCommand: boolean; idempotentProbe: boolean; confirmNotRun: () => void;
}): Promise<number | false> {
  if (call.callSignal.aborted || !id || Date.now() >= call.deadline || stoppedBoxes.has(activityKey(config, id))) return false;
  // A command's own signal can outlast its 30 s request budget. Bound actual
  // recovery fetches too, for unknown AND documented refusals.
  const signal = AbortSignal.any([call.callSignal, AbortSignal.timeout(Math.max(1, call.deadline - Date.now()))]);
  const canResume = () => call.commandOrFilesCall && !call.resumeRecoveryUsed && call.attempt + 2 <= call.maxSends;
  const resume = async (): Promise<boolean> => {
    // Shared with the existing not-ready recovery: one resume send, followed
    // by ready observations, all bound to the ORIGINAL admission/deadline.
    try {
      await request(config, `/sandboxes/${encodeURIComponent(id)}/resume`, { method: "POST", signal,
        body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(config), ...(config.boatEnvironment === undefined ? { noEnv: true } : {}) }) },
      false, { maxSends: 1, deadline: call.deadline, sendGuard: call.sendGuard });
      await waitReady(config, id, true, { signal, deadline: call.deadline, sendGuard: call.sendGuard });
      call.sendGuard(); // even a late ready response cannot authorize a resend
      return true;
    } catch { return false; }
  };
  if (call.unknownCommand) {
    if (call.resumeRecoveryUsed) return false; // second 409: named error, never a loop
    // A body field or missing history is not evidence that a command did not
    // run. Read the SAME box using the existing readiness endpoint first.
    while (Date.now() < call.deadline) {
      let sandbox: any;
      try {
        const result = await request(config, `/sandboxes/${encodeURIComponent(id)}`, { signal }, false,
          { maxSends: 1, deadline: call.deadline, sendGuard: call.sendGuard, requireJson: true });
        call.sendGuard();
        sandbox = result?.sandbox ?? result;
        assertSandboxId(sandbox, id);
      } catch { return false; } // unreadable GET never grants replay authority
      const archived = sandbox.state === "archived" || (call.idempotentProbe && sandbox.state === "stopped");
      const archiving = sandbox.state === "archiving" || (call.idempotentProbe && sandbox.state === "stopping");
      if (!archived && !archiving) return false;
      call.confirmNotRun();
      if (!canResume()) return false;
      if (archived) {
        call.useResumeRecovery();
        return await resume() ? 1 : false;
      }
      // No new worker timer: only this refused call's bounded transition wait.
      await delay(Math.min(500, Math.max(0, call.deadline - Date.now())), undefined, { signal });
    }
    return false;
  }
  if (call.commandCall && ["sandbox_not_ready", "machine_not_running"].includes(fields.boatCode ?? "")) {
    const ours = ourResumes.get(activityKey(config, id));
    // A recent explicit resume owns one shared recovery, not one per command.
    // Fall through to that owner even when it has already settled. Without a
    // recent owner, readiness.md:31 still requires one bounded resume per call.
    if (!ours || Date.now() - ours.at > BOAT_RESUME_RECOVERY_WINDOW_MS) {
      if (!canResume()) return false;
      call.useResumeRecovery();
      return await resume() ? 1 : false;
    }
  }
  if (call.attempt >= call.maxSends) return false;
  const route = path.replace(/^\/sandboxes\/[^/?]+/, "/sandboxes/{sandboxId}").replace(/\?.*$/, "");
  const log = (action: string) => duplexLogger?.warn("Boat API 409", { method, route, attempt: `${call.attempt}/${call.maxSends}`, action, ...fields });
  if (fields.boatCode === "sandbox_starting" && call.commandOrFilesCall) {
    // F-03: the resend wait never crosses the call budget.
    if (BOAT_STARTING_RESEND_MS > call.deadline - Date.now()) return false;
    log("send_again");
    await delay(BOAT_STARTING_RESEND_MS, undefined, { signal: call.callSignal });
    return 0;
  }
  if ((fields.boatCode === "sandbox_not_ready" || fields.boatCode === "machine_not_running") && call.commandOrFilesCall && !call.resumeRecoveryUsed) {
    // F-02: the recovery resume and the retried call are both sends of this call.
    if (call.attempt + 2 > call.maxSends) return false;
    const ours = ourResumes.get(activityKey(config, id));
    if (!ours || Date.now() - ours.at > BOAT_RESUME_RECOVERY_WINDOW_MS || ours.settled) return false;
    call.useResumeRecovery();
    if (!ours.recovery) {
      log("resume_again");
      // F-01: every send of the recovery (the resume and each ready poll) runs
      // this call's admission and box lifecycle check first.
      ours.recovery = resume().finally(() => { ours.settled = true; });
    }
    return await ours.recovery ? 1 : false;
  }
  if (fields.boatCode === "sandbox_stopping" && call.resumeCall && call.retryAfter !== null) {
    const seconds = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(call.retryAfter);
    const waitMs = seconds ? Number(seconds[1]) * 1_000 : NaN;
    if (!Number.isFinite(waitMs) || waitMs > call.deadline - Date.now()) return false;
    log("resume_after_retry_after");
    await delay(waitMs, undefined, { signal: call.callSignal });
    return 0;
  }
  return false;
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
/** Match the host's sandboxStateTransitionFailure predicate; never emit raw state text. */
export function boatStartDeadlineMessage(id: string, state: unknown): string {
  const token = typeof state === "string" && state.length > 0 && !/[^a-z_]/.test(state) ? state : "unknown";
  return `Boat sandbox ${id} is still ${token} at its start deadline`;
}
/** Boat llms-full:2103 (boat-errors-table.md:9): only these resume conflicts settle. */
export function boatResumeStateTransition(code: string | undefined, retryAfter: string | null, remainingMs: number): boolean {
  if (code === "sandbox_resuming") return true;
  if (code !== "sandbox_stopping") return false;
  // Same numeric grammar and inclusive budget as frozen8's boat409Resend.
  const seconds = retryAfter === null ? null : /^\s*(\d+(?:\.\d+)?)\s*$/.exec(retryAfter);
  const waitMs = seconds ? Number(seconds[1]) * 1_000 : NaN;
  return !Number.isFinite(waitMs) || waitMs > remainingMs;
}
/** Boat reported the box `error` ("Start or runtime failed", api/v1 lifecycle,
 * boat-llms-full.txt:2255) or `archived` while we waited for it to be ready. */
class BoatSandboxStateError extends Error {
  constructor(readonly sandboxId: string, readonly state: "error" | "archived") {
    super(`Boat sandbox ${sandboxId} entered ${state}`);
  }
}
// Daytona's create cap within its acquire budget (#20828, daytona plugin.ts
// DAYTONA_CREATE_ATTEMPT_MS / DAYTONA_ACQUIRE_ATTEMPT_BUDGET_MS), measured from
// the start of this create attempt.
const BOAT_CREATE_ATTEMPT_MS = 90_000;
const BOAT_ACQUIRE_ATTEMPT_BUDGET_MS = 180_000;
const BOAT_CREATE_LOOKUP_INTERVAL_MS = 5_000;
/**
 * A step's own abort signal, never past the acquisition budget's end (rf-4 U3b
 * C1): an in-flight call is aborted at the budget, not at its own later
 * timeout. Daytona bounds the same way: each phase gets only the remaining
 * time (`deadline - Date.now()`, daytona plugin.ts:3075, :3089) inside one
 * enclosing deadline race (:3145-3163).
 */
function withinBudget(deadline: number, ms: number): AbortSignal {
  return AbortSignal.timeout(Math.max(0, Math.min(ms, deadline - Date.now())));
}
/** The acquisition budget's step state: each step enters by name, and no step starts after the budget. */
type AcquisitionBudget = { deadline: number; enter: (phase: string) => void };
/** rf-4 U3 C3: the five phases one `boat.acquire.phases` line stamps. */
const ACQUIRE_PHASES = ["create", "ready", "setup", "sync", "handoff"] as const;
// Budget step name -> stamped phase. "handoff" entered before the handoff's
// calls starts sync (sentinel, guardian, file writes); "duplex" (binding the
// lease) starts handoff, which runs until the lease is returned.
const ACQUIRE_PHASE_OF: Record<string, number> = { create: 0, adopt: 0, ready: 1, setup: 2, handoff: 3, sentinel: 3, guardian: 3, duplex: 4 };
/**
 * The acquisition's phase clock (rf-4 U3 C3). Steps only move forward; a phase
 * never entered is 0 ms, and the phases sum to the total exactly.
 */
function acquirePhaseClock(startedAt: number) {
  const starts = [startedAt];
  return {
    enter(step: string): void {
      const index = ACQUIRE_PHASE_OF[step];
      if (index === undefined || index < starts.length) return;
      const now = Date.now();
      while (starts.length <= index) starts.push(now);
    },
    current: (): (typeof ACQUIRE_PHASES)[number] => ACQUIRE_PHASES[starts.length - 1],
    stamp(endedAt: number) {
      const phasesMs = Object.fromEntries(ACQUIRE_PHASES.map((name, i) =>
        [name, i >= starts.length ? 0 : Math.max(0, (i + 1 < starts.length ? starts[i + 1] : endedAt) - starts[i])])) as Record<(typeof ACQUIRE_PHASES)[number], number>;
      return { phasesMs, totalMs: Math.max(0, endedAt - startedAt) };
    },
  };
}
type AcquirePhaseStamp = { phasesMs: Record<(typeof ACQUIRE_PHASES)[number], number>; totalMs: number };
/** What an ordinary create reports to the acquisition's one line. */
type OrdinaryAcquireStamp = AcquirePhaseStamp & { startedAt: number; source: "created" | "adopted"; outcome: "ok" | "budget" | "error"; failedPhase?: string };
/**
 * review-fleet-4 C1 (rf4-u3c F2): the ONE outer `boat.acquire.phases` emitter.
 * It wraps the whole acquisition hook, so every exit (a warmed-spare handoff,
 * a preflight, validation or admission refusal, and an ordinary create) emits
 * exactly one line. `preflight` is the time before the create or spare handoff
 * began (setting reads, owed stops, the spare claim); the phases sum to totalMs.
 * An ordinary create reports its own stamp here instead of logging it.
 */
function acquirePhaseLine(params: { companyId: string; environmentId: string }, startedAt: number) {
  let ordinary: OrdinaryAcquireStamp | undefined;
  let spareHandoffAt: number | undefined;
  let emitted = false;
  return {
    ordinary(stamp: OrdinaryAcquireStamp): void { ordinary = stamp; },
    spareHandoff(): void { spareHandoffAt ??= Date.now(); },
    emit(ok: boolean): void {
      if (emitted) return;
      emitted = true;
      try {
        const endedAt = Date.now();
        const phasesMs = { preflight: 0, create: 0, ready: 0, setup: 0, sync: 0, handoff: 0 };
        let source: "created" | "adopted" | "spare" | "none", outcome: "ok" | "budget" | "error", failedPhase: string | undefined;
        if (ordinary) {
          Object.assign(phasesMs, ordinary.phasesMs);
          phasesMs.preflight = Math.max(0, ordinary.startedAt - startedAt);
          ({ source, outcome, failedPhase } = ordinary);
        } else if (spareHandoffAt !== undefined) {
          phasesMs.preflight = Math.max(0, spareHandoffAt - startedAt);
          phasesMs.handoff = Math.max(0, endedAt - spareHandoffAt);
          source = "spare"; outcome = ok ? "ok" : "error"; failedPhase = ok ? undefined : "handoff";
        } else {
          phasesMs.preflight = Math.max(0, endedAt - startedAt);
          source = "none"; outcome = ok ? "ok" : "error"; failedPhase = ok ? undefined : "preflight";
        }
        const totalMs = Object.values(phasesMs).reduce((total, ms) => total + ms, 0);
        // Numbers and fixed words only: no provider text reaches it.
        duplexLogger?.info("boat.acquire.phases", { companyId: params.companyId, environmentId: params.environmentId,
          source, outcome, ...(failedPhase ? { failedPhase } : {}), phasesMs, totalMs, budgetMs: BOAT_ACQUIRE_ATTEMPT_BUDGET_MS });
      } catch { /* Logging never changes allocation outcome. */ }
    },
  };
}
/** Our create POST reached its own 30 s deadline (or a transport ETIMEDOUT)
 * with no HTTP answer: Boat may still be creating the box, as Daytona's create
 * is still pending at its cap. Any other failure is a create that failed, which
 * keeps the cleanup path (Daytona: destroyFailedCreation). */
function createTimedOut(error: unknown): boolean {
  const fields = error && typeof error === "object" ? error as { httpStatus?: unknown; code?: unknown } : {};
  return fields.httpStatus === null && fields.code === "ETIMEDOUT";
}
/**
 * Daytona's createWithinCap/lookupCreation (#20828) for Boat. The create timed
 * out, so look up the box it made by its own `paperclip-acquire` label
 * (list-sandboxes, boat-llms-full.txt:1791-1794; ownership checked by
 * acquisitionMatches) until the create cap. The Idempotency-Key keeps it one
 * box (create-sandbox, boat-llms-full.txt:2230-2242), so no second create is
 * sent. One match is returned for adoption; the caller waits for it to be
 * ready inside the acquire budget. A failed lookup (Daytona: `unavailable`),
 * several matches, or nothing by the cap (`absent`) rethrow the create's own
 * error, with its closed status and errno unchanged (frozen7), so the
 * caller's cleanup lookup runs and the host retries the ETIMEDOUT. The step,
 * time and provider state are added as closed fields; the SDK on this line has
 * no envelope that carries them without a cleanup record (upstream #22194's
 * PluginEnvironmentAcquisitionError).
 */
/** Core's creation settle floor (sandbox-creation-operations.ts CREATION_SETTLE_FLOOR_MS). */
const BOAT_CREATION_SETTLE_MS = 30 * 60_000;
/** This worker's creates whose POST timed out: attempt -> settle deadline. Lost on restart, where core's own settle deadline still holds absence inconclusive. */
const unsettledCreates = new Map<string, number>();
function noteUnsettledCreate(attemptId: string, startedAt: number): void {
  const now = Date.now();
  for (const [attempt, until] of unsettledCreates) if (until <= now) unsettledCreates.delete(attempt);
  unsettledCreates.set(attemptId, startedAt + BOAT_CREATION_SETTLE_MS);
}
function createStillSettling(attemptId: string): boolean {
  const until = unsettledCreates.get(attemptId);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  unsettledCreates.delete(attemptId);
  return false;
}
async function findTimedOutCreation(config: Config, attemptId: string, owner: { companyId: string; environmentId: string; runId?: string }, createError: unknown, createStartedAt: number): Promise<string> {
  if (!createTimedOut(createError) || shuttingDown) throw createError;
  const capAt = createStartedAt + BOAT_CREATE_ATTEMPT_MS;
  const fail = (providerState: "absent" | "unavailable" | "other") => Object.assign(createError as object, {
    phase: "create", providerState, elapsedMs: Math.max(0, Date.now() - createStartedAt), budgetMs: BOAT_CREATE_ATTEMPT_MS });
  for (;;) {
    let ids: string[] | undefined;
    try { ids = await acquisitionMatches(config, attemptId, owner, capAt); }
    catch { ids = undefined; }
    // The cap is strict (rf-4 U3 C1): a lookup that returns after it admits
    // nothing, even a box it found. Daytona decides the same way after its
    // lookup (daytona plugin.ts:3034-3035, `if (expired ...) return creating`).
    // The late box is not lost: the caller's cleanup lists the label again and
    // stops it, and core's creation intent keeps owning it.
    if (Date.now() >= capAt) throw fail(ids && ids.length > 1 ? "other" : "absent");
    if (ids === undefined) throw fail("unavailable");
    if (ids.length === 1) return ids[0];
    // More than one box for one idempotent create: adopt none; cleanup stops all.
    if (ids.length > 1) throw fail("other");
    const remaining = capAt - Date.now();
    if (remaining <= 0 || shuttingDown) throw fail("absent");
    await delay(Math.min(BOAT_CREATE_LOOKUP_INTERVAL_MS, remaining));
  }
}
// Create-retry money unit (plugin half). Boat returns the same sandbox for a
// retry with the "same account, key and request body" and answers a changed
// body with 409 idempotency_key_reused (https://docs.boat.dev/llms-full.txt
// :2229, :2243). The host re-sends a pending creation under the SAME creation
// id (= Idempotency-Key), so its body must not change: the only per-call part
// was the `expiry` label (Date.now() per call). It is fixed at the creation's
// first send and kept for Boat's 24 h key life (:2246), in memory and in the
// company's plugin state so a re-send after a worker restart repeats it too.
const BOAT_IDEMPOTENCY_KEY_LIFE_MS = 24 * 60 * 60 * 1000;
const CREATE_EXPIRY_NAMESPACE = "boat-create-expiry";
const CREATE_EXPIRY_STATE_KEY = "by-creation";
type CreateExpiries = Record<string, { expiry: string; at: number }>;
/** The sole key maker for ordinary creates and durable spare refills. */
function creationIdentityId(requested?: string): string { return requested ?? randomUUID(); }
const createExpiries = new Map<string, { expiry: string; at: number }>();
const createExpiryWrites = new Map<string, Promise<void>>();
async function creationExpiry(companyId: string, creationId: string, ttlSeconds: number): Promise<string> {
  const now = Date.now(), live = (entry: unknown): entry is { expiry: string; at: number } => !!entry && typeof entry === "object"
    && typeof (entry as any).expiry === "string" && Number.isFinite(Date.parse((entry as any).expiry))
    && typeof (entry as any).at === "number" && now - (entry as any).at <= BOAT_IDEMPOTENCY_KEY_LIFE_MS;
  for (const [key, entry] of createExpiries) if (!live(entry)) createExpiries.delete(key);
  const memoryKey = `${companyId}\0${creationId}`;
  const cached = createExpiries.get(memoryKey);
  if (cached) return cached.expiry;
  const scope = { scopeKind: "company" as const, scopeId: companyId, namespace: CREATE_EXPIRY_NAMESPACE, stateKey: CREATE_EXPIRY_STATE_KEY };
  const state = pluginContext?.state;
  const previous = createExpiryWrites.get(companyId) ?? Promise.resolve();
  let expiry = "";
  // One read-modify-write per company at a time, so concurrent creates keep each other's entries.
  const write = previous.catch(() => undefined).then(async () => {
    let stored: CreateExpiries = {};
    if (state?.get) {
      try { const value = await state.get(scope); if (value && typeof value === "object" && !Array.isArray(value)) stored = value as CreateExpiries; }
      catch { duplexLogger?.warn("Boat create expiry state read failed", { companyId }); }
    }
    const kept: CreateExpiries = Object.fromEntries(Object.entries(stored).filter(([, entry]) => live(entry)));
    const known = kept[creationId];
    if (known) { expiry = known.expiry; createExpiries.set(memoryKey, known); return; }
    const entry = { expiry: new Date(now + ttlSeconds * 1000).toISOString(), at: now };
    expiry = entry.expiry; createExpiries.set(memoryKey, entry);
    if (!state?.set) return;
    try { await state.set(scope, { ...kept, [creationId]: entry }); }
    catch { duplexLogger?.warn("Boat create expiry state write failed", { companyId }); }
  });
  createExpiryWrites.set(companyId, write);
  try { await write; }
  finally { if (createExpiryWrites.get(companyId) === write) createExpiryWrites.delete(companyId); }
  return expiry;
}
/**
 * The host sees Boat's idempotency outcome across the worker connection only as
 * the plugin SDK's closed creationIdempotencyCode, which the SDK reads from the
 * acquire error's (or a cause's) string `code`. It decides the host retry:
 * key_reused and box_stopped spend the creation (the next retry mints a fresh
 * key); in_progress is carried (the same key is sent again). Boat's code rides
 * as a cause, so the error's own fields (status, boatCode, code) stay as they are.
 */
function nameCreationIdempotency<E extends Error>(error: E, code: EnvironmentCreationIdempotencyCode): E {
  const named = Object.assign(new Error(`Boat create ${code}`), { code });
  if (error.cause !== undefined) named.cause = error.cause;
  error.cause = named;
  return error;
}
/** Boat's "Retry shortly with the same key" (:2242) pause between create sends. */
const BOAT_IDEMPOTENCY_IN_PROGRESS_RESEND_MS = 2_000;
function boatCreateCode(error: unknown): string | undefined {
  const fields = error && typeof error === "object" ? error as { status?: unknown; boatCode?: unknown } : {};
  return fields.status === 409 && typeof fields.boatCode === "string" ? fields.boatCode : undefined;
}
/**
 * One create send per creation, with the SAME key and byte-identical body:
 * 409 idempotency_in_progress is sent again (:2242) inside the strict create
 * cap (BOAT_CREATE_ATTEMPT_MS from the first send), then the box the create
 * returns is the one adopted. 409 idempotency_key_reused (:2243) should never
 * happen now; it is surfaced as its own named error and NEVER answered by a
 * create under a new key.
 *
 * The cap is strict here as in findTimedOutCreation (rf-4 U3 C1): a resend is
 * bounded by what remains of the cap (its abort and its send deadline), the
 * cap is re-checked after every resend and after every pause, and a box a
 * resend answers with after the cap is never adopted: the 409 that started the
 * resends is thrown, so the caller's cleanup lists the label and stops it.
 */
async function sendCreate(config: Config, attemptId: string, body: string, createStartedAt: number, deadline: number): Promise<any> {
  const capAt = createStartedAt + BOAT_CREATE_ATTEMPT_MS;
  let inProgress: unknown;
  for (;;) {
    try {
      // The first send keeps its own 30 s deadline (inside the cap); a resend gets only what remains of the cap.
      const sendMs = inProgress === undefined ? 30_000 : Math.min(30_000, capAt - Date.now());
      if (sendMs <= 0) throw inProgress;
      const created = await request(config, "/sandboxes", { method: "POST", signal: withinBudget(deadline, sendMs), headers: { "Idempotency-Key": attemptId }, body },
        false, inProgress === undefined ? {} : { deadline: capAt });
      if (inProgress !== undefined && Date.now() >= capAt) throw inProgress;
      return created;
    } catch (error) {
      if (error === inProgress) throw error;
      const code = boatCreateCode(error);
      if (code === "idempotency_key_reused") {
        const failure = error as Error & { code?: string };
        failure.message = `boat_idempotency_key_reused: ${failure.message} (Boat holds this creation's Idempotency-Key with a different request body; no create was sent under a new key)`;
        if (failure.stack) failure.stack = failure.stack.replace("Error: ", "Error: boat_idempotency_key_reused: ");
        failure.code = "boat_idempotency_key_reused";
        throw nameCreationIdempotency(failure, "idempotency_key_reused");
      }
      // A key still in progress when the cap ends escapes as this 409.
      if (code === "idempotency_in_progress" && error instanceof Error) nameCreationIdempotency(error, code);
      if (code !== "idempotency_in_progress" || shuttingDown
        || Date.now() + BOAT_IDEMPOTENCY_IN_PROGRESS_RESEND_MS >= capAt) throw error;
      inProgress = error;
      duplexLogger?.warn("Boat create 409 idempotency_in_progress; sending the same create again", { attemptId });
      await delay(BOAT_IDEMPOTENCY_IN_PROGRESS_RESEND_MS);
      if (shuttingDown || Date.now() >= capAt) throw error;
    }
  }
}
// review-fleet-4 GAP 1. A key still in progress at the strict cap fails the
// acquire, and our cleanup stops the box Boat was building. The host retry
// re-sends the same key and body, and Boat's dedupe (:2229) answers with that
// same box, now stopped, stopping, or running with our stop still owed (Boat
// refused it and retries it by itself). Such a box is NEVER handed over as a
// ready lease. It is not resumed either (our stop ends our resume, see
// stopSandbox): the attempt fails typed and the caller's cleanup keeps the box.
const DEDUPED_BOX_STOP_STATES: ReadonlySet<string> = new Set(["stopping", "stopped", "archiving", "archived"]);
class BoatDedupedBoxStoppedError extends Error {
  readonly code = "boat_idempotency_box_stopped";
  constructor(readonly sandboxId: string, readonly observed: string) {
    super(`boat_idempotency_box_stopped: Boat answered this creation's Idempotency-Key with sandbox ${sandboxId}, which is ${observed}. `
      + "A stopped or stopping box is never handed over as a ready lease and is not resumed; the acquire's cleanup keeps it.");
    this.name = "BoatDedupedBoxStoppedError";
  }
}
/** The closed reason a create's box is stopped or stopping, from Boat's own observation (which survives a worker restart); undefined when it is not. */
function dedupedBoxStop(sandbox: any): string | undefined {
  if (typeof sandbox?.state === "string" && DEDUPED_BOX_STOP_STATES.has(sandbox.state)) return sandbox.state;
  const stop = sandbox?.stop;
  if (stop && typeof stop === "object" && (stop.status === "pending" || stop.status === "failing")) return `running with a ${stop.status} stop`;
  return undefined;
}
async function waitReady(config: Config, id: string, allowArchived = false, bound: { signal?: AbortSignal; deadline?: number; sendGuard?: () => void; observe?: (sandbox: any) => void } = {}): Promise<any> {
  // A bounded caller (a 409 recovery) never waits past its call budget, and its
  // admission and lifecycle check runs before every poll (frozen8 F-01/F-03).
  const until = Math.min(Date.now() + 120_000, bound.deadline ?? Number.POSITIVE_INFINITY);
  const options: RequestOptions = { ...(bound.deadline !== undefined ? { deadline: bound.deadline } : {}), ...(bound.sendGuard ? { sendGuard: bound.sendGuard } : {}) };
  let lastObservedState: unknown;
  while (Date.now() < until) {
    let result: any;
    // A deadline-only caller (the acquisition budget) bounds each poll's own
    // 30 s call timeout by the deadline, so a poll in flight ends there.
    const pollSignal = bound.signal ?? (bound.deadline !== undefined ? withinBudget(bound.deadline, BOAT_CALL_BUDGET_MS) : undefined);
    try { result = await request(config, `/sandboxes/${encodeURIComponent(id)}`, pollSignal ? { signal: pollSignal } : {}, false, options); }
    catch (error) {
      // A caller's timeout signal can fire during the poll, not only between polls.
      // A definite HTTP refusal must not become transient just because it was late.
      if (pollSignal?.aborted && isOwnDeadline(error, pollSignal) && closedTransportCode(error) === "ETIMEDOUT"
          && (bound.signal !== undefined || Date.now() >= until)) break;
      throw error;
    }
    const s = result.sandbox ?? result;
    assertSandboxId(s, id);
    // A caller's check of every observation, before it can count as ready (GAP 1).
    bound.observe?.(s);
    if (["ready", "idle", "running"].includes(s.state)) return s;
    if (s.state === "error" || (!allowArchived && s.state === "archived")) throw new BoatSandboxStateError(id, s.state);
    lastObservedState = s.state;
    // Bounded transition observation only; no idle worker poller. Ready webhook
    // delivery belongs to the host; this acquisition has no callback endpoint.
    try { await delay(Math.min(500, Math.max(0, until - Date.now())), undefined, bound.signal ? { signal: bound.signal } : undefined); }
    catch (error) {
      if (bound.signal?.aborted && isOwnDeadline(error, bound.signal)) break;
      throw error;
    }
  }
  throw new Error(boatStartDeadlineMessage(id, lastObservedState));
}
async function waitSetup(config: Config, id: string, deadline?: number): Promise<any> {
  const setupUntil = Date.now() + config.setupTimeoutSeconds * 1000;
  // The acquisition budget bounds setup too (rf-4 U3 C1; Daytona's one budget
  // covers creation and setup, daytona plugin.ts:2981-2987).
  const until = Math.min(setupUntil, deadline ?? Number.POSITIVE_INFINITY);
  while (Date.now() < until) {
    // rf-4 U3b C1: a setup GET in flight at the budget is aborted there, not at
    // its own 30 s call timeout.
    const pollSignal = deadline === undefined ? undefined : withinBudget(deadline, BOAT_CALL_BUDGET_MS);
    let result: any;
    try { result = await request(config, `/sandboxes/${encodeURIComponent(id)}`, pollSignal ? { signal: pollSignal } : {}, false, deadline === undefined ? {} : { deadline }); }
    catch (error) {
      if (pollSignal?.aborted && isOwnDeadline(error, pollSignal) && closedTransportCode(error) === "ETIMEDOUT" && Date.now() >= until) break;
      throw error;
    }
    const s = result.sandbox ?? result;
    assertSandboxId(s, id);
    if (s.setupStatus === "done") return s;
    if (s.setupStatus === "failed") {
      const detail = typeof s.setupError === "string" ? s.setupError : typeof s.setupErrorText === "string" ? s.setupErrorText : typeof s.error === "string" ? s.error : s.error?.message;
      // Boat's setup text leaves the worker verbatim (RPC message): the one redactor, bounded (rf-4 U2b C1).
      const words = typeof detail === "string" ? providerWords(config, detail) : null;
      throw stopDiagnostic(config, `Boat sandbox ${id} setup failed${words ? `: ${words}` : "."}`);
    }
    await delay(Math.min(2000, Math.max(0, until - Date.now())));
  }
  // A Boat-side setup deadline is transient: the host retries it by this errno.
  if (until < setupUntil) throw Object.assign(new Error(`Boat sandbox ${id} setup did not finish within the acquisition budget`), { code: "ETIMEDOUT" });
  throw Object.assign(new Error(`Boat sandbox ${id} setup timed out after ${config.setupTimeoutSeconds} seconds`), { code: "ETIMEDOUT" });
}
async function stopSandbox(config: Config, id: string): Promise<{ providerLeaseId: string; state: "stopped" }> {
  const refreshWork = cancelRunLeaseTtlRefresh(activityKey(config, id))?.work;
  // Our stop ends "our resume": a later not-ready 409 must never wake this box.
  ourResumes.delete(activityKey(config, id));
  stoppedBoxes.add(activityKey(config, id));
  // It also ends the box's lifecycle generation, now and once it completes, so
  // no call bound to the old generation (an in-flight 409 recovery) sends again.
  endBoxLifecycle(activityKey(config, id));
  try {
    await refreshWork;
    return await stopSandboxRequests(config, id);
  } finally { endBoxLifecycle(activityKey(config, id)); }
}
/** Boat's words for a refused stop: its `error` text or closed fields, sanitised and bounded. */
function boatStopWords(config: Config, error: unknown): string | null {
  const text = typeof error === "string" ? error
    : error && typeof error === "object" ? [(error as { code?: unknown }).code, (error as { message?: unknown }).message]
      .filter((part): part is string => typeof part === "string" && !!part.trim()).join(": ") : "";
  return providerWords(config, text);
}
/** A stop diagnostic built from Boat's fields, through the one sanitiser (message and stack). */
function stopDiagnostic(config: Config, message: string): Error {
  const error = new Error(redactProviderText(config, message));
  if (error.stack) error.stack = redactProviderText(config, error.stack);
  return error;
}
/** Boat refused this box's stop and the back-off has not ended. */
function stopRefusalActive(config: Config, id: string): boolean {
  const refusal = stopRefusals.get(activityKey(config, id));
  return refusal !== undefined && Date.now() < refusal.until;
}
function refuseStop(config: Config, id: string, stopId: string, status: string, error: unknown, snapshotCompletedAt: unknown): BoatStopRefusedError {
  const key = activityKey(config, id);
  const refusals = (stopRefusals.get(key)?.refusals ?? 0) + 1;
  const until = Date.now() + Math.min(BOAT_STOP_REFUSAL_BACKOFF_CAP_MS, BOAT_STOP_REFUSAL_BACKOFF_MS * 2 ** Math.min(refusals - 1, 20));
  // Every field below leaves the worker (message, typed fields, RPC): one sanitiser, closed shapes.
  const refused = new BoatStopRefusedError(redactKey(config, id), providerWords(config, stopId, 120) ?? "unknown", providerStatus(config, status),
    boatStopWords(config, error), providerTimestamp(snapshotCompletedAt), new Date(until).toISOString(), refusals);
  stopRefusals.delete(key);
  stopRefusals.set(key, { until, refusals, error: refused });
  for (const oldest of stopRefusals.keys()) { if (stopRefusals.size <= BOAT_STOP_REFUSAL_MEMORY) break; stopRefusals.delete(oldest); }
  return refused;
}
async function stopSandboxRequests(config: Config, id: string): Promise<{ providerLeaseId: string; state: "stopped" }> {
  idleActivity.resource(activityKey(config, id));
  // Inside the back-off after Boat refused this box's stop: no new POST /stop
  // (Boat would return the same pending stop, docs :1855-1856) and no new wait.
  const refusal = stopRefusals.get(activityKey(config, id));
  if (refusal && Date.now() < refusal.until) {
    const last = refusal.error;
    // The cached refusal takes the id through the same normaliser as the first refusal, never raw (rf-4 U2b C2).
    throw new BoatStopRefusedError(redactKey(config, id), last.stopId, last.boatStatus, last.boatError, last.lastGoodSnapshotAt, last.notResentBefore, last.refusals);
  }
  const proof = idleActivity.proof(activityKey(config, id));
  const stopped = await request(config, `/sandboxes/${encodeURIComponent(id)}/stop`, { method: "POST", body: JSON.stringify({}) }, false, { ownStop: true });
  // Boat documents the operation as `stop`; OpenAPI may expose `operation`.
  // https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox.md
  const operation = stopped?.stop ?? stopped?.operation ?? stopped?.sandbox?.stop;
  const stopId = typeof operation?.id === "string" && operation.id.trim() ? operation.id : undefined;
  const until = Date.now() + 120_000;
  let readRecord = stopId !== undefined;
  let lastStatus: string | undefined = typeof operation?.status === "string" ? operation.status : undefined;
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
      stopRefusals.delete(activityKey(config, id));
      idleActivity.confirm(proof); return { providerLeaseId: id, state: "stopped" };
    }
    if (typeof stop?.status === "string") lastStatus = stop.status;
    // Boat's own record of OUR stop: GET /sandboxes/{id}/stops/{stopId}
    // (https://docs.boat.dev/api/reference/sandboxes/get-stop). `failing` means
    // Boat refused it (the save failed); it keeps the box running and retries by
    // itself, so waiting here proves nothing. Return Boat's words at once.
    if (readRecord && stopId !== undefined) {
      let record: any;
      try { record = await request(config, `/sandboxes/${encodeURIComponent(id)}/stops/${encodeURIComponent(stopId)}`); }
      catch (error) {
        // 404: Boat does not know the id; keep observing the sandbox as before.
        if ((error as { status?: unknown })?.status !== 404) throw error;
        readRecord = false;
      }
      const own = record?.stop ?? record?.operation ?? record;
      if (own && typeof own === "object" && own.id === stopId && typeof own.status === "string") {
        lastStatus = own.status;
        if (own.status === "completed") {
          stopRefusals.delete(activityKey(config, id));
          idleActivity.confirm(proof); return { providerLeaseId: id, state: "stopped" };
        }
        if (own.status === "failing" || own.status === "failed") {
          throw refuseStop(config, id, stopId, own.status, own.error, own.snapshotCompletedAt ?? sandbox.snapshotCompletedAt);
        }
        if (own.status !== "pending") throw stopDiagnostic(config, `Boat stop ${stopId} entered ${providerStatus(config, own.status)}`);
      }
    }
    // No record (404): the box's own stop is Boat's word on OUR stop only when its id
    // is the one POST /stop returned; `failing` there is the same refusal (rf-4 U2 F3, J5).
    if (!readRecord && stopId !== undefined && seen?.id === stopId && (seen.status === "failing" || seen.status === "failed")) {
      throw refuseStop(config, id, stopId, seen.status, seen.error, seen.snapshotCompletedAt ?? sandbox.snapshotCompletedAt);
    }
    // A missing id on 202 is not failure: observe the sandbox until its stop
    // appears/completes or it reaches the documented archived state.
    const observedId = typeof stop?.id === "string" && stop.id.trim() ? stop.id : stopId;
    if (observedId && stop?.status && !["pending", "failing", "completed"].includes(stop.status)) {
      throw stopDiagnostic(config, `Boat stop ${observedId} entered ${providerStatus(config, stop.status)}`);
    }
    // Never force a stop or discard unsaved files.
    await delay(1500);
  }
  throw stopDiagnostic(config, `Boat stop ${stopId ?? id} did not complete${lastStatus ? ` (Boat status ${providerStatus(config, lastStatus)})` : ""}`);
}
// Existing SDK ownership envelope, consumed by core's creation inspection/reaper.
function cleanupIdentity(config: Config, id: string, owner: { companyId: string; environmentId: string; runId?: string }, attemptId: string): PluginEnvironmentCreationCleanup {
  return { providerLeaseId: id, observedProviderLeaseId: id, companyId: owner.companyId,
    environmentId: owner.environmentId, runId: owner.runId, attemptId,
    accountFingerprint: createHash("sha256").update(`${apiBase(config)}\n${config.apiKey}`).digest("hex"),
    labels: { "paperclip-acquire": attemptId } };
}
async function acquisitionMatches(config: Config, attemptId: string, owner: { companyId: string; environmentId: string; runId?: string }, deadline?: number): Promise<string[]> {
  // Documented repeated label=key=value and pageInfo.nextCursor; do not scan all accounts.
  // https://docs.boat.dev/api/reference/sandboxes/list-sandboxes.md
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ label: `paperclip-acquire=${attemptId}`, limit: "200" });
    if (cursor) query.set("cursor", cursor);
    // A bounded caller (the create cap) never lets one page run past its end.
    const pageMs = deadline === undefined ? 10_000 : Math.min(10_000, deadline - Date.now());
    if (pageMs <= 0) throw new Error("Boat acquisition lookup reached its deadline");
    const result = await request(config, `/sandboxes?${query}`, { signal: AbortSignal.timeout(pageMs) }, false, deadline === undefined ? {} : { deadline });
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
/** The HTTP status of a definite Boat refusal: a 4xx our own requestError
 * carries that the host does not retry (not 408, 425 or 429). */
function definiteRefusalStatus(error: unknown): number | undefined {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 499
    && ![408, 425, 429].includes(status) ? status : undefined;
}
async function cleanupAcquisition(config: Config, ids: string[], owner: { companyId: string; environmentId: string; runId?: string }, attemptId: string, cause: unknown, acquisitionDiagnostic?: PluginEnvironmentAcquisitionDiagnostic): Promise<void> {
  const failures: unknown[] = []; let firstFailed: string | undefined;
  for (const id of ids) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await stopSandbox(config, id); break; }
      catch (error) {
        // Boat refused the stop: a retry inside its back-off sends nothing, so stop retrying.
        if (attempt === 2 || error instanceof BoatStopRefusedError) { firstFailed ??= id; failures.push(error); break; }
        else await delay(250 * 2 ** attempt);
      }
    }
  }
  if (firstFailed) throw new PluginEnvironmentCreationCleanupError([cause, ...failures],
    `Boat acquire failed and cleanup of ${firstFailed} was not confirmed.`, cleanupIdentity(config, firstFailed, owner, attemptId), acquisitionDiagnostic);
}
function privateEnvDirectory(id: string, roots: string[] = []): string | null {
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return [`/tmp/paperclip-boat-env-${suffix}`, `/home/user/.paperclip-boat-env-${suffix}`]
    .find(path => roots.every(root => path !== root && !path.startsWith(root === "/" ? root : `${root}/`))) ?? null;
}
async function ensurePrivateEnvDirectory(config: Config, id: string, roots: string[] = []): Promise<string> {
  const existing = preparedEnvDirectories.get(id);
  if (existing && roots.every(root => existing !== root && !existing.startsWith(root === "/" ? root : `${root}/`))) return existing;
  const directory = privateEnvDirectory(id, roots);
  if (!directory) throw new Error("Boat env file requires a private path outside the workspace.");
  const qdir = q(directory);
  const command = `umask 077 && /bin/mkdir -p -m 0700 -- ${qdir} && test ! -L ${qdir} && test -d ${qdir} && test "$(/usr/bin/stat -c %u -- ${qdir})" = "$(/usr/bin/id -u)" && test "$(/usr/bin/stat -c %a -- ${qdir})" = 700 || exit 197`;
  // R1: fixed-path mkdir and ownership/existence checks are safe to repeat.
  const result = await runCommand(config, id, command, 30_000, undefined, undefined, { intent: "idempotent_probe" });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("Boat private env directory verification failed");
  preparedEnvDirectories.set(id, directory);
  return directory;
}
async function runCommand(config: Config, id: string, command: string, timeoutMs: number, cwd?: string, signal?: AbortSignal,
  options: Pick<RequestOptions, "intent"> = {}): Promise<PluginEnvironmentExecuteResult> {
  const timeoutSeconds = Math.max(1, Math.min(600, Math.ceil(timeoutMs / 1000)));
  const payload = { command, timeoutSeconds, detached: timeoutMs > 600_000, ...(cwd !== undefined ? { cwd } : {}) };
  // F-04: request() puts each send's attempt nonce at the start of the command
  // text (command-outcome.ts withCommandNonce); a possibly-ran failure throws
  // boat_command_possibly_ran and is never sent again.
  const started = await request(config, `/sandboxes/${encodeURIComponent(id)}/commands`, {
    method: "POST", signal: signal ?? AbortSignal.timeout(timeoutMs > 600_000 ? 30_000 : timeoutSeconds * 1000 + 5_000),
    body: JSON.stringify(payload),
  }, false, { command: payload, ...options });
  if (!started.processId) return {
    exitCode: Number.isInteger(started.exitCode) ? started.exitCode : null,
    timedOut: started.timedOut === true,
    stdout: started.stdout ?? "", stderr: started.stderr ?? "",
  };
  const until = Date.now() + timeoutMs;
  let pollDelayMs = 1_000;
  while (Date.now() < until) {
    const result = await request(config, `/sandboxes/${encodeURIComponent(id)}/commands/${encodeURIComponent(started.processId)}`, { signal });
    if (result.running === false || result.status === "completed" || result.status === "exited") return {
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      timedOut: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
      signal: result.signal ?? null,
    };
    await delay(Math.min(pollDelayMs, Math.max(0, until - Date.now())), undefined, { signal });
    pollDelayMs = Math.min(5_000, pollDelayMs + 1_000);
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
  return { request: (path, init) => request(config, path, init), run: (command, timeout, signal, options) => runCommand(config, lease.providerLeaseId, command, timeout, undefined, signal, options) };
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
  // Inside a stop refusal's back-off with NO SSH state here, retirement has nothing
  // to revoke (retire() is a no-op without state) and its read decides nothing: send
  // no HTTP (rf-4 U2 F3, J18). Any state (a key to revoke) still takes the full path.
  if (!sshCarrier.hasState(lease) && stopRefusalActive(parse(lease.config), lease.providerLeaseId)) return [];
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
    accountFingerprint: createHash("sha256").update(`${apiBase(config)}\n${config.apiKey}`).digest("hex"),
  });
}
async function listBoatSandboxes(config: Config, labels: Array<[string, string]>, signal?: AbortSignal): Promise<any[]> {
  const sandboxes: any[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "200" });
    for (const [key, value] of labels) query.append("label", `${key}=${value}`);
    if (cursor) query.set("cursor", cursor);
    const result = await request(config, `/sandboxes?${query}`, { signal: signal ?? AbortSignal.timeout(2500) }, false, { requireJson: true });
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
type SpareRefill = { id: string; body: string; at: number; sandboxId?: string; refused?: boolean };
type SpareRefills = Record<string, SpareRefill[]>;
const spareRefillWrites = new Map<string, Promise<void>>();
const busySpareRefills = new Set<string>();
/** Serialize the existing plugin-state read/modify/write seam per company.
 * Unknown state is NOT an empty ledger: fail before a create, never mint a
 * replacement key because a state read or write failed. The authentication
 * header is not part of this record (configured body fields are).
 */
async function updateSpareRefills(key: ReadySpareKey, update: (pending: SpareRefill[]) => Promise<void> | void): Promise<void> {
  const state = pluginContext?.state;
  if (!state?.get || !state.set) throw new Error("Boat spare refill requires durable plugin state");
  const scope = { scopeKind: "company" as const, scopeId: key.companyId, namespace: CREATE_EXPIRY_NAMESPACE, stateKey: "pending-refills" };
  const previous = spareRefillWrites.get(key.companyId) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const value = await state.get(scope);
    if (value !== null && value !== undefined && (typeof value !== "object" || Array.isArray(value))) throw new Error("Boat spare refill state is invalid");
    const stored = structuredClone((value ?? {}) as SpareRefills);
    for (const entries of Object.values(stored)) {
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== "string" || typeof entry.body !== "string" || !Number.isFinite(entry.at))) {
        throw new Error("Boat spare refill identity is invalid");
      }
    }
    const poolId = readySparePoolKey(key);
    const pending = stored[poolId] ?? [];
    await update(pending);
    if (pending.length) stored[poolId] = pending;
    else delete stored[poolId];
    await state.set(scope, stored);
  });
  spareRefillWrites.set(key.companyId, write);
  try { await write; }
  finally { if (spareRefillWrites.get(key.companyId) === write) spareRefillWrites.delete(key.companyId); }
}
async function forgetSpareRefill(key: ReadySpareKey, id: string): Promise<void> {
  await updateSpareRefills(key, pending => {
    const index = pending.findIndex(entry => entry.id === id);
    if (index >= 0) pending.splice(index, 1);
  });
}
async function createReadySpare(config: Config, key: ReadySpareKey, ttlSeconds: number, from?: string): Promise<ReadySpare> {
  let identity: SpareRefill | undefined;
  try {
    await updateSpareRefills(key, async pending => {
      // A refused key stays for reconciliation; it must not starve unrelated
      // capacity. Expired identities are resolved/forgotten by inventory first.
      identity = pending.find(entry => !busySpareRefills.has(entry.id) && !entry.refused
        && (Date.now() - entry.at < BOAT_IDEMPOTENCY_KEY_LIFE_MS || entry.sandboxId));
      if (!identity) {
        const id = creationIdentityId();
        const expiry = await creationExpiry(key.companyId, id, ttlSeconds);
        const labels = { ...config.labels, owner: `paperclip:${key.companyId}`, purpose: "spare", expiry,
          environment: key.environmentId, configHash: key.configHash, "paperclip-refill": id };
        identity = { id, body: JSON.stringify(createSandboxBody(config, ttlSeconds, labels, from)), at: Date.now() };
        pending.push(identity);
      }
      busySpareRefills.add(identity.id);
    });
    const refill = identity!;
    // Boat's key expires after 24h: never resend it. An inventory-confirmed
    // sandboxId can still finish warming without sending a create at all.
    if (refill.refused || (!refill.sandboxId && Date.now() - refill.at >= BOAT_IDEMPOTENCY_KEY_LIFE_MS)) throw new Error("Boat spare refill identity requires reconciliation");
    const admit = () => admitSpareCreate(key, refill.id);
    if (!await admit()) throw new Error("Boat spare create not admitted at the current target");
    let sandbox: any;
    if (refill.sandboxId) {
      const found = await request(config, `/sandboxes/${encodeURIComponent(refill.sandboxId)}`, { signal: AbortSignal.timeout(10_000) }, false, { requireJson: true });
      sandbox = found?.sandbox ?? found;
    } else {
      let created: any;
      try {
        created = await request(config, "/sandboxes", {
          method: "POST", signal: AbortSignal.timeout(30_000), headers: { "Idempotency-Key": refill.id }, body: refill.body,
        }, false, { sendAdmission: admit });
      } catch (error) {
        if (boatCreateCode(error) === "idempotency_key_reused") {
          await updateSpareRefills(key, pending => { const entry = pending.find(entry => entry.id === refill.id); if (entry) entry.refused = true; });
          duplexLogger?.warn("Boat spare refill key refused; retained for reconciliation, not retried", { companyId: key.companyId, environmentId: key.environmentId, refillId: refill.id });
        }
        throw error;
      }
      sandbox = created?.sandbox ?? created;
      if (typeof sandbox?.id !== "string" || !sandbox.id) throw new Error("Boat spare create response omitted sandbox.id");
      await updateSpareRefills(key, pending => { const entry = pending.find(entry => entry.id === refill.id); if (entry) entry.sandboxId = sandbox.id; });
    }
    const stopped = dedupedBoxStop(sandbox);
    if (stopped) throw new BoatDedupedBoxStoppedError(sandbox.id, stopped);
    const labels = JSON.parse(refill.body).labels as Record<string, string>;
    idleActivity.resource(activityKey(config, sandbox.id));
    try {
      const ready = await waitReady(config, sandbox.id);
      const setup = config.setupScript === undefined ? ready : await waitSetup(config, sandbox.id);
      const name = `paperclip-spare:ready:${key.configHash}`;
      const updated = await request(config, `/sandboxes/${encodeURIComponent(sandbox.id)}`, {
        method: "PATCH", signal: AbortSignal.timeout(5_000), body: JSON.stringify({ name, ttlSeconds }),
      }, false, { requireJson: true });
      const warmedSandbox = updated?.sandbox ?? updated;
      if (warmedSandbox?.id !== sandbox.id || !["ready", "idle", "running"].includes(warmedSandbox.state)) {
        throw new Error("Boat spare was not running after setup");
      }
      const observation = { ...setup, ...warmedSandbox, id: sandbox.id, name };
      await forgetSpareRefill(key, refill.id);
      return readySpareFromSandbox({ ...observation, labels }, ttlSeconds);
    } catch (error) {
      try {
        await stopSandbox(config, sandbox.id);
        await forgetSpareRefill(key, refill.id);
      } catch { /* Keep the identity until a later inventory confirms its fate. */ }
      throw error;
    }
  } finally {
    if (identity) {
      busySpareRefills.delete(identity.id);
      const poolId = readySparePoolKey(key);
      admittedSpareCreates.get(poolId)?.delete(identity.id);
    }
  }
}
const BOAT_STOP_STATUSES = new Set(["pending", "failing", "completed", "superseded"]);
/**
 * After a claim PATCH, Boat's answer must still be a spare with no stop record
 * (rf-4 U1 F2). If a stop is there, the claim is abandoned, not forced: no
 * resume, no delete, no second stop. The box keeps its claim name, so no claim
 * or reconcile picks it up again, and Boat's own stop or TTL archives it. The
 * caller's run gets a cold box. Logged fields are closed: IDs and a known status.
 */
function abandonSickClaim(spare: ReadySpare, observed: Record<string, unknown>, step: "patch" | "verify"): boolean {
  const stop = observed?.stop as { status?: unknown } | null | undefined;
  if (stop === undefined || stop === null) return false;
  const status = typeof stop.status === "string" && BOAT_STOP_STATUSES.has(stop.status) ? stop.status : "unknown";
  duplexLogger?.warn("Boat ready spare claim abandoned: a stop appeared after the claim; the run gets a cold box",
    { companyId: spare.key.companyId, environmentId: spare.key.environmentId, spareId: spare.id, step, stopStatus: status });
  return true;
}
function createReadySpareOperations(config: Config, key: ReadySpareKey, ttlSeconds: number, from?: string): ReadySpareOperations {
  const scoped = [["owner", `paperclip:${key.companyId}`], ["environment", key.environmentId], ["purpose", "spare"]] as Array<[string, string]>;
  return {
    async list() {
      const sandboxes = await listBoatSandboxes(config, scoped, AbortSignal.timeout(2500));
      const owned = sandboxes.filter(sandbox => sandbox.labels.owner === `paperclip:${key.companyId}` && sandbox.labels.environment === key.environmentId && sandbox.labels.purpose === "spare");
      // A restart can land after the ready PATCH but before its state receipt.
      // Durable inventory then settles that refill, even if a run claimed it.
      const settled = new Set<string>(owned.filter(sandbox => sandbox.labels.configHash === key.configHash
        && (sandbox.name === `paperclip-spare:ready:${key.configHash}` || sandbox.name?.startsWith("paperclip-claim:")
          || ["archived", "stopped", "error", "cancelled"].includes(sandbox.state)))
        .map(sandbox => sandbox.labels["paperclip-refill"]).filter((id): id is string => typeof id === "string"));
      const resolving = new Set<string>();
      // OFF must see unfinished paid boxes too, even though positive-target
      // reconciliation leaves them to their durable refill's warm continuation.
      const pool = knownSparePools.get(readySparePoolKey(key));
      const retainPending = !pool || (!pool.retired && pool.baseDesired > 0);
      await updateSpareRefills(key, pending => {
        for (let i = pending.length - 1; i >= 0; i--) {
          const entry = pending[i];
          if (settled.has(entry.id) && !busySpareRefills.has(entry.id)) { pending.splice(i, 1); continue; }
          const made = owned.find(sandbox => sandbox.labels.configHash === key.configHash && sandbox.labels["paperclip-refill"] === entry.id);
          if (!made && !busySpareRefills.has(entry.id) && Date.now() - entry.at >= BOAT_IDEMPOTENCY_KEY_LIFE_MS) {
            pending.splice(i, 1); continue; // Complete scoped inventory: expired key with no labelled box.
          }
          if (made && !settled.has(entry.id) && !dedupedBoxStop(made)) {
            entry.sandboxId = made.id;
            if (retainPending && !entry.refused) resolving.add(made.id);
          }
        }
      });
      // Pending creates are not stale inventory to stop. The durable refill
      // resolves/adopts and warms that exact id instead of allocating another.
      return owned.filter(sandbox => !resolving.has(sandbox.id)).map(sandbox => readySpareFromSandbox(sandbox, ttlSeconds));
    },
    async get(spare, signal) {
      const result = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "GET", cache: "no-store", signal: signal ? AbortSignal.any([AbortSignal.timeout(10_000), signal]) : AbortSignal.timeout(10_000),
      }, false, { requireJson: true });
      const sandbox = result?.sandbox ?? result;
      if (sandbox?.id !== spare.id || !sandbox.labels) return undefined;
      return readySpareFromSandbox(sandbox, ttlSeconds);
    },
    create: () => createReadySpare(config, key, ttlSeconds, from),
    // No pre-claim guest commands: starting Pi can write another run's home.
    // Run preparation (including the sentinel) belongs to finishAcquisition.
    async claim(spare, name, claimTtlSeconds) {
      const result = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "PATCH", signal: AbortSignal.timeout(2500), body: JSON.stringify({ name, ttlSeconds: claimTtlSeconds }),
      }, false, { requireJson: true });
      const patched = result?.sandbox ?? result;
      if (patched?.id !== spare.id || !["ready", "idle", "running"].includes(patched.state) || (patched.name && patched.name !== name)) return false;
      // rf-4 U1 F2: a stop Boat recorded after the clean pre-claim GET shows in
      // the PATCH answer or the verification GET. Either one abandons the claim.
      if (abandonSickClaim(spare, patched, "patch") || patched.hydrated !== true) return false;
      const observed = await request(config, `/sandboxes/${encodeURIComponent(spare.id)}`, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000),
      }, false, { requireJson: true });
      const sandbox = observed?.sandbox ?? observed;
      if (sandbox?.id !== spare.id || !["ready", "idle", "running"].includes(sandbox.state) || sandbox.name !== name) return false;
      if (abandonSickClaim(spare, sandbox, "verify") || sandbox.hydrated !== true) return false;
      spare.name = name;
      spare.state = sandbox.state;
      spare.expiresAt = parseDeadline(sandbox.archiveAfter) ?? parseDeadline(sandbox.expiresAt) ?? new Date(Date.now() + claimTtlSeconds * 1000).toISOString();
      spare.ttlSeconds = claimTtlSeconds;
      spare.providerObservation = { ...(spare.providerObservation ?? {}), ...sandbox, id: spare.id, name };
      return true;
    },
    async refresh(spare, refreshTtlSeconds) {
      // rf-4 U1B row H: a TTL renewal spends like a create; the pool's current setting gates it.
      if (!await admitSpareCreate(key)) throw new Error("Boat spare TTL not renewed: spares are not on for this pool");
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
    desired: () => freshSpareDesired(key),
    settingMark: () => spareSettingEpoch(key.companyId, key.environmentId),
    admitCreate: () => admitSpareCreate(key),
    redact: text => redactProviderText(config, text),
    async allowCreate() {
      // Every spare-labelled box created in the last hour, claimed or not, in
      // any state: labels are immutable, so a claimed box still says spare.
      // The keeper subtracts this worker's proofs of use (#20869). The run
      // boxes keep the all-create ceiling's run count across restarts.
      const createdAt = await listHourlyCreates(config, key.companyId);
      return { recentSpareCreates: createdAt.spare.length, createdAt };
    },
  };
}
/**
 * Boat's durable record of this company's creates in the last hour: the
 * creation times of its purpose=spare and purpose=run boxes, in any state and
 * any environment (the ceiling is per company). Unknown is not a count: an
 * incomplete record throws.
 */
async function listHourlyCreates(config: Config, companyId: string): Promise<{ spare: number[]; run: Array<{ createdAt: number; attempt?: string }> }> {
  const owner = `paperclip:${companyId}`;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const [spare, run] = await Promise.all((["spare", "run"] as const).map(async purpose => {
    const inventory = await listBoatSandboxes(config, [["owner", owner], ["purpose", purpose]]);
    const recent: Array<{ createdAt: number; attempt?: string }> = [];
    for (const sandbox of inventory) {
      if (sandbox.labels.owner !== owner || sandbox.labels.purpose !== purpose) throw new Error(`Boat hourly ${purpose} inventory returned foreign ownership`);
      const createdAt = Date.parse(sandbox.createdAt);
      if (!Number.isFinite(createdAt)) throw new Error(`Boat hourly ${purpose} inventory omitted createdAt`);
      const attempt = sandbox.labels["paperclip-acquire"];
      if (createdAt >= cutoff) recent.push({ createdAt, ...(typeof attempt === "string" && attempt ? { attempt } : {}) });
    }
    return recent;
  }));
  return { spare: spare.map(entry => entry.createdAt), run };
}
/** How long a company's observed Boat create inventory serves run admissions before it is read again. */
const RUN_CREATE_LEDGER_REFRESH_MS = 60_000;
const runCreateLedgerReads = new Map<string, { at: number; work?: Promise<void> }>();
/**
 * After a run create is admitted, keep the company's all-create count anchored
 * to Boat's durable inventory (judge F1): the first run after a worker start,
 * and at most once a minute after that, reads it in the background. A run never
 * waits on it and is never refused (ruling A). When the read lands, a run that
 * the stale count admitted under the ceiling is reported over it (kind=run).
 * An unreadable inventory leaves this worker's count; the next minute retries.
 */
function refreshRunCreateLedger(config: Config, companyId: string, environmentId: string): void {
  const last = runCreateLedgerReads.get(companyId);
  if (last?.work || shuttingDown) return;
  const observedAt = readySpares.providerCreatesObservedAt(companyId);
  if (Date.now() - Math.max(last?.at ?? Number.NEGATIVE_INFINITY, observedAt ?? Number.NEGATIVE_INFINITY) < RUN_CREATE_LEDGER_REFRESH_MS) return;
  const startedAt = Date.now();
  const begun = readySpares.createLedgerMark();
  const work: Promise<void> = listHourlyCreates(config, companyId)
    .then(createdAt => {
      if (shuttingDown) return;
      readySpares.observeProviderCreates(companyId, createdAt, begun);
      readySpares.recheckRunCeiling(companyId, environmentId);
    }, () => { duplexLogger?.warn("Boat hourly create inventory unreadable; counting this worker's creates only", { companyId }); })
    .finally(() => { if (runCreateLedgerReads.get(companyId)?.work === work) runCreateLedgerReads.set(companyId, { at: startedAt }); });
  runCreateLedgerReads.set(companyId, { at: last?.at ?? Number.NEGATIVE_INFINITY, work });
}
/** One best-effort pass of the #20912 sweep; never throws. */
async function sweepSyncTemps(logger: PluginContext["logger"] | undefined): Promise<void> {
  try {
    const swept = await sweepStaleSyncTemps();
    if (swept.removed) logger?.info(`[boat] removed stale paperclip-boat-sync temp dirs removed=${swept.removed} kept=${swept.kept}`,
      { ...swept, maxAgeMs: SYNC_TEMP_MAX_AGE_MS });
  } catch { /* Neither startup nor the timer fails on the sweep. */ }
}
function clearSpareRefreshTimerIfIdle(): void {
  if ([...knownSparePools.values()].some(pool => pool.desired > 0) || heldStopDebt()) return;
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
    // Remember the environment's effective config while OFF. onConfigChanged
    // has only company policy (no environment credentials); without this entry
    // first fill waits until a later acquire teaches the pool, not 15 s.
    const poolId = readySparePoolKey(key);
    if (!knownSparePools.has(poolId)) {
      knownSparePools.set(poolId, { key, ttlSeconds, desired: 0, ...policy, baseDesired: 0, idleMinutes, operations, idleStopped: true });
      // A restarted worker can hold unfinished inventory from its predecessor.
      // Its first OFF acquire supplies the credentials needed to retire it.
      void readySpares.reconcile(key, 0, operations).catch(() => undefined);
    }
    bumpSpareSettingEpoch(key.companyId, key.environmentId);
    for (const pool of knownSparePools.values()) {
      if (pool.key.companyId !== key.companyId || pool.key.environmentId !== key.environmentId) continue;
      // Off stays off: wakes and maintenance recompute desired from baseDesired.
      pool.baseDesired = 0;
      if (pool.desired <= 0) continue;
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
        || oldPool.key.configHash === key.configHash) continue;
    // A retired config's pool is off for good (rf-4 U1B row C): wakes,
    // maintenance and company setting edits never re-target it.
    oldPool.retired = true;
    oldPool.baseDesired = 0;
    if (oldPool.desired === 0) continue;
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
    if (pool.key.companyId !== companyId || pool.retired || pool.baseDesired <= 0) continue;
    pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
    pool.idleStopped = false;
    // Activity is not a replacement request. An exhausted budget has no spare
    // work to wake; let the acquisition's normal path account for the refusal
    // after admitting its ordinary run (run creates are never blocked).
    if (readySpares.createCounts(companyId).allCreates >= readySpares.createCeiling(companyId)) continue;
    work.push(readySpares.reconcile(pool.key, pool.desired, pool.operations, true).catch(error => {
      duplexLogger?.warn("Boat ready spare wake reconciliation failed", { companyId, environmentId: pool.key.environmentId });
      throw error;
    }));
  }
  await Promise.all(work);
}
async function maintainReadySpares(reconcile = false): Promise<void> {
  if (shuttingDown) return;
  // rf-4 U1c C2: owed stops first, whatever the pools' settings (the last pool OFF included).
  await serviceOwedSpareStops();
  if (![...knownSparePools.values()].some(pool => pool.desired > 0)) { clearSpareRefreshTimerIfIdle(); return; }
  if (spareMaintenanceWork) return spareMaintenanceWork;
  const work = (async () => {
    const activeByPool = new Map<string, boolean>();
    for (const [poolId, pool] of knownSparePools) {
      if (shuttingDown) return;
      // A durable OFF need not arrive as a config event. Apply it before this
      // tick's renewals and retirement, not only before the next create POST.
      if (!pool.retired && pool.baseDesired > 0) {
        const count = await currentSpareCount(pool.key);
        if (count !== undefined) {
          pool.baseDesired = count;
          pool.desired = readySpares.demandTarget(pool.key, count, pool.spareMax, pool.demandWindowMinutes);
        }
      }
      activeByPool.set(poolId, await companySpareIsActive(pool.key.companyId, pool.idleMinutes));
    }
    const refreshOperations = (key: ReadySpareKey) => {
      const poolId = readySparePoolKey(key);
      const pool = knownSparePools.get(poolId);
      // rf-4 U1B row H: renewal is per pool, only while that pool is on.
      if (!pool || pool.retired || pool.baseDesired <= 0 || pool.desired <= 0) return undefined;
      return activeByPool.get(poolId) ? pool.operations : undefined;
    };
    if (reconcile) await readySpares.refreshDue(READY_SPARE_TTL_SECONDS, refreshOperations);
    else await readySpares.refreshDueTimer(READY_SPARE_TTL_SECONDS, refreshOperations);
    for (const [poolId, pool] of knownSparePools) {
      if (shuttingDown) return;
      if (pool.retired) continue; // Its retire passes ran when it was replaced.
      pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
      const active = activeByPool.get(poolId) === true;
      if (!reconcile) {
        // The unscoped timer can use Boat's inventory/name token, but must not
        // query the claim store or refill. Retire only listed ready spares.
        await readySpares.reconcileTimer(pool.key, active ? pool.desired : 0, pool.operations);
        pool.idleStopped = !active;
        continue;
      }
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
  finally {
    if (spareMaintenanceWork === work) spareMaintenanceWork = undefined;
    clearSpareRefreshTimerIfIdle();
  }
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
  budget?: AcquisitionBudget,
): Promise<PluginEnvironmentLease> {
  // Every acquisition handoff (including a claimed spare) may carry stale guest state.
  preparedEnvDirectories.delete(id);
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
  // rf-4 U3b C1: under an acquisition budget every handoff call (a sentinel or
  // guardian command, a PUT /files) gets only the time that remains, so a call
  // in flight at the budget is aborted there, and no call is sent after it
  // (the request deadline and the step's own check before every send).
  // Daytona: each phase gets `deadline - Date.now()` (daytona plugin.ts:3075,
  // :3089) and is asserted between phases (:3061-3092).
  const io = (phase: string) => budget ? {
    request: (path: string, init: RequestInit = {}) => request(config, path, { ...init,
      signal: init.signal ? AbortSignal.any([init.signal, withinBudget(budget.deadline, BOAT_CALL_BUDGET_MS)]) : withinBudget(budget.deadline, BOAT_CALL_BUDGET_MS) }, false,
      { deadline: budget.deadline, sendGuard: () => budget.enter(phase) }),
    run: (command: string, timeout: number, options?: Pick<RequestOptions, "intent">) => runCommand(config, id, command, timeout, undefined,
      withinBudget(budget.deadline, timeout > 600_000 ? BOAT_CALL_BUDGET_MS : Math.max(1, Math.min(600, Math.ceil(timeout / 1000))) * 1000 + 5_000), options),
  } : {
    request: (path: string, init?: RequestInit) => request(config, path, init),
    run: (command: string, timeout: number, options?: Pick<RequestOptions, "intent">) => runCommand(config, id, command, timeout, undefined, undefined, options),
  };
  budget?.enter("sentinel");
  const sentinelIo = io("sentinel");
  const workspaceSentinel = await writeWorkspaceSentinel(params, config, id, remoteCwd, {
    request: (path, init) => sentinelIo.request(path, init),
    // R1: this helper's only command creates the fixed sentinel directory.
    run: (command, timeout) => sentinelIo.run(command, timeout, { intent: "idempotent_probe" }),
  });
  budget?.enter("guardian");
  const guardianIo = io("guardian");
  const guardianPreflight = await stageGuardian(params.config, id, {
    request: (path, init) => guardianIo.request(path, init), run: (command, timeout, options) => guardianIo.run(command, timeout, options),
  });
  budget?.enter("duplex");
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

// Boat extend SETS remaining time, it does not add time. Reuse the same
// documented PATCH for warm handoffs and the concrete obligation of a held RUN.
async function patchLeaseTtl(config: Config, id: string, headers: HeadersInit | undefined, options: RequestOptions = {}, signal?: AbortSignal): Promise<any> {
  const path = `/sandboxes/${encodeURIComponent(id)}`;
  const refreshed = await request(config, path, { method: "PATCH", headers, signal,
    body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(config) }) }, options.strictMissing === true, { ...options, requireJson: true });
  if (refreshed === null && options.strictMissing) return null;
  const candidate = refreshed?.sandbox ?? refreshed;
  if (candidate?.id !== id) throw requestError(config, "PATCH", path, 200, "parse_error");
  return candidate;
}
type RunLeaseTtlRefresh = { timer?: ReturnType<typeof setTimeout>; controller: AbortController; work?: Promise<void> };
const runLeaseTtlRefreshes = new Map<string, RunLeaseTtlRefresh>();
// Preserve the original deadline across duplicate same-RUN warm handoffs. A new
// runId may get a new grant, but repeated acquire calls never add a box timer.
const runLeaseTtlCaps = new Map<string, { runId: string; renewUntil: number }>();
const runLeaseTtlWork = new Set<Promise<void>>();
const renewalEndedStates = new Set(["archiving", "archived", "stopping", "stopped", "cancelled"]);
function cancelRunLeaseTtlRefresh(key: string): RunLeaseTtlRefresh | undefined {
  const held = runLeaseTtlRefreshes.get(key);
  if (held) { runLeaseTtlRefreshes.delete(key); clearTimeout(held.timer); held.controller.abort(); }
  return held;
}
async function stopRunLeaseTtlRefresh(config: Config, id: string): Promise<void> {
  await cancelRunLeaseTtlRefresh(activityKey(config, id))?.work;
}
function runLeaseRenewUntil(config: Config, id: string, runId: string, acquiredAt: number): number {
  const key = activityKey(config, id), previous = runLeaseTtlCaps.get(key);
  if (previous?.runId === runId) return previous.renewUntil;
  const renewUntil = acquiredAt + config.runLeaseRenewCapSeconds * 1000;
  runLeaseTtlCaps.set(key, { runId, renewUntil });
  return renewUntil;
}
function startRunLeaseTtlRefresh(params: PluginEnvironmentAcquireLeaseParams | PluginEnvironmentResumeLeaseParams, config: Config, lease: PluginEnvironmentLease, acquiredAt: number): void {
  const id = lease.providerLeaseId;
  // runId is the host's authority: a legacy warm/idle handoff gets only its
  // existing one-shot refresh. Never turn a retained idle box into a live RUN.
  if (shuttingDown || !id || !params.runId || ("purpose" in params && params.purpose === "login")) return;
  const key = activityKey(config, id);
  if (runLeaseTtlRefreshes.has(key)) return;
  const renewUntil = runLeaseRenewUntil(config, id, params.runId, acquiredAt);
  if (Date.now() >= renewUntil) return;
  const generation = boxLifecycle(key);
  const metadata = lease.metadata;
  const personal = (metadata?.boatOwner as { kind?: unknown } | undefined)?.kind === "personal";
  const org = personal ? undefined : metadata?.boatOrgId;
  const headers = typeof org === "string" && org.trim() ? { "X-Boat-Org": org } : undefined;
  const controller = new AbortController();
  const held: RunLeaseTtlRefresh = { controller };
  const current = () => !shuttingDown && runLeaseTtlRefreshes.get(key) === held;
  const sendGuard = () => {
    assertBoatActivityAdmission();
    if (!current() || Date.now() >= renewUntil || boxLifecycle(key) !== generation) throw new Error("Boat RUN lease ended");
  };
  const cadence = Math.max(60_000, effectiveTtlSeconds(config) * 1000 / 3);
  // One deadline timer per account/box, including the hard cap between ticks.
  // Arm BEFORE starting I/O, never from a late response. The cap cancels even a
  // hung request; the existing F-01 admission/lifecycle fences guard every send.
  const arm = () => {
    held.timer = setTimeout(tick, Math.min(cadence, Math.max(0, renewUntil - Date.now())));
    held.timer.unref?.();
  };
  const tick = () => {
    if (!current()) return;
    if (Date.now() >= renewUntil || boxLifecycle(key) !== generation) { cancelRunLeaseTtlRefresh(key); return; }
    arm();
    if (held.work) return;
    const work = idleActivity.track(() => withBoatLeaseActivity(leaseActivityKey(params, id), async () => {
      let status: "ok" | "unconfirmed" | "failed" | "gone" = "failed";
      let category: RequestErrorCategory | "deadline_mismatch" | "box_gone" | null = null;
      try {
        sendGuard();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const options = { maxSends: 1, strictMissing: true, closedLogs: true, sendGuard };
        // PATCH only extends; it cannot recover an archiving/stopped resource.
        const found = await request(config, `/sandboxes/${encodeURIComponent(id)}`, { method: "GET", headers, cache: "no-store", signal }, true, { ...options, requireJson: true });
        sendGuard();
        const observed = found?.sandbox ?? found;
        if (observed === null || renewalEndedStates.has(observed?.state)) {
          status = "gone"; category = "box_gone"; cancelRunLeaseTtlRefresh(key);
        } else {
          assertSandboxId(observed, id);
          const requestedAt = Date.now();
          const sandbox = await patchLeaseTtl(config, id, headers, options, signal);
          sendGuard(); // A late response authorizes neither a receipt nor a new timer.
          if (sandbox === null || renewalEndedStates.has(sandbox.state)) {
            status = "gone"; category = "box_gone"; cancelRunLeaseTtlRefresh(key);
          } else {
            const deadline = parseDeadline(sandbox.archiveAfter);
            status = deadline !== null && Math.abs(Date.parse(deadline) - (requestedAt + effectiveTtlSeconds(config) * 1000)) <= 120_000 ? "ok" : "unconfirmed";
            category = status === "ok" ? null : "deadline_mismatch";
          }
        }
      } catch (error) {
        if (!current()) return;
        const failure = error as ReturnType<typeof requestError> & Boat409Fields;
        if (renewalEndedStates.has(failure.boatState ?? "")) {
          status = "gone"; category = "box_gone"; cancelRunLeaseTtlRefresh(key);
        } else category = failure.category ?? "request_error";
      }
      const details = { providerLeaseId: redactKey(config, id), status, category };
      if (status === "ok") duplexLogger?.info("Boat run lease TTL refresh", details);
      else duplexLogger?.warn("Boat run lease TTL refresh", details);
    })).catch(() => { if (current()) cancelRunLeaseTtlRefresh(key); }).finally(() => { held.work = undefined; runLeaseTtlWork.delete(work); });
    held.work = work; runLeaseTtlWork.add(work);
  };
  runLeaseTtlRefreshes.set(key, held); arm();
}

const plugin = definePlugin(trackBoatHooks(gateBoatHooks({
  async setup(ctx) {
    shuttingDown = false;
    apiBaseUrlWarned = false;
    boatRateLimitPauseUntil = 0;
    preparedEnvDirectories.clear();
    readySpares.start();
    readySpares.setRefusalListener(reportCreateCapRefusal);
    // backoff.error was stored through redactProviderText (operations.redact, rf-4 U1 F7).
    readySpares.setStopBackoffListener(backoff => {
      try { duplexLogger?.warn("Boat ready spare pool backing off after stop failures; no new spare until the back-off ends", { ...backoff }); } catch { /* Logging never changes admission. */ }
    });
    readySpares.setStopRecordListener(record => {
      const work = recordSpareStop(record);
      trackOwedStopWork(work);
      return work;
    });
    knownSparePools.clear();
    companyOwedStops.clear(); owedStopRetryAt.clear(); owedStopKeys.clear(); spareSettingReadFailures.clear();
    claimedSpareLeases.clear();
    runCreateLedgerReads.clear();
    runLeaseTtlCaps.clear();
    createExpiries.clear();
    busySpareRefills.clear(); admittedSpareCreates.clear();
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
    if (syncTempSweepTimer) clearInterval(syncTempSweepTimer);
    syncTempSweepTimer = undefined;
    // A worker killed mid-transfer left its paperclip-boat-sync-*/transfer.tar (#20912).
    await sweepSyncTemps(ctx.logger);
    syncTempSweepTimer = setInterval(() => {
      if (shuttingDown || syncTempSweepWork) return;
      syncTempSweepWork = sweepSyncTemps(duplexLogger).finally(() => { syncTempSweepWork = undefined; });
    }, SYNC_TEMP_SWEEP_INTERVAL_MS);
    syncTempSweepTimer.unref?.();
    ctx.logger.info("Boat sandbox provider ready; guardian requires per-lease SSH preflight");
  },
  multiCompanyConfig: true,
  async onConfigChanged(newConfig, context) {
    // Company/global plugin config is NOT the environment's effective config.
    // Company spare policy is instance config; environment lease config remains
    // the source for Boat credentials and create-shaping fields.
    const companyId = context?.companyId;
    if (!companyId) return;
    bumpSpareSettingEpoch(companyId);
    subscribeCompanyActivity(companyId);
    readySpares.setCreateCeiling(companyId, readyCreateCeilingPerHour(newConfig));
    const configuredCount = readySpareCount(newConfig);
    const environments = readySpareEnvironmentIds(newConfig);
    const spareMax = readySpareMax(newConfig);
    const demandWindowMinutes = readySpareDemandWindowMinutes(newConfig);
    const idleMinutes = readySpareIdleMinutes(newConfig);
    const active = await companySpareIsActive(companyId, idleMinutes);
    if (configuredCount > 0) for (const environmentId of environments) {
      if (![...knownSparePools.values()].some(pool => !pool.retired && pool.key.companyId === companyId && pool.key.environmentId === environmentId)) {
        duplexLogger?.warn("Boat first spare fill awaits an environment acquisition: config changes carry policy, not environment credentials", { companyId, environmentId });
      }
    }
    for (const pool of knownSparePools.values()) {
      if (pool.key.companyId !== companyId || pool.retired) continue;
      pool.baseDesired = environments.includes(pool.key.environmentId) ? configuredCount : 0;
      pool.spareMax = spareMax;
      pool.demandWindowMinutes = demandWindowMinutes;
      pool.desired = readySpares.demandTarget(pool.key, pool.baseDesired, pool.spareMax, pool.demandWindowMinutes);
      pool.idleMinutes = idleMinutes;
      if (pool.desired > 0) ensureSpareRefreshTimer();
      try {
        // An already-exhausted company budget cannot fund an eager first fill.
        // Still retire/trim inventory; the ordinary acquire keeps the existing
        // cap-refusal accounting when it next requests a replacement.
        if (active && pool.desired > 0 && readySpares.createCounts(companyId).allCreates >= readySpares.createCeiling(companyId)) {
          await readySpares.reconcileTimer(pool.key, pool.desired, pool.operations);
        } else await readySpares.reconcile(pool.key, active ? pool.desired : 0, pool.operations);
        pool.idleStopped = !active;
      } catch {
        duplexLogger?.warn("Boat ready spare config reconciliation failed", { companyId, environmentId: pool.key.environmentId });
      }
    }
    clearSpareRefreshTimerIfIdle();
  },
  onDuplexChannelOpen: params => {
    recordSpareUse(params.companyId, params.providerLeaseId, "duplex_open");
    return duplexChannels.open(params);
  },
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
      // While a spare is refused or a run is over ceiling, health names it (create_capped). The churn
      // cap only delays spares (runs still create cold), so it stays ok; the
      // absolute ceiling refuses run creates too, so it reports degraded.
      const caps = createCapHealth();
      return { status: caps.ceilingHeld ? "degraded" : "ok", message: `${status}; acquire outcomes spare=${totals.spare} cold=${totals.cold}${caps.message}`, details: caps.details };
    } catch {
      const totals = acquireOutcomeTotals();
      const caps = createCapHealth();
      return { status: "error", message: `Boat SSH guardian status probe failed; acquire outcomes spare=${totals.spare} cold=${totals.cold}${caps.message}`, details: caps.details };
    }
  },
  async onShutdown() {
    shuttingDown = true;
    for (const key of runLeaseTtlRefreshes.keys()) cancelRunLeaseTtlRefresh(key);
    await Promise.allSettled([...runLeaseTtlWork]);
    readySpares.stop();
    for (const unsubscribe of activityUnsubscribers) unsubscribe();
    activityUnsubscribers = [];
    activitySubscriptionCompanies.clear();
    if (spareRefreshTimer) clearInterval(spareRefreshTimer);
    spareRefreshTimer = undefined;
    if (syncTempSweepTimer) clearInterval(syncTempSweepTimer);
    syncTempSweepTimer = undefined;
    try {
      try {
        await Promise.allSettled([...inFlightAcquisitions]);
        await Promise.allSettled([...runCreateLedgerReads.values()].map(read => read.work));
        if (syncTempSweepWork) await syncTempSweepWork;
        if (spareMaintenanceWork) await spareMaintenanceWork.catch(() => undefined);
        await readySpares.drain();
        await Promise.allSettled([...owedStopWork]);
        await Promise.all([...companySpareActivityWrites.values(), ...companyAcquireOutcomeWrites.values(), ...companyOwedStopWrites.values()].map(write => write.catch(() => undefined)));
      } finally {
        try { await duplexChannels.shutdown(); } finally { await sshCarrier.close(); }
      }
    } finally {
      readySpares.reset();
      knownSparePools.clear();
      companyOwedStops.clear(); owedStopRetryAt.clear(); owedStopKeys.clear();
      claimedSpareLeases.clear();
      runCreateLedgerReads.clear();
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
    try { apiBase(params.config); }
    catch (error) { return { ok: false, errors: [(error as Error).message] }; }
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
    if (params.config.runLeaseRenewCapSeconds !== undefined && !validRunLeaseRenewCap(params.config.runLeaseRenewCapSeconds)) errors.push("runLeaseRenewCapSeconds must be an integer from 1 through 2592000.");
    if (Object.keys(c.labels).length > 15 || Object.entries(c.labels).some(([k,v]) => !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/.test(k) || typeof v !== "string" || new TextEncoder().encode(v).length > 256)) errors.push("labels must have valid Boat keys, values <=256 bytes, and at most 15 entries (ownership labels are added).");
    // Storage must not materialize read-time defaults: even an unrelated save
    // would change the lease fingerprint and rotate retained conversations.
    return errors.length ? { ok: false, errors } : { ok: true, normalizedConfig: {
      ...params.config,
      ...Object.fromEntries(Object.entries(c).filter(([key]) => Object.hasOwn(params.config, key))),
      ...(params.config.duplexCarrier === undefined ? {} : { duplexCarrier: params.config.duplexCarrier }),
    } };
  },
  async onEnvironmentProbe(params: PluginEnvironmentProbeParams): Promise<PluginEnvironmentProbeResult> {
    try { const result = await request(parse(params.config), "/limits"); return { ok: true, summary: "Boat API reachable.", metadata: { provider: "boat", limits: result } }; }
    catch (e) {
      // A returned diagnostic: the one redactor even though request() errors are already closed (rf-4 U2b inventory).
      const apiKey = typeof params.config?.apiKey === "string" ? params.config.apiKey.trim() : "";
      return { ok: false, summary: "Boat API probe failed.", metadata: { provider: "boat", error: redactProviderText({ apiKey }, e instanceof Error ? e.message : String(e)) } };
    }
  },
  onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
    const acquiredAt = Date.now();
    // review-fleet-4 C1: one line per acquisition, from this hook's every exit.
    const phases = acquirePhaseLine(params, acquiredAt);
    if (shuttingDown) {
      phases.emit(false);
      return Promise.reject(new Error("Boat provider is shutting down"));
    }
    let outcomeRecorded = false;
    const recordOutcomeOnce = async (outcome: "spare" | "cold", reason?: AcquireOutcomeReason) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      await recordAcquireOutcome(params.companyId, params.environmentId, outcome, reason);
    };
    const acquire = async (): Promise<PluginEnvironmentLease> => {
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
    const attemptId = creationIdentityId(params.creationOperationId);
    const createLabels = (expiry: string) => ({ ...c.labels, owner: `paperclip:${params.companyId}`, purpose: params.purpose ?? "run", expiry, environment: params.environmentId, run: params.runId, ...(params.creationOperationId ? { creation: params.creationOperationId } : {}), "paperclip-acquire": attemptId });
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
    const settingEpoch = spareSettingEpoch(params.companyId, params.environmentId);
    if (pluginContext?.config && typeof pluginContext.config.get === "function") {
      try {
        const companyConfig = await pluginContext.config.get(params.companyId);
        const environments = readySpareEnvironmentIds(companyConfig);
        listedEnvironment = environments.includes(params.environmentId);
        baseSpares = listedEnvironment ? readySpareCount(companyConfig) : 0;
        spareMax = readySpareMax(companyConfig);
        demandWindowMinutes = readySpareDemandWindowMinutes(companyConfig);
        spareIdleMinutes = readySpareIdleMinutes(companyConfig);
        readySpares.setCreateCeiling(params.companyId, readyCreateCeilingPerHour(companyConfig));
        hasSpareSetting = true;
      } catch { duplexLogger?.warn("Boat ready spare setting lookup failed", { companyId: params.companyId }); }
    }
    const spareOperations = hasSpareSetting ? createReadySpareOperations(c, spareKey, ttl, from) : undefined;
    // rf-4 U1 F5 / U1B row D: a previous worker's hold and owed stops, on or off.
    if (hasSpareSetting) {
      try { await resumeOwedSpareStops(c, params.companyId, params.environmentId); }
      catch { duplexLogger?.warn("Boat spare stop record resume failed", { companyId: params.companyId, environmentId: params.environmentId }); }
    }
    const policy = { baseDesired: baseSpares, spareMax, demandWindowMinutes };
    /** Queue spares from this acquire's setting read, unless 'off' or a newer setting landed since. */
    const queueSpares = (desired: number, operations: ReadySpareOperations) => {
      if (spareSettingEpoch(params.companyId, params.environmentId) === settingEpoch) {
        queueSpareReconciliation(spareKey, desired, ttl, operations, spareIdleMinutes, policy);
        return;
      }
      // rf-4 U1B row B: the newer setting's reader re-targets only pools it
      // knows. If this pool is unknown, re-read the current setting and register
      // it when spares are still on; off (or an unreadable setting) queues nothing.
      if (knownSparePools.has(readySparePoolKey(spareKey))) return;
      void (async () => {
        for (let attempt = 0; attempt < 3 && !shuttingDown; attempt++) {
          const epoch = spareSettingEpoch(params.companyId, params.environmentId);
          let companyConfig: Record<string, unknown>;
          try { companyConfig = await pluginContext!.config.get(params.companyId); } catch { return; }
          if (shuttingDown || knownSparePools.has(readySparePoolKey(spareKey))) return;
          if (spareSettingEpoch(params.companyId, params.environmentId) !== epoch) continue;
          if (!readySpareEnvironmentIds(companyConfig).includes(params.environmentId)) return;
          const count = readySpareCount(companyConfig);
          if (count <= 0) return;
          const freshPolicy = { baseDesired: count, spareMax: readySpareMax(companyConfig), demandWindowMinutes: readySpareDemandWindowMinutes(companyConfig) };
          queueSpareReconciliation(spareKey, readySpares.demandTarget(spareKey, count, freshPolicy.spareMax, freshPolicy.demandWindowMinutes), ttl, operations,
            readySpareIdleMinutes(companyConfig), freshPolicy);
          return;
        }
      })().catch(() => undefined);
    };
    const createOrdinaryLease = async (): Promise<PluginEnvironmentLease> => {
      let id: string | undefined;
      if (shuttingDown) throw new Error("Boat provider is shutting down");
      readySpares.admitRunCreate(params.companyId, params.environmentId, attemptId);
      // Only companies with a spare setting do the run-path read. A spares-less company's
      // in-plugin create event/health can undercount runs after a worker restart; that is
      // accepted (gold) because the R1 boat-create-alarm cron reads Boat's inventory
      // directly every 30 minutes and counts every company's runs.
      if (hasSpareSetting) refreshRunCreateLedger(c, params.companyId, params.environmentId);
      // The money unit: a creation id's re-send repeats its first body byte-for-byte.
      const labels = createLabels(params.requestedExpiresAt ?? (params.creationOperationId
        ? await creationExpiry(params.companyId, params.creationOperationId, ttl)
        : new Date(Date.now() + ttl * 1000).toISOString()));
      const createBody = JSON.stringify(createSandboxBody(c, ttl, labels, from));
      const createStartedAt = Date.now();
      // One budget bounds the whole acquisition: create, adoption, readiness,
      // setup and handoff (rf-4 U3 C1). Daytona: one deadline (daytona
      // plugin.ts:2981-2987) asserted between phases (assertActive, :3011-3013,
      // :3061-3092). A lease is never handed off after it; the catch below
      // stops the box and the host retries the ETIMEDOUT.
      const deadline = createStartedAt + BOAT_ACQUIRE_ATTEMPT_BUDGET_MS;
      // rf-4 U3b C1: the budget also bounds a step IN FLIGHT. Each step gets an
      // abort signal for the time that remains (withinBudget), as each Daytona
      // phase gets `deadline - Date.now()` inside its enclosing deadline race
      // (daytona plugin.ts:3075, :3089, :3145-3163); no step starts after it.
      let phase = "create";
      const budgetError = (detail?: string) => Object.assign(new Error(`Boat lease acquisition exceeded ${BOAT_ACQUIRE_ATTEMPT_BUDGET_MS} ms during ${phase}${detail ? `: ${detail}` : ""}`), {
        code: "ETIMEDOUT", phase, elapsedMs: Math.max(0, Date.now() - createStartedAt), budgetMs: BOAT_ACQUIRE_ATTEMPT_BUDGET_MS });
      // rf-4 U3 C3: one `boat.acquire.phases` line per acquisition, at its end.
      const clock = acquirePhaseClock(createStartedAt);
      let source: "created" | "adopted" = "created";
      let endedAt: number | undefined, stampOutcome: "ok" | "budget" | "error" = "error", failedPhase: string | undefined;
      const assertActive = (next: string) => {
        phase = next;
        clock.enter(next);
        if (Date.now() < deadline) return;
        throw budgetError();
      };
      const budget: AcquisitionBudget = { deadline, enter: assertActive };
      // Set only when Boat reported the box `error` before it was ready (#22194).
      let startFailure: PluginEnvironmentAcquisitionDiagnostic | undefined;
      try {
        if (shuttingDown) throw new Error("Boat provider is shutting down");
        let created: any, adopted = false;
        try {
          created = await sendCreate(c, attemptId, createBody, createStartedAt, deadline);
        } catch (createError) {
          if (createTimedOut(createError)) noteUnsettledCreate(attemptId, createStartedAt);
          // #20828: adopt the box our timed-out create made; never send a second create.
          created = { sandbox: { id: await findTimedOutCreation(c, attemptId, params, createError, createStartedAt) } };
          adopted = true; source = "adopted";
        }
        const sb = created?.sandbox ?? created; if (typeof sb?.id !== "string" || !sb.id) throw new Error("Boat create response did not contain sandbox.id");
        id = sb.id;
        idleActivity.resource(activityKey(c, sb.id));
        // GAP 1: a (deduped) box that is stopped or stopping is never a ready lease;
        // `id` is set, so the cleanup below still stops it and owns it.
        const refuseStopped = (sandbox: any) => {
          const observed = dedupedBoxStop(sandbox);
          if (observed) throw new BoatDedupedBoxStoppedError(sb.id, observed);
        };
        refuseStopped(sb);
        // A created or adopted box waits for ready inside the acquire budget.
        assertActive(adopted ? "adopt" : "create");
        assertActive("ready");
        const ready = await waitReady(c, sb.id, false, { deadline, observe: refuseStopped }).catch(error => {
          if (error instanceof BoatSandboxStateError && error.state === "error") {
            startFailure = { phase: "create", elapsedMs: Math.min(Math.max(0, Date.now() - createStartedAt), BOAT_ACQUIRE_ATTEMPT_BUDGET_MS - 1),
              budgetMs: BOAT_ACQUIRE_ATTEMPT_BUDGET_MS, providerState: "error" };
          }
          throw error;
        });
        assertActive("setup");
        const ownershipObservation = c.setupScript !== undefined ? await waitSetup(c, sb.id, deadline) : ready;
        assertActive("handoff");
        const lease = await finishAcquisition(params, c, sb.id, { ...ready, ...ownershipObservation }, labels, remoteCwd, snapshot, null, undefined, budget);
        assertActive("handoff");
        endedAt = Date.now(); stampOutcome = "ok";
        return lease;
      } catch (caught) {
        // The stamp ends where the acquisition failed, before its cleanup.
        endedAt ??= Date.now(); failedPhase = clock.current();
        // A step that ended at (or after) the budget fails as the budget, typed
        // ETIMEDOUT, so the host retries it (rf-4 U3b F2: readiness exhaustion
        // was a plain Error the host reader could not see). A box Boat could
        // not start keeps its own typed provider-start failure.
        const timedOutCode = caught && typeof caught === "object" && (caught as { code?: unknown }).code === "ETIMEDOUT";
        const error = id && !startFailure && Date.now() >= deadline && !(timedOutCode && (caught as { phase?: unknown }).phase !== undefined)
          ? budgetError(caught instanceof Error ? caught.message : undefined) : caught;
        const typed = error && typeof error === "object" ? error as { code?: unknown; budgetMs?: unknown } : {};
        stampOutcome = typed.code === "ETIMEDOUT" && typed.budgetMs === BOAT_ACQUIRE_ATTEMPT_BUDGET_MS ? "budget" : "error";
        if (shuttingDown && !id) throw error;
        const ids = id ? [id] : await acquisitionMatches(c, attemptId, params).catch(lookupError => {
          // frozen7-VERDICT F2: Boat definitely refused this create. A failing
          // ownership lookup must not replace that refusal with its own
          // (transient) error. The cleanup obligation stays with core's durable
          // creation intent: its inspection repeats this lookup until it settles.
          const createStatus = definiteRefusalStatus(error);
          if (createStatus === undefined) throw lookupError;
          const lookup = lookupError as { httpStatus?: unknown; code?: unknown };
          duplexLogger?.warn("Boat acquisition ownership lookup failed after a refused create; cleanup stays with the creation intent", {
            companyId: params.companyId, environmentId: params.environmentId, attemptId, createStatus,
            lookupStatus: typeof lookup?.httpStatus === "number" ? lookup.httpStatus : null,
            ...(typeof lookup?.code === "string" && TRANSPORT_ERROR_CODES.has(lookup.code) ? { lookupCode: lookup.code } : {}),
          });
          throw error;
        });
        if (id) {
          await duplexChannels.suspend({ ...params, providerLeaseId: id });
          await retireForLifecycle({ ...params, providerLeaseId: id });
        }
        await cleanupAcquisition(c, ids, params, attemptId, error, startFailure);
        // #22194: Boat could not start the box, before any agent work. The SDK on
        // this line carries the acquisition diagnostic (providerState "error")
        // only with a cleanup envelope, so the stopped box's exact ownership
        // goes with it; the host's repeat stop of an archived box is a no-op.
        if (startFailure && id) throw new PluginEnvironmentCreationCleanupError([error],
          `Boat sandbox ${id} entered error; Boat could not start it, and it was stopped.`, cleanupIdentity(c, id, params, attemptId), startFailure);
        throw error;
      } finally {
        // rf-4 U3 C3: the budget's gate window (ok or not), reported to the
        // acquisition's one outer line (review-fleet-4 C1), never logged here.
        try {
          phases.ordinary({ startedAt: createStartedAt, source, outcome: stampOutcome, ...(failedPhase ? { failedPhase } : {}),
            ...clock.stamp(endedAt ?? Date.now()) });
        } catch { /* Stamping never changes allocation outcome. */ }
      }
    };
    if (!hasSpareSetting) await recordOutcomeOnce("cold", "config_mismatch");
    else if (!listedEnvironment) {
      if (spareOperations) queueSpareReconciliation(spareKey, 0, ttl, spareOperations, spareIdleMinutes, policy);
      await recordOutcomeOnce("cold", "env_not_listed");
    } else if (baseSpares === 0) {
      if (spareOperations) queueSpareReconciliation(spareKey, 0, ttl, spareOperations, spareIdleMinutes, policy);
      await recordOutcomeOnce("cold", "spares_disabled");
    } else if (params.purpose === "login" || params.resolveSnapshotIdentity === true
        || params.issueId === null) {
      // Host environment-runtime.ts sends issueId:null for both hire tests and
      // environment probes. Its runId is a synthetic UUID even without a run
      // (sandbox-creation-operations.ts), so runId presence proves nothing.
      // Legacy callers omitting issueId retain their existing run behavior.
      // Probes may teach/refill a pool, but can NEVER consume its paid spare.
      if (spareOperations) queueSpares(readySpares.demandTarget(spareKey, baseSpares, spareMax, demandWindowMinutes), spareOperations);
      await recordOutcomeOnce("cold", "no_ready_spare");
    } else if (spareClaimStore && spareOperations) {
      const desiredSpares = readySpares.demandTarget(spareKey, baseSpares, spareMax, demandWindowMinutes);
      let id: string | undefined;
      if (desiredSpares > 0 && readySpares.ready(spareKey).length === 0) {
        // Consult the bounded durable inventory BEFORE allocating a run box.
        // Claim discovery only reads; retirement belongs to reconciliation.
        await readySpares.adopt(spareKey, spareOperations, true).catch(() => undefined);
      }
      const claimAttempt = `${encodeURIComponent(params.runId ?? "unknown")}:${encodeURIComponent(attemptId)}`;
      const claimResult = await readySpares.claimWithOutcome(spareKey, claimAttempt, ttl, spareOperations, params.runId ?? "unknown");
      if (shuttingDown) throw new Error("Boat provider is shutting down");
      if (claimResult.outcome === "spare") {
        phases.spareHandoff();
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
        queueSpares(demandedSpares, spareOperations);
        const lease = await finishAcquisition(params, c, id, ready, claimedSpare.labels, remoteCwd, snapshot, claimName, claimedSpare);
        // The run's acquire is now bound to this box; a step on it proves use.
        bindClaimedSpare(params.companyId, params.environmentId, id);
        return lease;
      }
      await recordOutcomeOnce("cold", claimResult.reason);
      if (shuttingDown) throw new Error("Boat provider is shutting down");
      queueSpares(desiredSpares, spareOperations);
      return await createOrdinaryLease();
    } else {
      await recordOutcomeOnce("cold", "no_ready_spare");
    }
    return await createOrdinaryLease();
    };
    const work = acquire().then(lease => { phases.emit(true); return lease; }, error => { phases.emit(false); throw error; });
    const countedWork = work.then(lease => { startRunLeaseTtlRefresh(params, parse(params.config), lease, acquiredAt); return lease; }).finally(async () => {
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
      // Report operation-scoped absence as destroyed: core owns the settle
      // deadline and bounded absence budget; early absence stays inconclusive there.
      // A create this worker sent that timed out stays inconclusive here until
      // core's settle floor has passed, so core keeps inspecting at its retry
      // interval and a late box is found and stopped (adopt-boat-late-box2).
      if (!ids.length && createStillSettling(params.creationOperation.id)) throw new Error("Boat creation identity is not visible yet; retry inspection");
      if (!ids.length) return { providerLeaseId: params.creationOperation.id, state: "destroyed", stoppedAt: null, lastRebootAt: null, observedAt: new Date().toISOString() };
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
      await stopRunLeaseTtlRefresh(c, params.providerLeaseId);
      idleActivity.confirm(proof, true);
      return { providerLeaseId: params.providerLeaseId, state: "destroyed", stoppedAt: null, lastRebootAt: null, observedAt };
    }
    const sandbox = result.sandbox ?? result;
    if (sandbox.id !== params.providerLeaseId) throw new Error("Boat inspection returned a different allocation.");
    if (renewalEndedStates.has(sandbox.state)) await stopRunLeaseTtlRefresh(c, params.providerLeaseId);
    if (sandbox.state === "archived") idleActivity.confirm(proof, true);
    // Boat documents terminal cancelled/404, the state enum, stoppedAt and lastReboot:
    // https://docs.boat.dev/api/reference/sandboxes/get-sandbox.md
    const stoppedAt = sandbox.stoppedAt ?? null;
    const state = sandbox.state === "cancelled" ? "destroyed" : sandbox.state === "archived" && stoppedAt !== null ? "stopped" : ["ready", "idle", "running"].includes(sandbox.state) ? "active" : "unknown";
    return { providerLeaseId: params.providerLeaseId, state, stoppedAt, lastRebootAt: sandbox.lastReboot?.at ?? null, observedAt };
  },
  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams): Promise<PluginEnvironmentLease> {
    const acquiredAt = Date.now();
    const c = parse(params.config), id = params.providerLeaseId;
    const renewUntil = params.runId ? runLeaseRenewUntil(c, id, params.runId, acquiredAt) : undefined;
    // End the prior binding before the handoff's own PATCH/resume. A slow RUN
    // refresh must not overlap it, nor survive a refused/expired handoff.
    await stopRunLeaseTtlRefresh(c, id);
    await recordCompanySpareActivity(params.companyId, true);
    preparedEnvDirectories.delete(id);
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
    // A RUNNING box whose stop Boat refused (our cached refusal, or the box's own stop
    // reads `failing`) is not warm: Boat retries that stop until it archives the box,
    // and "Only a resume ends it early (`superseded`)" (staged boat-llms-full.txt :1855;
    // "a resume cancels the stop", :15380). So an explicit resume POSTs /resume here
    // too; only its successful exact-id answer clears the refusal (markOurResume).
    // A TTL PATCH alone cancels nothing (rf-4 U2 F2, J14).
    const refusedStop = !!sandbox && (stopRefusals.has(activityKey(c, id)) || ["failing", "failed"].includes(sandbox.stop?.status));
    if (!sandbox || !["ready", "idle", "running"].includes(sandbox.state) || refusedStop) {
      // boatdocs-0110c/api_reference_sandboxes_resume-sandbox.md:35-75,147-172.
      const response = await request(c, `/sandboxes/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(c), ...(c.boatEnvironment === undefined ? { noEnv: true } : {}) }) });
      const sb = response.sandbox ?? response;
      assertSandboxId(sb, id);
      markOurResume(c, id);
      sandbox = await waitReady(c, id, true);
      runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, id));
    } else {
      // Boat auto-stop counts from create/last resume, not activity:
      // https://docs.boat.dev/long-running-tasks/auto-stop.md:14-16.
      // PATCH ttlSeconds sets the deadline to now + ttlSeconds:
      // https://docs.boat.dev/api/reference/sandboxes/update-sandbox.md:91-93.
      // Renew every authorized warm handoff, never with an idle timer.
      const personal = (metadata?.boatOwner as { kind?: unknown } | undefined)?.kind === "personal";
      const boatOrgId = personal ? undefined : metadata?.boatOrgId;
      const orgHeaders = typeof boatOrgId === "string" && boatOrgId.trim() ? { "X-Boat-Org": boatOrgId } : undefined;
      const ttlSeconds = effectiveTtlSeconds(c), requestedAt = Date.now();
      const at = new Date(requestedAt).toISOString();
      try {
        const candidate = await patchLeaseTtl(c, id, orgHeaders, { sendGuard: () => {
          if (renewUntil !== undefined && Date.now() >= renewUntil) throw new Error("Boat RUN renewal cap reached");
        } });
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
      const details = { providerLeaseId: redactKey(c, id), status: ttlRefresh.status,
        category: ttlRefresh.status === "failed" ? ttlRefresh.category : ttlRefresh.status === "unconfirmed" ? "deadline_mismatch" : null };
      if (ttlRefresh.status === "ok") duplexLogger?.info("Boat warm lease TTL refresh", details);
      else duplexLogger?.warn("Boat warm lease TTL refresh", details);
    }
    const workspaceSentinel = sentinel ? await verifyWorkspaceSentinel(sentinel, {
      request: (path, init) => request(c, path, init),
      // R1: sentinel cat is read-only; an ECONNRESET must retain resume recovery.
      run: (command, timeout) => runCommand(c, id, command, timeout, undefined, undefined, { intent: "idempotent_probe" }),
    }) : undefined;
    if (workspaceSentinel && workspaceSentinel.result !== "matched") return { providerLeaseId: null, metadata: { expired: true, workspaceSentinel, ...(ttlRefresh ? { ttlRefresh } : {}) } };
    const guardianPreflight = await stageGuardian(params.config, id, {
      request: (path, init) => request(c, path, init), run: (command, timeout, options) => runCommand(c, id, command, timeout, undefined, undefined, options),
    }, metadata);
    // A disabled carrier must not inherit an earlier lease's usable receipt.
    const { guardianPreflight: _previousGuardian, runnerGuardianVersion: _previousVersion,
      boatOrgId: _previousOrg, boatOwner: _previousOwner, ttlRefresh: _previousTtlRefresh, ...retainedMetadata } = metadata ?? {};
    await bindDuplexLease(params, id, guardianPreflight);
    const ownership = boatOwnershipForLease(sandbox, id);
    const lease = { providerLeaseId: id, expiresAt: ttlRefresh && ttlRefresh.status !== "failed" ? refreshExpiresAt : sandbox.archiveAfter ?? sandbox.expiresAt ?? sandbox.autoStopAt ?? null,
      metadata: { ...retainedMetadata, provider: c.provider, resumed: true, resumedLease: true, resumedFromState,
        ...ownership, ...(ttlRefresh ? { ttlRefresh } : {}),
        ...(guardianPreflight ? { guardianPreflight, runnerGuardianVersion: 1 } : {}), ...(workspaceSentinel ? { workspaceSentinel } : {}) } };
    startRunLeaseTtlRefresh(params, c, lease, acquiredAt);
    return lease;
  },
  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams) {
    if (params.providerLeaseId) await stopRunLeaseTtlRefresh(parse(params.config), params.providerLeaseId);
    unbindClaimedSpare(params.providerLeaseId);
    await recordCompanySpareActivity(params.companyId);
    if (!params.providerLeaseId) return;
    const c = parse(params.config); const id = params.providerLeaseId;
    preparedEnvDirectories.delete(id);
    await duplexChannels.suspend({ ...params, providerLeaseId: id });
    const warnings = await retireForLifecycle({ ...params, providerLeaseId: id });
    // Lifecycle hooks issue no guest command; leave the now-empty private env directory rather than add one solely for cleanup.
    const receipt = await stopSandbox(c, id);
    runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, id));
    return { ...receipt, ...(warnings.length ? { warnings } : {}) };
  },
  async onEnvironmentStopLease(params: PluginEnvironmentReleaseLeaseParams) {
    if (params.providerLeaseId) await stopRunLeaseTtlRefresh(parse(params.config), params.providerLeaseId);
    unbindClaimedSpare(params.providerLeaseId);
    if (!params.providerLeaseId) throw new Error("Boat stop requires an exact providerLeaseId");
    const c = parse(params.config);
    preparedEnvDirectories.delete(params.providerLeaseId);
    await duplexChannels.suspend({ ...params, providerLeaseId: params.providerLeaseId });
    const warnings = await retireForLifecycle({ ...params, providerLeaseId: params.providerLeaseId });
    const receipt = await stopSandbox(c, params.providerLeaseId);
    runnerIngressGenerationStore.invalidate(ingressScopeKey(params, c, params.providerLeaseId));
    return { ...receipt, ...(warnings.length ? { warnings } : {}) };
  },
  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams) {
    if (params.providerLeaseId) await stopRunLeaseTtlRefresh(parse(params.config), params.providerLeaseId);
    unbindClaimedSpare(params.providerLeaseId);
    if (!params.providerLeaseId) return;
    const c = parse(params.config);
    preparedEnvDirectories.delete(params.providerLeaseId);
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
      const result = await runCommand(parse(params.config), params.lease.providerLeaseId, `mkdir -p ${q(cwd)}`, 30_000,
        undefined, undefined, { intent: "idempotent_probe" });
      if (result.timedOut || result.exitCode !== 0) throw new Error("Boat workspace directory creation failed.");
    }
    return { cwd, metadata: { provider: "boat", remoteCwd: cwd } };
  },
  async onEnvironmentRunnerIngressEndpoint(params: PluginEnvironmentRunnerIngressEndpointParams): Promise<PluginEnvironmentRunnerIngressEndpoint> {
    if (params.port !== 43127) throw new Error("Boat runner ingress must use fixed port 43127.");
    if (!/^\/api\/runner\/v1\/connect\/[A-Za-z0-9_-]+$/.test(params.path)) throw new Error("Boat runner ingress path is invalid.");
    const id = params.lease.providerLeaseId;
    if (!id) throw new Error("Boat runner ingress requires a provider lease id.");
    recordSpareUse(params.companyId, id, "runner_ingress");
    const c = parse(params.config);
    const result = await acquireRunnerIngress("sandbox_lookup", () => request(c, `/sandboxes/${encodeURIComponent(id)}`));
    let sandbox = result.sandbox ?? result;
    if (sandbox.id !== id) throw new Error("Boat runner ingress returned a different allocation.");
    if (!["ready", "idle", "running"].includes(sandbox.state)) {
      await duplexChannels.suspend({ ...params, providerLeaseId: id });
      await sshCarrier.invalidate({ ...params, providerLeaseId: id });
      await acquireRunnerIngress("sandbox_start", () => request(c, `/sandboxes/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({ ttlSeconds: effectiveTtlSeconds(c), ...(c.boatEnvironment === undefined ? { noEnv: true } : {}) }) }));
      markOurResume(c, id);
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
    recordSpareUse(params.companyId, id, "execute");
    const c = parse(params.config); validEnv(params.env);
    // A caller's command deadline includes recovery/HTTP transport time, not
    // only Boat's rounded command timeout plus its transport allowance.
    const signal = params.commandTimeoutMs && params.commandTimeoutMs > 0
      ? AbortSignal.timeout(Math.ceil(params.commandTimeoutMs)) : undefined;
    let stdinPath: string | null = null, envPath: string | null = null;
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
    const roots = [params.cwd, params.lease.metadata?.remoteCwd].filter((p): p is string => typeof p === "string")
      .map(p => posix.resolve("/home/user", p));
    let envRecoveryUsed = false;
    try {
      const env = Object.entries(params.env ?? {});
      if (env.length) {
        // Never include values (or names) in Boat's retained command text.
        // Keep files outside BOTH the exec cwd and the recorded copyback root.
        const directory = await ensurePrivateEnvDirectory(c, id, roots);
        const uuid = randomUUID();
        envPath = `${directory}/${uuid}.sh`;
        if (!roots.every(root => envPath !== root && !envPath!.startsWith(root === "/" ? root : `${root}/`))) throw new Error("Boat env file requires a private path outside the workspace.");
        // The lease directory is verified private before Boat can write any secret.
        const envContent = env.map(([k, v]) => `export ${k}=${q(v)}\n`).join("");
        try { await stage(envPath, envContent, "env"); }
        catch (error) {
          if (envRecoveryUsed || !/(?:404|not found|no such file|missing)/i.test(String(error))) throw error;
          envRecoveryUsed = true;
          await request(c, `${base}?path=${encodeURIComponent(envPath)}`, { method: "DELETE" }).catch(() => undefined);
          preparedEnvDirectories.delete(id);
          const retryDir = await ensurePrivateEnvDirectory(c, id, roots);
          envPath = `${retryDir}/${randomUUID()}.sh`;
          await stage(envPath, envContent, "env");
        }
      }
      if (params.stdin !== undefined) {
        stdinPath = `/tmp/paperclip-stdin-${randomUUID()}`;
        await stage(stdinPath, params.stdin, "stdin");
      }
      const invocation = [q(params.command), ...(params.args ?? []).map(q)].join(" ");
      // Absolute cleanup utilities still work when the caller overrides PATH.
      const environment = envPath ? `umask 077 && /bin/chmod 600 -- ${q(envPath)} && . ${q(envPath)} && /bin/rm -f -- ${q(envPath)} || exit 197 && ` : "";
      const wrapped = `${params.cwd ? (envPath ? `if cd ${q(params.cwd)}; then :; else exit 1; fi; ` : `cd ${q(params.cwd)} && `) : ""}${environment}exec ${invocation}${stdinPath ? ` < ${q(stdinPath)}` : ""}`;
      let result = await runCommand(c, id, wrapped, params.timeoutMs ?? params.commandTimeoutMs ?? 600_000, undefined, signal);
      if (!envRecoveryUsed && envPath && result.exitCode === 197) {
        envRecoveryUsed = true;
        preparedEnvDirectories.delete(id);
        const retryDir = await ensurePrivateEnvDirectory(c, id, roots);
        const retryPath = `${retryDir}/${randomUUID()}.sh`;
        await request(c, `${base}?path=${encodeURIComponent(envPath)}`, { method: "DELETE" }).catch(() => undefined);
        await stage(retryPath, Object.entries(params.env ?? {}).map(([k, v]) => `export ${k}=${q(v)}\n`).join(""), "env");
        envPath = retryPath;
        const retryWrapper = `${params.cwd ? `if cd ${q(params.cwd)}; then :; else exit 1; fi; ` : ""}umask 077 && /bin/chmod 600 -- ${q(envPath)} && . ${q(envPath)} && /bin/rm -f -- ${q(envPath)} || exit 197 && exec ${invocation}${stdinPath ? ` < ${q(stdinPath)}` : ""}`;
        result = await runCommand(c, id, retryWrapper, params.timeoutMs ?? params.commandTimeoutMs ?? 600_000, undefined, signal);
      }
      return result;
    } finally {
      for (const path of [envPath, stdinPath]) if (path) await request(c, `${base}?path=${encodeURIComponent(path)}`, { method: "DELETE" }).catch(() => undefined);
    }
  },
}, leaseActivityKey), idleActivity));
export default plugin;
