import { createHash, randomUUID } from "node:crypto";

export const MAX_READY_SPARES = 5;
export const MAX_CONFIGURED_READY_SPARES = 3;
/**
 * Churn cap: spare creates per company per rolling hour that no run has proven
 * it used. A claimed spare whose run reached a step on it (see markUsed) offsets
 * one create in the same hour, so real demand never starves on this cap.
 */
export const MAX_READY_SPARE_CREATES_PER_HOUR = 12;
/**
 * Absolute ceiling on ALL Boat creates (spare + run) per company per rolling
 * hour, whatever the churn rule decides. 60 lets a 50-task burst on a gate run:
 * at most 50 run boxes (one per task, claimed spare or cold) plus at most five
 * spares (MAX_READY_SPARES) is 55, with headroom for a few failed attempts.
 */
export const DEFAULT_CREATE_CEILING_PER_HOUR = 60;
export const MIN_CREATE_CEILING_PER_HOUR = 1;
export const MAX_CREATE_CEILING_PER_HOUR = 1_000;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
/** Repeat a refusal event for the same pool and reason at most this often; the counter counts every refusal. */
const CREATE_CAP_EVENT_INTERVAL_MS = 60_000;
export const READY_SPARE_TTL_SECONDS = 1_800;
export const DEFAULT_READY_SPARE_IDLE_MINUTES = 60;
export const MIN_READY_SPARE_IDLE_MINUTES = 15;
export const MAX_READY_SPARE_IDLE_MINUTES = 1_440;
export const DEFAULT_READY_SPARE_MAX = 3;
export const MIN_READY_SPARE_MAX = 1;
export const MAX_CONFIGURED_READY_SPARE_MAX = 5;
export const DEFAULT_READY_SPARE_DEMAND_WINDOW_MINUTES = 10;
export const MIN_READY_SPARE_DEMAND_WINDOW_MINUTES = 5;
export const MAX_READY_SPARE_DEMAND_WINDOW_MINUTES = 60;
export const MAX_READY_SPARE_ENVIRONMENTS = 10;

export type ReadySpareKey = {
  companyId: string;
  environmentId: string;
  configHash: string;
};

export type ReadySpare = {
  id: string;
  key: ReadySpareKey;
  state: string;
  warmed: boolean;
  expiresAt: string;
  ttlSeconds?: number;
  name: string;
  labels: Record<string, string>;
  providerObservation?: Record<string, unknown>;
};

export type ReadySpareOperations = {
  list(): Promise<ReadySpare[]>;
  get(spare: ReadySpare): Promise<ReadySpare | undefined>;
  create(key: ReadySpareKey): Promise<ReadySpare>;
  /** Best-effort one-time work after a newly created spare is ready. */
  warmUp?(spare: ReadySpare): Promise<"completed" | "missing_pack" | "failed" | "timeout">;
  claim(spare: ReadySpare, claimName: string, ttlSeconds: number): Promise<boolean>;
  refresh(spare: ReadySpare, ttlSeconds: number): Promise<ReadySpare>;
  stop(spare: ReadySpare): Promise<void>;
  /**
   * Re-read company activity and return this pool's spare target right now.
   * The keeper calls it immediately before every POST /stop on a spare, so a
   * stop decided under an older (idle) view never outruns a newer event.
   */
  desired?(): Promise<number>;
  /**
   * Optional provider-side hourly check; fail closed on an unknown result.
   * `false` refuses (churn_cap). An object reports the durable count of spare
   * creates in the last hour (the provider inventory, which survives worker
   * restarts) and the keeper applies the churn cap and ceiling to it.
   */
  allowCreate?(): Promise<boolean | { recentSpareCreates: number }>;
};

export type CreateCapReason = "churn_cap" | "ceiling";

/** The named operator event at a create refusal, and the health reason while it holds. */
export type CreateCapRefusal = {
  companyId: string;
  environmentId: string;
  kind: "spare" | "run";
  reason: CreateCapReason;
  /** Which count decided: this worker's ledger or Boat's durable inventory. */
  source: "local" | "provider";
  /** Spare creates in the window not offset by a proven use, and the cap. */
  churnCreates: number;
  churnCap: number;
  spareCreates: number;
  usedCredits: number;
  runCreates: number;
  /** All creates (spare + run) in the window, and the ceiling. */
  allCreates: number;
  ceiling: number;
  /** Refusals so far for this company (this worker). */
  refusals: Record<CreateCapReason, number>;
  /** Refusals of this pool and reason not logged since the last event. */
  suppressed: number;
  cappedUntil: string;
};

export function readyCreateCeilingPerHour(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return DEFAULT_CREATE_CEILING_PER_HOUR;
  const ceiling = (config as Record<string, unknown>).createCeilingPerHour;
  return Number.isInteger(ceiling) && Number(ceiling) >= MIN_CREATE_CEILING_PER_HOUR && Number(ceiling) <= MAX_CREATE_CEILING_PER_HOUR
    ? Number(ceiling) : DEFAULT_CREATE_CEILING_PER_HOUR;
}

export type ReadySpareClaimStore = {
  reserve(spare: ReadySpare, claimToken: string, runId: string): Promise<boolean>;
};

export type ReadySpareClaimResult =
  | { outcome: "spare"; spare: ReadySpare }
  | { outcome: "cold"; reason: "no_ready_spare" | "create_capped" | "refill_in_flight" | "config_mismatch" | "claim_conflict" };

