import { createHash } from "node:crypto";

export const MAX_READY_SPARES = 3;
export const MAX_READY_SPARE_CREATES_PER_HOUR = 12;
export const READY_SPARE_TTL_SECONDS = 1_800;

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
  name: string;
  labels: Record<string, string>;
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
  return Number.isInteger(count) && Number(count) >= 0 && Number(count) <= MAX_READY_SPARES ? Number(count) : 0;
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
  private readonly claiming = new Set<string>();
  private readonly recentCreates = new Map<string, number[]>();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxCreatesPerHour = MAX_READY_SPARE_CREATES_PER_HOUR,
  ) {}

  ready(key: ReadySpareKey): readonly ReadySpare[] {
    return [...(this.pools.get(readySparePoolKey(key)) ?? [])];
  }

  /**
   * Claim only a warmed, running, unexpired exact-key spare already in memory.
   * The in-process reservation is committed before the network PATCH, so
   * concurrent acquires cannot reserve the same ID. Errors are a cache miss:
   * callers can immediately take the ordinary create path.
   */
  async claim(key: ReadySpareKey, attemptId: string, ttlSeconds: number, operations: ReadySpareOperations): Promise<ReadySpare | undefined> {
    const poolId = readySparePoolKey(key);
    const pool = this.pools.get(poolId) ?? [];
    const now = this.now();
    const index = pool.findIndex(spare => !this.claiming.has(spare.id) && readyAndHealthy(spare, key, now));
    if (index < 0) return undefined;
    const [spare] = pool.splice(index, 1);
    this.claiming.add(spare.id);
    try {
      const claimed = await operations.claim(spare, `paperclip-claim:${attemptId}`, ttlSeconds);
      return claimed ? spare : undefined;
    } catch {
      return undefined;
    } finally {
      this.claiming.delete(spare.id);
      if (pool.length) this.pools.set(poolId, pool);
      else this.pools.delete(poolId);
    }
  }

  /** Re-discover, adopt healthy owned spares, stop stale owned spares, then fill to N. */
  async reconcile(key: ReadySpareKey, desired: number, operations: ReadySpareOperations): Promise<void> {
    const poolId = readySparePoolKey(key);
    const active = this.reconciling.get(poolId);
    if (active) return active;
    const work = this.reconcileOnce(key, Math.max(0, Math.min(MAX_READY_SPARES, Math.trunc(desired))), operations);
    this.reconciling.set(poolId, work);
    try { await work; }
    finally { if (this.reconciling.get(poolId) === work) this.reconciling.delete(poolId); }
  }

  private async reconcileOnce(key: ReadySpareKey, desired: number, operations: ReadySpareOperations): Promise<void> {
    const poolId = readySparePoolKey(key);
    const listed = await operations.list();
    const keep: ReadySpare[] = [];
    const toStop: ReadySpare[] = [];
    for (const spare of listed) {
      if (spare.labels.owner !== `paperclip:${key.companyId}` || spare.labels.environment !== key.environmentId || spare.labels.purpose !== "spare") continue;
      // A claim name is a durable handoff marker. Never stop a sandbox already
      // handed to a run, even though Boat's immutable spare labels remain.
      if (spare.name.startsWith("paperclip-claim:")) continue;
      if (readyAndHealthy(spare, key, this.now())) keep.push(spare);
      else if (spare.name.startsWith("paperclip-spare:")) toStop.push(spare);
    }
    for (const stale of toStop) await operations.stop(stale);

    // Preserve any concurrently warming local candidates which are not yet in
    // the provider list's eventual-consistency window.
    const local = this.pools.get(poolId) ?? [];
    for (const spare of local) {
      if (readyAndHealthy(spare, key, this.now()) && !keep.some(item => item.id === spare.id)) keep.push(spare);
    }
    const selected = keep.slice(0, desired);
    for (const surplus of keep.slice(desired)) await operations.stop(surplus);
    this.pools.set(poolId, selected);
    if (desired === 0) return;

    const missing = Math.max(0, desired - selected.length - (this.inFlightCreates.get(poolId) ?? 0));
    if (missing === 0) return;
    const failure = this.failures.get(poolId);
    if (failure && this.now() < failure.retryAt) return;
    const recent = (this.recentCreates.get(key.companyId) ?? []).filter(at => this.now() - at < 60 * 60 * 1000);
    this.recentCreates.set(key.companyId, recent);
    if (recent.length >= this.maxCreatesPerHour) return;
    if (operations.allowCreate && !(await operations.allowCreate())) return;

    // One create per key is in flight at a time. Reserve before awaiting the
    // provider to prevent another reconcile call from overfilling the pool.
    this.inFlightCreates.set(poolId, (this.inFlightCreates.get(poolId) ?? 0) + 1);
    try {
      for (let i = 0; i < missing; i++) {
        if (this.now() < (this.failures.get(poolId)?.retryAt ?? 0)) break;
        const current = this.pools.get(poolId) ?? [];
        if (current.length + (this.inFlightCreates.get(poolId) ?? 0) > desired) break;
        recent.push(this.now());
        this.recentCreates.set(key.companyId, recent);
        try {
          const spare = await operations.create(key);
          if (readyAndHealthy(spare, key, this.now())) {
            const next = this.pools.get(poolId) ?? [];
            if (!next.some(item => item.id === spare.id)) next.push(spare);
            this.pools.set(poolId, next);
            this.failures.delete(poolId);
          } else {
            await operations.stop(spare);
            throw new Error("Boat spare create did not return a warmed running sandbox");
          }
        } catch (error) {
          recent.pop();
          const count = (this.failures.get(poolId)?.count ?? 0) + 1;
          this.failures.set(poolId, { count, retryAt: this.now() + Math.min(15 * 60_000, 1000 * 2 ** Math.min(count - 1, 10)) });
          throw error;
        }
      }
    } finally {
      const remaining = (this.inFlightCreates.get(poolId) ?? 1) - 1;
      if (remaining > 0) this.inFlightCreates.set(poolId, remaining);
      else this.inFlightCreates.delete(poolId);
    }
  }

  /** Refresh only near-expiry live candidates. Failed refreshes make them unclaimable. */
  async refreshDue(ttlSeconds: number, operations: ReadySpareOperations): Promise<void> {
    const threshold = this.now() + ttlSeconds * 500;
    for (const [poolId, pool] of this.pools) {
      for (const spare of [...pool]) {
        if (!readyAndHealthy(spare, spare.key, this.now()) || Date.parse(spare.expiresAt) > threshold) continue;
        try {
          const refreshed = await operations.refresh(spare, ttlSeconds);
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
