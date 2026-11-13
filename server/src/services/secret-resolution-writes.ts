import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, inArray, isNull, lt, or } from "drizzle-orm";
import { companies, companySecrets, heartbeatRuns, issues, plugins, secretAccessEvents, userSecretDefinitions, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { beginIdleTrackedWork } from "./task-admission.js";
import { createWorkScheduler } from "./work-scheduler.js";

type AccessEvent = typeof secretAccessEvents.$inferInsert;
const DEBOUNCE_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_FAILED_AUDIT_FLUSHES = 5;
const MAX_PENDING_RECORDS = 10_000;
const scheduler = createWorkScheduler();
const states = new WeakMap<Db, State>();
const pending = new Set<State>();
type State = {
  db: Db;
  key: string;
  events: AccessEvent[];
  failedAuditBatch?: { records: AccessEvent[]; failures: number };
  touches: Map<string, Date>;
  touchedUntil: Map<string, number>;
  running: Promise<void> | null;
  finish?: () => void;
  drainWaiters?: Set<() => void>;
  capacityWaiters?: Set<() => void>;
};
function stateFor(db: Db): State {
  let state = states.get(db);
  if (!state) {
    state = { db, key: randomUUID(), events: [], touches: new Map(), touchedUntil: new Map(), running: null };
    states.set(db, state);
  }
  return state;
}
function schedule(state: State, delay = 1000) {
  if (!pending.has(state)) {
    pending.add(state);
    state.finish = beginIdleTrackedWork();
    scheduler.schedule(state.key, Date.now() + delay, () => { void flush(state).catch(() => {}); });
  } else if (delay === 0) {
    scheduler.schedule(state.key, Date.now(), () => { void flush(state).catch(() => {}); });
  }
}

function pendingCount(state: State) {
  // In-flight batches remain in these collections until their writes succeed.
  return state.events.length + state.touches.size;
}
function releaseCapacity(state: State) {
  for (const resolve of state.capacityWaiters ?? []) resolve();
  state.capacityWaiters?.clear();
}
function waitForCapacity(state: State): Promise<void> {
  schedule(state);
  return new Promise(resolve => { (state.capacityWaiters ??= new Set()).add(resolve); });
}

/** No plaintext enters this queue. One UUID per resolution makes uncertain INSERT retries idempotent.
 * Only overload awaits capacity; persistent audit failures receive an explicit dead-letter disposition.
 */
export async function enqueueSecretAccessEvent(db: Db, event: AccessEvent) {
  const state = stateFor(db);
  const createdAt = new Date();
  while (pendingCount(state) >= MAX_PENDING_RECORDS) await waitForCapacity(state);
  state.events.push({ ...event, id: randomUUID(), createdAt });
  schedule(state, state.events.length >= BATCH_SIZE ? 0 : 1000);
}

/** Advisory usage metadata, not a secret mutation: never advance updatedAt. */
export async function enqueueSecretLastResolvedAt(db: Db, secret: { id: string; lastResolvedAt: Date | null }) {
  const state = stateFor(db);
  const now = Date.now();
  const alreadyTouched = () => (state.touchedUntil.get(secret.id) ?? 0) > now || (secret.lastResolvedAt?.getTime() ?? 0) > now - DEBOUNCE_MS;
  if (alreadyTouched()) return;
  while (pendingCount(state) >= MAX_PENDING_RECORDS) {
    await waitForCapacity(state);
    if (alreadyTouched()) return;
  }
  // Bound the advisory debounce cache. SQL still guards every eventual write.
  if (state.touchedUntil.size >= 10_000) {
    for (const [id, until] of state.touchedUntil) if (until <= now) state.touchedUntil.delete(id);
    if (state.touchedUntil.size >= 10_000) state.touchedUntil.delete(state.touchedUntil.keys().next().value!);
  }
  state.touchedUntil.set(secret.id, now + DEBOUNCE_MS);
  state.touches.set(secret.id, new Date(now));
  schedule(state);
}

async function retryOnce(write: () => Promise<unknown>, kind: string) {
  try { await write(); }
  catch {
    // Provider/SQL errors may contain credentials. Log only queue metadata.
    logger.warn({ kind }, "Secret resolution write failed; retrying once");
    try { await write(); }
    catch {
      logger.error({ kind }, "Secret resolution write retry failed; retaining pending records");
      throw new Error(`Secret resolution ${kind} write failed`);
    }
  }
}
function isForeignKeyViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && error.code === "23503") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}

