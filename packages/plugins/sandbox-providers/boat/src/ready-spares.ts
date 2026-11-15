import { createHash, randomUUID } from "node:crypto";

export const MAX_READY_SPARES = 5;
export const MAX_CONFIGURED_READY_SPARES = 3;
export const MAX_READY_SPARE_CREATES_PER_HOUR = 12;
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
  create(key: ReadySpareKey): Promise<ReadySpare>;
  claim(spare: ReadySpare, claimName: string, ttlSeconds: number): Promise<boolean>;
  refresh(spare: ReadySpare, ttlSeconds: number): Promise<ReadySpare>;
  stop(spare: ReadySpare): Promise<void>;
  /** Optional provider-side hourly cap check; fail closed on an unknown result. */
  allowCreate?(): Promise<boolean>;
};

export type ReadySpareClaimStore = {
  reserve(spare: ReadySpare, claimToken: string, runId: string): Promise<boolean>;
  hasClaim(providerLeaseId: string): Promise<boolean>;
};

export type ReadySpareClaimResult =
  | { outcome: "spare"; spare: ReadySpare }
  | { outcome: "cold"; reason: "no_ready_spare" | "refill_in_flight" | "config_mismatch" | "claim_conflict" };

export type ReadySpareClaimDatabase = {
  namespace: string;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
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
    async hasClaim(providerLeaseId) {
      const rows = await db.query(
        `SELECT provider_lease_id FROM ${table} WHERE provider_lease_id = $1 LIMIT 1`,
        [providerLeaseId],
      );
      return rows.length > 0;
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
  private readonly pendingReconciliations = new Map<string, { key: ReadySpareKey; desired: number; operations: ReadySpareOperations }>();
  private readonly adopting = new Map<string, Promise<void>>();
  private readonly claiming = new Set<string>();
  private readonly inFlightClaims = new Map<string, number>();
  private readonly recentCreates = new Map<string, Map<string, number>>();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly demandEvents = new Map<string, number[]>();
  private stopping = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxCreatesPerHour = MAX_READY_SPARE_CREATES_PER_HOUR,
    private claimStore?: ReadySpareClaimStore,
  ) {}

  setClaimStore(claimStore: ReadySpareClaimStore | undefined): void { this.claimStore = claimStore; }
  start(): void { this.stopping = false; }
  stop(): void { this.stopping = true; }
  reset(): void {
    this.stop();
    this.claimStore = undefined;
    this.pools.clear(); this.inFlightCreates.clear(); this.reconciling.clear(); this.activeDesired.clear();
    this.pendingReconciliations.clear(); this.adopting.clear(); this.claiming.clear(); this.inFlightClaims.clear(); this.recentCreates.clear(); this.failures.clear(); this.demandEvents.clear();
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
    return this.reconciling.has(poolId) || this.adopting.has(poolId) || (this.inFlightCreates.get(poolId) ?? 0) > 0;
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
      if (this.claiming.has(spare.id) || spare.name.startsWith("paperclip-claim:")) continue;
      if (this.claimStore) {
        try { if (await this.claimStore.hasClaim(spare.id)) continue; }
        catch { continue; } // Unknown claim state is reserved, never adopted or retired.
      }
      if (readyAndHealthy(spare, key, this.now())) keep.push(spare);
      else await operations.stop(spare);
    }
    if (keep.length) this.pools.set(poolId, keep);
    else this.pools.delete(poolId);
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
    const index = pool.findIndex(spare => !this.claiming.has(spare.id) && readyAndHealthy(spare, key, now));
    if (index < 0) {
      if (healthy.length || (this.inFlightClaims.get(poolId) ?? 0) > 0) return { outcome: "cold", reason: "claim_conflict" };
      if (this.hasConfigMismatch(key)) return { outcome: "cold", reason: "config_mismatch" };
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

  /** Re-discover, adopt healthy owned spares, stop stale owned spares, then fill to N. */
  async reconcile(key: ReadySpareKey, desired: number, operations: ReadySpareOperations): Promise<void> {
    if (this.stopping) return;
    const poolId = readySparePoolKey(key);
    const boundedDesired = Math.max(0, Math.min(MAX_READY_SPARES, Math.trunc(desired)));
    const active = this.reconciling.get(poolId);
    if (active) {
      const pending = this.pendingReconciliations.get(poolId);
      if (boundedDesired !== this.activeDesired.get(poolId) || pending) {
        this.pendingReconciliations.set(poolId, { key, desired: boundedDesired, operations });
      }
      return active;
    }
    const work = (async () => {
      let next: { key: ReadySpareKey; desired: number; operations: ReadySpareOperations } | undefined = { key, desired: boundedDesired, operations };
      let lastError: unknown;
      while (next) {
        this.activeDesired.set(poolId, next.desired);
        try { await this.reconcileOnce(next.key, next.desired, next.operations); }
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

  private async reconcileOnce(key: ReadySpareKey, desired: number, operations: ReadySpareOperations): Promise<void> {
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
      if (this.claiming.has(spare.id) || spare.name.startsWith("paperclip-claim:")) continue;
      if (this.claimStore) {
        try { if (await this.claimStore.hasClaim(spare.id)) continue; }
        catch { continue; } // Unknown claim state is reserved, never adopted or retired.
      }
      if (readyAndHealthy(spare, key, this.now())) keep.push(spare);
      else toStop.push(spare);
    }
    for (const stale of toStop) {
      if (this.stopping) return;
      await operations.stop(stale);
    }
    if (this.stopping) return;

    // Preserve any concurrently warming local candidates which are not yet in
    // the provider list's eventual-consistency window.
    const local = this.pools.get(poolId) ?? [];
    for (const spare of local) {
      if (readyAndHealthy(spare, key, this.now()) && !keep.some(item => item.id === spare.id)) keep.push(spare);
    }
    const selected = keep.slice(0, desired);
    for (const surplus of keep.slice(desired)) await operations.stop(surplus);
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
    for (let i = 0; i < missing; i++) {
      if (this.stopping || this.now() < (this.failures.get(poolId)?.retryAt ?? 0)) break;
      const recent = this.recentCreates.get(key.companyId) ?? new Map<string, number>();
      for (const [token, at] of recent) if (this.now() - at >= 60 * 60 * 1000) recent.delete(token);
      this.recentCreates.set(key.companyId, recent);
      if (recent.size >= this.maxCreatesPerHour) break;
      const reservation = randomUUID();
      recent.set(reservation, this.now());
      if (operations.allowCreate) {
        let allowed = false;
        try { allowed = await operations.allowCreate(); } catch { allowed = false; }
        if (!allowed || this.stopping) { recent.delete(reservation); break; }
      }
      if (this.stopping) { recent.delete(reservation); break; }
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
          if (this.stopping || current.length >= effectiveDesired) { await operations.stop(spare); return; }
          if (!readyAndHealthy(spare, key, this.now())) {
            await operations.stop(spare);
            throw new Error("Boat spare create did not return a warmed running sandbox");
          }
          const next = this.pools.get(poolId) ?? [];
          if (!next.some(item => item.id === spare.id)) next.push(spare);
          this.pools.set(poolId, next);
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
          try { await operations.stop(spare); } catch { /* Expired Boat TTL is the final stop boundary. */ }
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
          try { await operations.stop(spare); } catch { /* Boat TTL remains the crash-safe stop. */ }
        }
      }
      if (pool.length) this.pools.set(poolId, pool);
      else this.pools.delete(poolId);
    }
  }
}