export type ReadySpareClaimDatabase = {
  namespace: string;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
};

/** Build the cross-worker claim store on the plugin's restricted database namespace. */
export function createReadySpareClaimStore(db: ReadySpareClaimDatabase): ReadySpareClaimStore {
  if (!/^[a-z][a-z0-9_]*$/.test(db.namespace)) throw new Error("Boat plugin database namespace is invalid");
  const table = `${db.namespace}.boat_spare_claims`;
  return {
    async reserve(spare, claimToken, runId) {
      const result = await db.execute(
        `INSERT INTO ${table} (provider_lease_id, company_id, environment_id, claim_token, run_id, claimed_at)\n` +
        "VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_lease_id) DO NOTHING",
        [spare.id, spare.key.companyId, spare.key.environmentId, claimToken, runId, new Date().toISOString()],
      );
      return result.rowCount === 1;
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash precisely the fields that determine the sandbox passed to Boat create. */
export function readySpareConfigHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function readySparePoolKey(key: ReadySpareKey): string {
  return JSON.stringify([key.companyId, key.environmentId, key.configHash]);
}

export function readySpareCount(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return 0;
  const count = (config as Record<string, unknown>).spares;
  return Number.isInteger(count) && Number(count) >= 0 && Number(count) <= MAX_CONFIGURED_READY_SPARES ? Number(count) : 0;
}

export function readySpareMax(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return DEFAULT_READY_SPARE_MAX;
  const max = (config as Record<string, unknown>).spareMax;
  return Number.isInteger(max) && Number(max) >= MIN_READY_SPARE_MAX && Number(max) <= MAX_CONFIGURED_READY_SPARE_MAX
    ? Number(max) : DEFAULT_READY_SPARE_MAX;
}

export function readySpareDemandWindowMinutes(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return DEFAULT_READY_SPARE_DEMAND_WINDOW_MINUTES;
  const minutes = (config as Record<string, unknown>).spareDemandWindowMinutes;
  return Number.isInteger(minutes) && Number(minutes) >= MIN_READY_SPARE_DEMAND_WINDOW_MINUTES && Number(minutes) <= MAX_READY_SPARE_DEMAND_WINDOW_MINUTES
    ? Number(minutes) : DEFAULT_READY_SPARE_DEMAND_WINDOW_MINUTES;
}

/** Demand adds one spare beyond each recent acquire, bounded by floor and configured maximum. */
export function readySpareDemandTarget(spares: number, claimsInWindow: number, spareMax: number): number {
  const floor = Math.max(0, Math.min(MAX_CONFIGURED_READY_SPARES, Math.trunc(spares)));
  if (floor === 0) return 0;
  const maximum = Math.max(floor, Math.min(MAX_READY_SPARES, Math.trunc(spareMax)));
  const demand = claimsInWindow >= 1 ? Math.trunc(claimsInWindow) + 1 : floor;
  return Math.max(floor, Math.min(maximum, demand));
}

export function readySpareIdleMinutes(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return DEFAULT_READY_SPARE_IDLE_MINUTES;
  const minutes = (config as Record<string, unknown>).spareIdleMinutes;
  return Number.isInteger(minutes) && Number(minutes) >= MIN_READY_SPARE_IDLE_MINUTES && Number(minutes) <= MAX_READY_SPARE_IDLE_MINUTES
    ? Number(minutes) : DEFAULT_READY_SPARE_IDLE_MINUTES;
}

/** Empty, absent, or malformed environment scope is deliberately safe: no spare environments. */
export function readySpareEnvironmentIds(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const ids = (config as Record<string, unknown>).spareEnvironmentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_READY_SPARE_ENVIRONMENTS) return [];
  const normalized = ids.map(id => typeof id === "string" ? id.trim() : "");
  if (normalized.some(id => !id) || new Set(normalized).size !== normalized.length) return [];
  return normalized;
}

function isActiveState(state: string): boolean {
  return state === "ready" || state === "idle" || state === "running";
}

function isTerminalState(state: string): boolean {
  return state === "archived" || state === "stopped" || state === "error" || state === "cancelled";
}

/** Why a stop was chosen; the fresh re-read can only veto it, never widen it. */
type StopPremise = {
  /** Surplus beyond this target; skipped when the fresh target is larger. */
  surplusOf?: number;
  /** An unready box that may be this pool's own in-flight refill. */
  maybeRefill?: boolean;
};

function identityMatches(spare: ReadySpare, key: ReadySpareKey): boolean {
  return spare.key.companyId === key.companyId && spare.key.environmentId === key.environmentId && spare.key.configHash === key.configHash
    && spare.labels.owner === `paperclip:${key.companyId}` && spare.labels.environment === key.environmentId
    && spare.labels.purpose === "spare" && spare.labels.configHash === key.configHash;
}

function readyAndHealthy(spare: ReadySpare, key: ReadySpareKey, now: number): boolean {
  return identityMatches(spare, key) && spare.warmed && isActiveState(spare.state)
    && Number.isFinite(Date.parse(spare.expiresAt)) && Date.parse(spare.expiresAt) > now
    && spare.name === `paperclip-spare:ready:${key.configHash}`;
}

/**
 * Worker-local index of already-warmed Boat boxes. Boat labels/name are the
 * durable record; after a worker restart, `reconcile` rebuilds this index from
 * the provider inventory before starting replacements.
 */
export class ReadySpareKeeper {
  private readonly pools = new Map<string, ReadySpare[]>();
  private readonly inFlightCreates = new Map<string, number>();
  private readonly reconciling = new Map<string, Promise<void>>();
  private readonly activeDesired = new Map<string, number>();
  private readonly pendingReconciliations = new Map<string, { key: ReadySpareKey; desired: number; operations: ReadySpareOperations; strictBoatOnly?: boolean }>();
  private readonly adopting = new Map<string, Promise<void>>();
  private readonly claiming = new Set<string>();
  private readonly inFlightClaims = new Map<string, number>();
  /** Spare create reservations per company (pending, failed and successful starts all count). */
  private readonly recentCreates = new Map<string, Map<string, number>>();
  /** Ordinary run create attempts per company; they count toward the ceiling only. */
  private readonly runCreates = new Map<string, Map<string, number>>();
  /** Claimed spares whose bound run reached a step on the box, keyed by box ID: one credit per box. */
  private readonly usedCredits = new Map<string, Map<string, number>>();
  private readonly createCeilings = new Map<string, number>();
  private readonly capped = new Map<string, { refusal: CreateCapRefusal; until: number; loggedAt: number; suppressed: number }>();
  private readonly refusalCounts = new Map<string, Record<CreateCapReason, number>>();
  private refusalListener?: (refusal: CreateCapRefusal) => void;
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly demandEvents = new Map<string, number[]>();
  private readonly stoppingSpares = new Set<string>();
  private stopping = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxCreatesPerHour = MAX_READY_SPARE_CREATES_PER_HOUR,
    private claimStore?: ReadySpareClaimStore,
  ) {}

  setClaimStore(claimStore: ReadySpareClaimStore | undefined): void { this.claimStore = claimStore; }
  /** Called at every refusal that should be logged (throttled per pool and reason). */
  setRefusalListener(listener: ((refusal: CreateCapRefusal) => void) | undefined): void { this.refusalListener = listener; }
  setCreateCeiling(companyId: string, ceiling: number): void {
    this.createCeilings.set(companyId, Number.isInteger(ceiling) && ceiling >= MIN_CREATE_CEILING_PER_HOUR && ceiling <= MAX_CREATE_CEILING_PER_HOUR
      ? ceiling : DEFAULT_CREATE_CEILING_PER_HOUR);
  }
  createCeiling(companyId: string): number { return this.createCeilings.get(companyId) ?? DEFAULT_CREATE_CEILING_PER_HOUR; }

  private windowed(ledger: Map<string, Map<string, number>>, companyId: string): Map<string, number> {
    const entries = ledger.get(companyId) ?? new Map<string, number>();
    for (const [token, at] of entries) if (this.now() - at >= CREATE_WINDOW_MS) entries.delete(token);
    ledger.set(companyId, entries);
    return entries;
  }

  /** This worker's rolling-hour create counts for one company. */
  createCounts(companyId: string): { spareCreates: number; runCreates: number; usedCredits: number; churnCreates: number; allCreates: number } {
    const spareCreates = this.windowed(this.recentCreates, companyId).size;
    const runCreates = this.windowed(this.runCreates, companyId).size;
    const usedCredits = this.windowed(this.usedCredits, companyId).size;
    return { spareCreates, runCreates, usedCredits, churnCreates: Math.max(0, spareCreates - usedCredits), allCreates: spareCreates + runCreates };
  }

  /**
   * Proof of use: the run whose acquire was bound to this claimed spare reached
   * a step on it. The spare is USED, so one spare create in this hour (its
   * replacement) is no longer churn. Idempotent per box. Returns true when new.
   */
  markUsed(companyId: string, spareId: string): boolean {
    const credits = this.windowed(this.usedCredits, companyId);
    if (credits.has(spareId)) return false;
    credits.set(spareId, this.now());
    return true;
  }

  /** Pools of this company now refused by the churn cap (a new proof of use may admit their replacement). */
  churnCappedPools(companyId: string): ReadySpareKey[] {
    const keys: ReadySpareKey[] = [];
    for (const [poolId, entry] of this.capped) {
      if (entry.refusal.companyId !== companyId || entry.refusal.kind !== "spare" || entry.refusal.reason !== "churn_cap" || this.now() >= entry.until) continue;
      const [, environmentId, configHash] = JSON.parse(poolId) as [string, string, string];
      keys.push({ companyId, environmentId, configHash });
    }
    return keys;
  }

  /** Refusals in effect now, for health/status. */
  activeCaps(): CreateCapRefusal[] {
    const active: CreateCapRefusal[] = [];
    for (const [poolId, entry] of this.capped) {
      if (this.now() >= entry.until) { this.capped.delete(poolId); continue; }
      active.push(entry.refusal);
    }
    return active;
  }

  refusalTotals(): Record<CreateCapReason, number> {
    const totals: Record<CreateCapReason, number> = { churn_cap: 0, ceiling: 0 };
    for (const counts of this.refusalCounts.values()) { totals.churn_cap += counts.churn_cap; totals.ceiling += counts.ceiling; }
    return totals;
  }

  private isCapped(capId: string): boolean {
    const entry = this.capped.get(capId);
    return entry !== undefined && this.now() < entry.until;
  }

  private refuse(capId: string, scope: { companyId: string; environmentId: string; kind: "spare" | "run" }, reason: CreateCapReason,
    source: "local" | "provider", counts: ReturnType<ReadySpareKeeper["createCounts"]>, churnCreates = counts.churnCreates, allCreates = counts.allCreates): CreateCapRefusal {
    const refusals = this.refusalCounts.get(scope.companyId) ?? { churn_cap: 0, ceiling: 0 };
    refusals[reason]++;
    this.refusalCounts.set(scope.companyId, refusals);
    // The earliest moment a counted create can leave the window. A provider
    // count gives no timestamps here, so hold for the whole window; the next
    // admitted create for this pool clears it.
    const local = reason === "ceiling"
      ? [...this.windowed(this.recentCreates, scope.companyId).values(), ...this.windowed(this.runCreates, scope.companyId).values()]
      : [...this.windowed(this.recentCreates, scope.companyId).values()];
    const until = source === "local" && local.length ? Math.min(...local) + CREATE_WINDOW_MS : this.now() + CREATE_WINDOW_MS;
    const previous = this.capped.get(capId);
    const sameEpisode = previous !== undefined && this.now() < previous.until && previous.refusal.reason === reason;
    const log = !sameEpisode || this.now() - previous.loggedAt >= CREATE_CAP_EVENT_INTERVAL_MS;
    const suppressed = sameEpisode && !log ? previous.suppressed + 1 : 0;
    const refusal: CreateCapRefusal = { ...scope, reason, source, churnCreates, churnCap: this.maxCreatesPerHour,
      spareCreates: counts.spareCreates, usedCredits: counts.usedCredits, runCreates: counts.runCreates,
      allCreates, ceiling: this.createCeiling(scope.companyId), refusals: { ...refusals },
      suppressed: sameEpisode && log ? previous.suppressed : 0, cappedUntil: new Date(until).toISOString() };
    this.capped.set(capId, { refusal, until, loggedAt: log ? this.now() : previous!.loggedAt, suppressed });
    if (log) { try { this.refusalListener?.(refusal); } catch { /* Reporting never changes admission. */ } }
    return refusal;
  }

  /**
   * Admit one ordinary run create against the company's absolute ceiling and
   * record it. A refused run create is never sent to Boat.
   */
  admitRunCreate(companyId: string, environmentId: string): { admitted: true } | { admitted: false; refusal: CreateCapRefusal } {
    const capId = JSON.stringify([companyId, environmentId, "run"]);
    const counts = this.createCounts(companyId);
    if (counts.allCreates >= this.createCeiling(companyId)) {
      return { admitted: false, refusal: this.refuse(capId, { companyId, environmentId, kind: "run" }, "ceiling", "local", counts) };
    }
    this.windowed(this.runCreates, companyId).set(randomUUID(), this.now());
    this.capped.delete(capId);
    return { admitted: true };
  }
  start(): void { this.stopping = false; }
  stop(): void { this.stopping = true; }
  reset(): void {
    this.stop();
    this.claimStore = undefined;
    this.pools.clear(); this.inFlightCreates.clear(); this.reconciling.clear(); this.activeDesired.clear();
    this.pendingReconciliations.clear(); this.adopting.clear(); this.claiming.clear(); this.inFlightClaims.clear(); this.recentCreates.clear(); this.failures.clear(); this.demandEvents.clear();
    this.stoppingSpares.clear();
    this.runCreates.clear(); this.usedCredits.clear(); this.createCeilings.clear(); this.capped.clear(); this.refusalCounts.clear();
    this.refusalListener = undefined;
  }

  /**
   * The only way the keeper stops a spare. Company activity is re-read
   * immediately before the POST /stop; a stop whose premise no longer holds is
   * skipped and the caller keeps the candidate. Returns true when it stopped.
   */
  private async stopSpare(key: ReadySpareKey, spare: ReadySpare, operations: ReadySpareOperations, premise: StopPremise = {}): Promise<boolean> {
    if (operations.desired) {
      let fresh: number | undefined;
      try { fresh = await operations.desired(); } catch { fresh = undefined; }
      const vetoable = premise.surplusOf !== undefined || premise.maybeRefill === true;
      if (fresh === undefined && vetoable) return false; // Unknown activity is never a reason to stop.
      if (fresh !== undefined && premise.surplusOf !== undefined && fresh > premise.surplusOf) return false;
      if (fresh !== undefined && fresh > 0 && premise.maybeRefill && (this.inFlightCreates.get(readySparePoolKey(key)) ?? 0) > 0
          && spare.labels.configHash === key.configHash && spare.name !== `paperclip-spare:ready:${key.configHash}`
          && !spare.name.startsWith("paperclip-claim:") && !isTerminalState(spare.state)) return false;
    }
    this.stoppingSpares.add(spare.id);
    try { await operations.stop(spare); }
    finally { this.stoppingSpares.delete(spare.id); }
    return true;
  }

  /** Replace a pool from one inventory pass without dropping candidates that pass did not see. */
  private commitPool(poolId: string, next: ReadySpare[], listed: readonly ReadySpare[]): void {
    const listedIds = new Set(listed.map(spare => spare.id));
    for (const spare of this.pools.get(poolId) ?? []) {
      if (!listedIds.has(spare.id) && !this.stoppingSpares.has(spare.id) && !next.some(item => item.id === spare.id)) next.push(spare);
    }
    if (next.length) this.pools.set(poolId, next);
    else this.pools.delete(poolId);
  }

  ready(key: ReadySpareKey): readonly ReadySpare[] {
    return [...(this.pools.get(readySparePoolKey(key)) ?? [])];
  }

  recordDemand(key: Pick<ReadySpareKey, "companyId" | "environmentId">): number {
    const demandId = JSON.stringify([key.companyId, key.environmentId]);
    const events = (this.demandEvents.get(demandId) ?? []).filter(at => this.now() - at < MAX_READY_SPARE_DEMAND_WINDOW_MINUTES * 60_000);
    events.push(this.now());
    this.demandEvents.set(demandId, events);
    return events.length;
  }

  demandCount(key: Pick<ReadySpareKey, "companyId" | "environmentId">, windowMinutes = DEFAULT_READY_SPARE_DEMAND_WINDOW_MINUTES): number {
    const demandId = JSON.stringify([key.companyId, key.environmentId]);
    const cutoff = this.now() - windowMinutes * 60_000;
    const events = (this.demandEvents.get(demandId) ?? []).filter(at => at > cutoff);
    if (events.length) this.demandEvents.set(demandId, events);
    else this.demandEvents.delete(demandId);
    return events.length;
  }

  demandTarget(key: Pick<ReadySpareKey, "companyId" | "environmentId">, spares: number, spareMax: number,
    windowMinutes = DEFAULT_READY_SPARE_DEMAND_WINDOW_MINUTES): number {
    return readySpareDemandTarget(spares, this.demandCount(key, windowMinutes), spareMax);
  }

  isRefilling(key: ReadySpareKey): boolean {
    const poolId = readySparePoolKey(key);
    return this.reconciling.has(poolId) || (this.inFlightCreates.get(poolId) ?? 0) > 0;
  }

  hasConfigMismatch(key: ReadySpareKey): boolean {
    for (const [poolId, spares] of this.pools) {
      if (poolId === readySparePoolKey(key)) continue;
      const candidate = spares.find(spare => spare.key.companyId === key.companyId && spare.key.environmentId === key.environmentId
        && spare.key.configHash !== key.configHash && readyAndHealthy(spare, spare.key, this.now()));
      if (candidate) return true;
    }
    return false;
  }

  present(): boolean {
    return this.pools.size > 0 || this.reconciling.size > 0 || this.adopting.size > 0;
  }

  async drain(): Promise<void> {
    while (this.reconciling.size || this.adopting.size) {
      await Promise.all([...this.reconciling.values(), ...this.adopting.values()].map(work => work.catch(() => undefined)));
    }
  }

  /** Load durable labeled inventory into the fast claim index without creating anything. */
  async adopt(key: ReadySpareKey, operations: ReadySpareOperations): Promise<void> {
    if (this.stopping) return;
    const poolId = readySparePoolKey(key);
    if ((this.pools.get(poolId) ?? []).some(item => readyAndHealthy(item, key, this.now()))) return;
    const active = this.adopting.get(poolId);
    if (active) return active;
    const work = this.adoptOnce(key, operations);
    this.adopting.set(poolId, work);
    try { await work; }
    finally { if (this.adopting.get(poolId) === work) this.adopting.delete(poolId); }
  }

  private async adoptOnce(key: ReadySpareKey, operations: ReadySpareOperations): Promise<void> {
    const poolId = readySparePoolKey(key);
    const listed = await operations.list();
    const keep: ReadySpare[] = [];
    for (const spare of listed) {
      if (this.stopping) return;
      if (spare.labels.owner !== `paperclip:${key.companyId}` || spare.labels.environment !== key.environmentId || spare.labels.purpose !== "spare") continue;
      if (this.claiming.has(spare.id) || this.stoppingSpares.has(spare.id) || spare.name.startsWith("paperclip-claim:")) continue;
      if (readyAndHealthy(spare, key, this.now())) keep.push(spare);
      else await this.stopSpare(key, spare, operations, { maybeRefill: true });
    }
    this.commitPool(poolId, keep, listed);
  }

  /**
   * Claim only a warmed, running, unexpired exact-key spare already in memory.
   * The in-process reservation is committed before the network PATCH, so
   * concurrent acquires cannot reserve the same ID. Errors are a cache miss:
   * callers can immediately take the ordinary create path.
   */
  async claim(key: ReadySpareKey, attemptId: string, ttlSeconds: number, operations: ReadySpareOperations, runId = attemptId): Promise<ReadySpare | undefined> {
    const result = await this.claimWithOutcome(key, attemptId, ttlSeconds, operations, runId);
    return result.outcome === "spare" ? result.spare : undefined;
  }

  async claimWithOutcome(key: ReadySpareKey, attemptId: string, ttlSeconds: number, operations: ReadySpareOperations, runId = attemptId): Promise<ReadySpareClaimResult> {
    const claimStore = this.claimStore;
    if (this.stopping || !claimStore) return { outcome: "cold", reason: "no_ready_spare" };
    const poolId = readySparePoolKey(key);
    const pool = this.pools.get(poolId) ?? [];
    const now = this.now();
    const healthy = pool.filter(spare => readyAndHealthy(spare, key, now));
    const index = pool.findIndex(spare => !this.claiming.has(spare.id) && !this.stoppingSpares.has(spare.id) && readyAndHealthy(spare, key, now));
    if (index < 0) {
      if (healthy.length || (this.inFlightClaims.get(poolId) ?? 0) > 0) return { outcome: "cold", reason: "claim_conflict" };
      if (this.hasConfigMismatch(key)) return { outcome: "cold", reason: "config_mismatch" };
      if (this.isCapped(poolId)) return { outcome: "cold", reason: "create_capped" };
      if (this.isRefilling(key)) return { outcome: "cold", reason: "refill_in_flight" };
      return { outcome: "cold", reason: "no_ready_spare" };
    }
    const [spare] = pool.splice(index, 1);
    this.claiming.add(spare.id);
    this.inFlightClaims.set(poolId, (this.inFlightClaims.get(poolId) ?? 0) + 1);
    const reason: "claim_conflict" = "claim_conflict";
    try {
      const claimToken = `paperclip-claim:${attemptId}`;
      if (!await claimStore.reserve(spare, claimToken, runId) || this.stopping) return { outcome: "cold", reason };
      const claimed = await operations.claim(spare, claimToken, ttlSeconds);
      return claimed && !this.stopping ? { outcome: "spare", spare } : { outcome: "cold", reason };
    } catch {
      return { outcome: "cold", reason };
    } finally {
      this.claiming.delete(spare.id);
      const remainingClaims = (this.inFlightClaims.get(poolId) ?? 1) - 1;
      if (remainingClaims > 0) this.inFlightClaims.set(poolId, remainingClaims);
      else this.inFlightClaims.delete(poolId);
      if (pool.length) this.pools.set(poolId, pool);
      else this.pools.delete(poolId);
    }
  }

  /** Boat-only timer pass: retire eligible ready spares without consulting claim storage or refilling. */
  async reconcileTimer(key: ReadySpareKey, desired: number, operations: ReadySpareOperations): Promise<void> {
    if (this.stopping) return;
    const poolId = readySparePoolKey(key);
    const listed = await operations.list();
    if (this.stopping || (this.inFlightClaims.get(poolId) ?? 0) > 0) return;
    const keep = listed.filter(spare => spare.labels.owner === `paperclip:${key.companyId}`
      && spare.labels.environment === key.environmentId && spare.labels.purpose === "spare"
      && spare.labels.configHash === key.configHash
      && spare.name === `paperclip-spare:ready:${key.configHash}`
      && (spare.state === "ready" || spare.state === "idle"));
    const eligible = keep.filter(spare => !this.claiming.has(spare.id) && !this.stoppingSpares.has(spare.id));
    const target = Math.max(0, Math.min(MAX_READY_SPARES, Math.trunc(desired)));
    const selected = eligible.slice(0, target);
    for (const surplus of eligible.slice(selected.length)) {
      if (this.stopping) return;
      let current: ReadySpare | undefined;
      try { current = await operations.get(surplus); }
      catch { continue; } // Unknown provider state is never a reason to stop a spare.
      if (this.stopping) return;
      if (current?.id !== surplus.id || current.labels.owner !== `paperclip:${key.companyId}`
        || current.labels.environment !== key.environmentId || current.labels.purpose !== "spare"
        || current.labels.configHash !== key.configHash
        || current.name !== `paperclip-spare:ready:${key.configHash}`
        || (current.state !== "ready" && current.state !== "idle") || this.claiming.has(surplus.id)) continue;
      if (!await this.stopSpare(key, current, operations, { surplusOf: target })) selected.push(current);
    }
    this.commitPool(poolId, selected, listed);
  }

  /** Re-discover, adopt healthy owned spares, stop stale owned spares, then fill to N. */
  async reconcile(key: ReadySpareKey, desired: number, operations: ReadySpareOperations, strictBoatOnly = false): Promise<void> {
    if (this.stopping) return;
    const poolId = readySparePoolKey(key);
    const boundedDesired = Math.max(0, Math.min(MAX_READY_SPARES, Math.trunc(desired)));
    const active = this.reconciling.get(poolId);
    if (active) {
      const pending = this.pendingReconciliations.get(poolId);
      if (strictBoatOnly || boundedDesired !== this.activeDesired.get(poolId) || pending) {
        this.pendingReconciliations.set(poolId, { key, desired: boundedDesired, operations, strictBoatOnly });
      }
      return active;
    }
    const work = (async () => {
      let next: { key: ReadySpareKey; desired: number; operations: ReadySpareOperations; strictBoatOnly?: boolean } | undefined = { key, desired: boundedDesired, operations, strictBoatOnly };
      let lastError: unknown;
      while (next) {
        this.activeDesired.set(poolId, next.desired);
        try { await this.reconcileOnce(next.key, next.desired, next.operations, next.strictBoatOnly === true); }
        catch (error) { lastError = error; }
        next = this.pendingReconciliations.get(poolId);
        this.pendingReconciliations.delete(poolId);
      }
      if (lastError) throw lastError;
    })();
    this.reconciling.set(poolId, work);
    try { await work; }
    finally {
      if (this.reconciling.get(poolId) === work) this.reconciling.delete(poolId);
      this.activeDesired.delete(poolId);
      this.pendingReconciliations.delete(poolId);
    }
  }

  private async reconcileOnce(key: ReadySpareKey, desired: number, operations: ReadySpareOperations, strictBoatOnly = false): Promise<void> {
    if (this.stopping) return;
    const poolId = readySparePoolKey(key);
    const listed = await operations.list();
    if (this.stopping) return;
    const keep: ReadySpare[] = [];
    const toStop: ReadySpare[] = [];
    for (const spare of listed) {
      if (spare.labels.owner !== `paperclip:${key.companyId}` || spare.labels.environment !== key.environmentId || spare.labels.purpose !== "spare") continue;
      // An in-flight local claim may not have reached Boat's durable marker yet.
      // Never race a reconcile into stopping or re-adopting it.
      if (this.claiming.has(spare.id) || this.stoppingSpares.has(spare.id) || spare.name.startsWith("paperclip-claim:")) continue;
      if (strictBoatOnly && (spare.labels.configHash !== key.configHash
          || spare.name !== `paperclip-spare:ready:${key.configHash}`
          || (spare.state !== "ready" && spare.state !== "idle"))) continue;
      if (readyAndHealthy(spare, key, this.now())) keep.push(spare);
      else if (!strictBoatOnly) toStop.push(spare);
    }
    for (const stale of toStop) {
      if (this.stopping) return;
      await this.stopSpare(key, stale, operations, { maybeRefill: true });
    }
    if (this.stopping) return;

    // Preserve any concurrently warming local candidates which are not yet in
    // the provider list's eventual-consistency window.
    const local = this.pools.get(poolId) ?? [];
    if (!strictBoatOnly) for (const spare of local) {
      if (readyAndHealthy(spare, key, this.now()) && !keep.some(item => item.id === spare.id)) keep.push(spare);
    }
    const selected = keep.slice(0, desired);
    for (const surplus of keep.slice(desired)) {
      if (!strictBoatOnly) {
        if (!await this.stopSpare(key, surplus, operations, { surplusOf: desired })) selected.push(surplus);
        continue;
      }
      if (this.stopping) return;
      let current: ReadySpare | undefined;
      try { current = await operations.get(surplus); } catch { continue; }
      if (current?.id === surplus.id && current.labels.owner === `paperclip:${key.companyId}`
          && current.labels.environment === key.environmentId && current.labels.purpose === "spare"
          && current.labels.configHash === key.configHash && current.name === `paperclip-spare:ready:${key.configHash}`
          && (current.state === "ready" || current.state === "idle") && !this.claiming.has(surplus.id)) {
        if (!await this.stopSpare(key, current, operations, { surplusOf: desired })) selected.push(current);
      }
    }
    if (selected.length) this.pools.set(poolId, selected);
    else this.pools.delete(poolId);
    if (desired === 0 || this.stopping) return;

    const missing = Math.max(0, desired - selected.length - (this.inFlightCreates.get(poolId) ?? 0));
    if (missing === 0) return;
    const failure = this.failures.get(poolId);
    if (failure && this.now() < failure.retryAt) return;

    // Reserve all permitted starts before launching them. The resulting create
    // fan-out is at most the target (missing <= desired), while company-wide
    // hourly reservations still serialize the quota decision across pools.
    const reservations: string[] = [];
    const scope = { companyId: key.companyId, environmentId: key.environmentId, kind: "spare" as const };
    for (let i = 0; i < missing; i++) {
      if (this.stopping || this.now() < (this.failures.get(poolId)?.retryAt ?? 0)) break;
      const local = this.createCounts(key.companyId);
      const ceiling = this.createCeiling(key.companyId);
      // The ceiling counts every create, used or not; the churn cap counts only
      // spare creates no proven use offsets. Instant releases and failed claim
      // verifications never produce a proof of use, so they stay counted.
      if (local.allCreates >= ceiling) { this.refuse(poolId, scope, "ceiling", "local", local); break; }
      if (local.churnCreates >= this.maxCreatesPerHour) { this.refuse(poolId, scope, "churn_cap", "local", local); break; }
      const recent = this.windowed(this.recentCreates, key.companyId);
      const reservation = randomUUID();
      recent.set(reservation, this.now());
      if (operations.allowCreate) {
        let verdict: boolean | { recentSpareCreates: number } = false;
        let known = true;
        try { verdict = await operations.allowCreate(); } catch { known = false; }
        if (this.stopping || !known) { recent.delete(reservation); break; } // Unknown inventory fails closed, but is not a cap.
        if (verdict === false) {
          recent.delete(reservation);
          this.refuse(poolId, scope, "churn_cap", "provider", this.createCounts(key.companyId));
          break;
        }
        if (typeof verdict === "object" && verdict !== null) {
          // Boat's inventory survives restarts and other workers' creates; it
          // does not yet hold this reservation. Credits are this worker's.
          const counts = this.createCounts(key.companyId);
          const providerSpare = Number.isFinite(verdict.recentSpareCreates) ? Math.max(0, Math.trunc(verdict.recentSpareCreates)) : Number.POSITIVE_INFINITY;
          const providerChurn = Math.max(0, providerSpare - counts.usedCredits);
          const providerAll = providerSpare + counts.runCreates;
          const reason: CreateCapReason | undefined = providerAll >= ceiling ? "ceiling" : providerChurn >= this.maxCreatesPerHour ? "churn_cap" : undefined;
          if (reason) {
            recent.delete(reservation);
            this.refuse(poolId, scope, reason, "provider", this.createCounts(key.companyId), providerChurn, providerAll);
            break;
          }
        }
      }
      if (this.stopping) { recent.delete(reservation); break; }
      this.capped.delete(poolId);
      reservations.push(reservation);
    }
    if (!reservations.length) return;
    this.inFlightCreates.set(poolId, (this.inFlightCreates.get(poolId) ?? 0) + reservations.length);
    try {
      const results = await Promise.allSettled(reservations.map(async () => {
        try {
          const spare = await operations.create(key);
          const pending = this.pendingReconciliations.get(poolId);
          const effectiveDesired = pending?.desired ?? this.activeDesired.get(poolId) ?? desired;
          const current = this.pools.get(poolId) ?? [];
          if (this.stopping || current.length >= effectiveDesired) {
            // A refill that a newer event still wants keeps its claim-index entry.
            if (await this.stopSpare(key, spare, operations, { surplusOf: current.length >= effectiveDesired ? effectiveDesired : 0 }) || this.stopping) return;
          }
          if (!readyAndHealthy(spare, key, this.now())) {
            await this.stopSpare(key, spare, operations);
            throw new Error("Boat spare create did not return a warmed running sandbox");
          }
          const next = this.pools.get(poolId) ?? [];
          if (!next.some(item => item.id === spare.id)) next.push(spare);
          this.pools.set(poolId, next);
          if (operations.warmUp) void operations.warmUp(spare).catch(() => undefined);
        } catch (error) {
          // The start attempt counts against the hourly cap even when Boat or
          // warm-up fails; exponential backoff prevents immediate retry loops.
          const count = (this.failures.get(poolId)?.count ?? 0) + 1;
          this.failures.set(poolId, { count, retryAt: this.now() + Math.min(15 * 60_000, 1000 * 2 ** Math.min(count - 1, 10)) });
          throw error;
        }
      }));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      this.failures.delete(poolId);
    } finally {
      const remaining = (this.inFlightCreates.get(poolId) ?? reservations.length) - reservations.length;
      if (remaining > 0) this.inFlightCreates.set(poolId, remaining);
      else this.inFlightCreates.delete(poolId);
    }
  }

  /** Timer refreshes only boxes freshly confirmed by Boat as named ready/idle spares. */
  async refreshDueTimer(ttlSeconds: number, operationSource: (key: ReadySpareKey) => ReadySpareOperations | undefined): Promise<void> {
    if (this.stopping) return;
    for (const [poolId, pool] of this.pools) {
      if (this.stopping) return;
      const representative = pool[0];
      if (!representative) { this.pools.delete(poolId); continue; }
      const operations = operationSource(representative.key);
      if (!operations) continue;
      let listed: ReadySpare[];
      try { listed = await operations.list(); } catch { continue; }
      for (const spare of [...pool]) {
        const current = listed.find(item => item.id === spare.id);
        if (!current || current.name !== `paperclip-spare:ready:${spare.key.configHash}`
            || (current.state !== "ready" && current.state !== "idle")) {
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool.splice(index, 1);
          continue;
        }
        const spareTtl = spare.ttlSeconds ?? ttlSeconds;
        if (Date.parse(spare.expiresAt) > this.now() + spareTtl * 500) continue;
        try {
          const refreshed = await operations.refresh(current, spareTtl);
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool[index] = refreshed;
        } catch {
          // A failed timer refresh is not proof that this is safe to stop; Boat TTL is the fallback.
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool.splice(index, 1);
        }
      }
      if (pool.length) this.pools.set(poolId, pool);
      else this.pools.delete(poolId);
    }
  }

  /** Refresh only near-expiry live candidates. Failed refreshes make them unclaimable. */
  async refreshDue(ttlSeconds: number, operationSource: ReadySpareOperations | ((key: ReadySpareKey) => ReadySpareOperations | undefined)): Promise<void> {
    if (this.stopping) return;
    for (const [poolId, pool] of this.pools) {
      if (this.stopping) return;
      const representative = pool[0];
      if (!representative) { this.pools.delete(poolId); continue; }
      const operations = typeof operationSource === "function" ? operationSource(representative.key) : operationSource;
      if (!operations) continue;
      for (const spare of [...pool]) {
        const spareTtl = spare.ttlSeconds ?? ttlSeconds;
        const spareThreshold = this.now() + spareTtl * 500;
        if (!readyAndHealthy(spare, spare.key, this.now())) {
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool.splice(index, 1);
          try { await this.stopSpare(spare.key, spare, operations); } catch { /* Expired Boat TTL is the final stop boundary. */ }
          continue;
        }
        if (Date.parse(spare.expiresAt) > spareThreshold) continue;
        try {
          const refreshed = await operations.refresh(spare, spareTtl);
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool[index] = refreshed;
        } catch {
          const index = pool.findIndex(item => item.id === spare.id);
          if (index >= 0) pool.splice(index, 1);
          try { await this.stopSpare(spare.key, spare, operations); } catch { /* Boat TTL remains the crash-safe stop. */ }
        }
      }
      if (pool.length) this.pools.set(poolId, pool);
      else this.pools.delete(poolId);
    }
  }
}