async function insertAuditBatch(db: Db, batch: AccessEvent[]) {
  try {
    await db.insert(secretAccessEvents).values(batch).onConflictDoNothing({ target: secretAccessEvents.id });
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error;
    // ON DELETE cannot repair references still in memory. Recover only on FK
    // failure, keeping the normal warm batch to one INSERT and preserving IDs.
    const droppedCount = await db.transaction(async tx => {
      // Tenant scope is mandatory. Company deletion already removes its audits;
      // discard only that tenant's deferred events, never reassign their scope.
      const companyIds = [...new Set(batch.map(event => event.companyId))].sort();
      const companyRows = await tx.select({ id: companies.id }).from(companies)
        .where(inArray(companies.id, companyIds)).orderBy(companies.id);
      const existingCompanies = new Set(companyRows.map(row => row.id));
      let normalized = batch.filter(event => existingCompanies.has(event.companyId));
      const dropped = batch.length - normalized.length;
      const references = [
        ["secretId", companySecrets],
        ["userSecretDefinitionId", userSecretDefinitions],
        ["issueId", issues],
        ["heartbeatRunId", heartbeatRuns],
        ["pluginId", plugins],
      ] as const;
      for (const [field, table] of references) {
        const ids = [...new Set(normalized.map(event => event[field]).filter((id): id is string => typeof id === "string"))].sort();
        if (!ids.length) continue;
        // Key-share locks close the check/INSERT deletion race. Deterministic
        // order also keeps concurrent recovery batches' lock order consistent.
        const rows = await tx.select({ id: table.id }).from(table)
          .where(inArray(table.id, ids)).orderBy(table.id).for("key share");
        const existing = new Set(rows.map(row => row.id));
        normalized = normalized.map(event => ({
          ...event,
          [field]: event[field] && existing.has(event[field]) ? event[field] : null,
        }));
      }
      if (normalized.length) {
        await tx.insert(secretAccessEvents).values(normalized).onConflictDoNothing({ target: secretAccessEvents.id });
      }
      return dropped;
    });
    if (droppedCount) {
      logger.warn({ kind: "audit", droppedCount }, "Dropped secret audit events for deleted companies");
    }
  }
}

function flush(state: State): Promise<void> {
  if (state.running) return state.running;
  scheduler.cancel(state.key);
  state.running = (async () => {
    while (state.events.length || state.touches.size) {
      // Freeze a failed batch: later arrivals cannot reset its retry budget or
      // become collateral dead letters, even if the original batch was short.
      if (state.events.length) {
        const attempt = state.failedAuditBatch ??= { records: state.events.slice(0, BATCH_SIZE), failures: 0 };
        const batch = attempt.records;
        try {
          await retryOnce(() => insertAuditBatch(state.db, batch), "audit");
        } catch (error) {
          if (++attempt.failures < MAX_FAILED_AUDIT_FLUSHES) throw error;
          // Only known value-free audit columns enter the dead letter, never
          // arbitrary properties or raw SQL/provider errors. Preserve IDs for
          // reconciliation, including an uncertain commit at the retry limit.
          const fields = Object.keys(getTableColumns(secretAccessEvents)) as Array<keyof AccessEvent>;
          logger.error({ kind: "audit", count: batch.length, failedFlushes: attempt.failures,
            eventIds: batch.map(event => event.id),
            records: batch.map(event => Object.fromEntries(fields.map(field => [field, event[field]]))),
          }, "Secret audit batch dead-lettered after bounded retries");
        }
        state.events.splice(0, batch.length);
        state.failedAuditBatch = undefined;
        releaseCapacity(state);
      }
      for (const [id, at] of state.touches) {
        await retryOnce(async () => state.db.update(companySecrets).set({ lastResolvedAt: at }).where(and(
          eq(companySecrets.id, id),
          or(isNull(companySecrets.lastResolvedAt), lt(companySecrets.lastResolvedAt, new Date(at.getTime() - DEBOUNCE_MS))),
        )), "usage");
        if (state.touches.get(id) === at) state.touches.delete(id);
        releaseCapacity(state);
      }
    }
  })().finally(() => {
    state.running = null;
    if (state.events.length || state.touches.size) {
      // Only unresolved obligations rearm the deadline; an empty queue is quiet.
      scheduler.schedule(state.key, Date.now() + 1000, () => { void flush(state).catch(() => {}); });
    } else {
      scheduler.cancel(state.key);
      pending.delete(state);
      state.finish?.();
      state.finish = undefined;
      for (const resolve of state.drainWaiters ?? []) resolve();
      state.drainWaiters?.clear();
    }
  });
  return state.running;
}

/** Call after producers drain and before DB shutdown; failures retain records and reject. */
export async function flushSecretResolutionWrites(db?: Db): Promise<void> {
  if (db) {
    const state = states.get(db);
    if (state) await flush(state);
    return;
  }
  while (pending.size) await Promise.all(Array.from(pending, flush));
}

/** Shutdown must not report success or close the pool while audit records remain queued.
 * Failed batches use their existing retry deadline; no polling or extra timer.
 * Audit batches settle by persistence or bounded dead-letter; usage touches await recovery.
 */
export async function drainSecretResolutionWrites(): Promise<void> {
  scheduler.setKeepAlive(true);
  try {
    while (pending.size) {
      await Promise.all(Array.from(pending, state => new Promise<void>(resolve => {
        (state.drainWaiters ??= new Set()).add(resolve);
        void flush(state).catch(() => {});
      })));
    }
  } finally {
    scheduler.setKeepAlive(false);
  }
}
