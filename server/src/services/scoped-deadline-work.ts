import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DeadlineReconciliationSnapshot } from "./deadline-reconciliation.js";
import { takeCompanyWorkBatch } from "./company-work-batch.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "./delivery-work-notifications.js";
import { logger } from "../middleware/logger.js";

// TEMP: one async context per dispatched check, including owner SQL/transactions.
export const recoveryCheckDiagnostic = new AsyncLocalStorage<{
  sqlMs: number; queries: number; slowestSqlMs: number; slowestQuery: string | null;
  outcome: string; pendingDeadline?: number; effects?: Record<string, number>;
}>();
let diagnosticWindowAt = -Infinity, diagnosticLines = 0;
function logDiagnostic(fields: Record<string, unknown>) {
  try {
    const now = Date.now();
    if (now < diagnosticWindowAt || now - diagnosticWindowAt >= 60_000) { diagnosticWindowAt = now; diagnosticLines = 0; }
    if (diagnosticLines >= 200) return;
    diagnosticLines++;
    logger.info(fields, "[recovery-diag]");
  } catch { /* Diagnostics must not change recovery. */ }
}

// TEMP gate-only diagnostics. No timers, queries, or scheduling decisions.
export type RecoveryDiagnosticCanRun = (() => boolean) & {
  recoveryDiagnostics?: () => Record<string, unknown>;
};
const recoveryQueues: ReadonlySet<DeliveryQueue> = new Set([
  DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.orphanBlockers,
  DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.resolvedDependencies,
  DELIVERY_QUEUES.staleIssueLocks, DELIVERY_QUEUES.taskWatchdogs, DELIVERY_QUEUES.assignedWorkInvariant,
]);
const recoveryGateObservers = new WeakMap<object, Set<(gates: Record<string, boolean | null>) => void>>();
/** The coordinator can refuse a poll before the scoped worker sees it. */
export function logRecoveryCoordinatorGate(coordinator: object, gates: Record<string, boolean | null>) {
  for (const observe of recoveryGateObservers.get(coordinator) ?? []) observe(gates);
}

type ScheduledEntry = { id: string; companyId: string; dueAt: number };

/** Coalesced scope reconstruction and fair deadline dispatch. Domain owners
 * supply persistence, eligibility, and execution; this helper owns no SQL. */
export function registerScopedDeadlineWork<Entry extends ScheduledEntry, Scope>(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  options: {
    queue: DeliveryQueue;
    batchSize?: number;
    minimumPassIntervalMs?: number;
    concurrentChecks?: {
      limit: number;
      key(entry: Entry): string | readonly string[];
      // A pass otherwise ends only after its slowest check. Owners whose checks
      // can legitimately run for minutes may let idle slots keep admitting
      // entries that become due meanwhile, so one slow resource cannot hold
      // every other resource's saved deadline until it finishes. check() must
      // revalidate each entry against durable state, because an entry admitted
      // this way is not reconstructed first.
      admitDueWhileActive?: boolean;
    };
    reconstructionIntervalMs?: number | ((scope: Scope | undefined) => number);
    beforePass?(): Promise<void>;
    diagnostics?(): Record<string, unknown>;
    decodeScope(hint: string): Scope | undefined;
    matches(entry: Entry, scope?: Scope): boolean;
    load(scope?: Scope, signal?: AbortSignal): Promise<Entry[] | { rows: Entry[] | null; complete: boolean }>;
    // Owners may retain pending queue priority while refreshing eligibility.
    mergeEntry?(pending: Entry, loaded: Entry): Entry;
    priority?(entry: Entry): number;
    check(entry: Entry, signal?: AbortSignal): Promise<Entry | null>;
    onStop?(): void;
  },
  canRun: RecoveryDiagnosticCanRun,
) {
  if (options.concurrentChecks && (!Number.isInteger(options.concurrentChecks.limit) || options.concurrentChecks.limit < 1)) {
    throw new RangeError("Concurrent check limit must be a positive integer");
  }
  const ownerRevision = randomUUID();
  let revision = 0, running = false, stopped = false, lastRunFailed = false;
  const dirty = new Set<string>(["*"]);
  const versions = new Map<string, number>();
  const scans = new Map<string, { version: number; seen: Set<string> }>();
  const entries = new Map<string, Entry>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const scopeFailures = new Map<string, { count: number; retryAt: number }>();
  const reconstructAfter = new Map<string, number>();
  let earliest = 0;
  let lastCompany: string | null = null;
  let lastDiagnosticAt = -Infinity;
  let lastCompletedPassAt: number | null = null;
  let dueEntryCount = 0, checksRunThisPass = 0;
  type Cause = "pendingDeadline" | "rearmedAfterCheck" | "freshDirtyScope" | "scopeRescan";
  const provenance = new Map<string, { cause: Cause; hintKind?: string; fromDueAt?: number; dueAt: number }>();
  const checkedIds = new Set<string>();
  let previousDue = new Set<string>();
  let passDetails: Record<string, unknown> = {};
  const hintCounts: Record<string, number> = {};
  const hintSources: Record<string, number> = {};
  const hintKind = (hint: string) => {
    if (hint === "*") return "*";
    try { return JSON.parse(hint).issueId ? "issue" : "company"; } catch { return "invalid"; }
  };
  const noteHint = (hint: string, source: string) => {
    const kind = hintKind(hint);
    hintCounts[kind] = (hintCounts[kind] ?? 0) + 1;
    hintSources[source] = (hintSources[source] ?? 0) + 1;
  };
  noteHint("*", "startup");
  function diagnostic(phase: string, extra: Record<string, unknown> = {}) {
    if (!recoveryQueues.has(options.queue)) return;
    const now = Date.now();
    if (phase !== "pass-completed" && phase !== "pass-failed" && phase !== "pass-aborted" && phase !== "pass-interrupted" && now - lastDiagnosticAt < 60_000) return;
    // Logging failure must never change recovery, including its error path.
    try {
      lastDiagnosticAt = now;
      const backoffs = (map: typeof failures, key: string) => [...map].slice(0, 25).map(([id, failure]) => ({
        [key]: id, ...failure, backoffMs: Math.max(0, failure.retryAt - now),
      }));
      logDiagnostic({ queue: options.queue, phase,
        ...canRun.recoveryDiagnostics?.(), ...options.diagnostics?.(),
        dueEntryCount, checksRunThisPass, pendingEntryCount: entries.size, dirtyScopeCount: dirty.size,
        scopeFailureCount: scopeFailures.size, entryFailureCount: failures.size,
        scopeFailures: backoffs(scopeFailures, "scope"), entryFailures: backoffs(failures, "id"),
        lastCompletedPassAgoMs: lastCompletedPassAt === null ? null : now - lastCompletedPassAt,
        ...passDetails, ...extra,
      });
    } catch { /* Diagnostic-only: retain the original scheduling and failure. */ }
  }
  const observeCoordinatorGate = (gates: Record<string, boolean | null>) =>
    diagnostic("coordinator-blocked", { ...gates, canRun: false });
  function failed(map: typeof failures, id: string) {
    const count = Math.min((map.get(id)?.count ?? 0) + 1, 5);
    map.set(id, { count, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** (count - 1)) });
  }
  function dirtyScopes() {
    return [...dirty].filter(hint => hint !== "*" || !scopeFailures.has(hint))
      .filter(hint => !scans.has(hint) || scopeFailures.has(hint))
      .filter(hint => (reconstructAfter.get(hint) ?? 0) <= Date.now() || scopeFailures.has(hint))
      .map(hint => { try { return options.decodeScope(hint); } catch { return undefined; } });
  }
  function next() {
    if (!canRun()) {
      diagnostic("poll-blocked", { canRun: false });
      return dirty.size > 0 || entries.size > 0 ? Date.now() + 30_000 : null;
    }
    let nextAt: number | null = null;
    const take = (at: number) => { nextAt = nextAt === null ? at : Math.min(nextAt, at); };
    for (const hint of dirty) take(Math.max(earliest, reconstructAfter.get(hint) ?? 0, scopeFailures.get(hint)?.retryAt ?? 0));
    const unavailable = dirtyScopes();
    for (const entry of entries.values()) if (!unavailable.some(scope => options.matches(entry, scope)))
      take(Math.max(earliest, entry.dueAt, failures.get(entry.id)?.retryAt ?? 0));
    return nextAt;
  }
  const worker = coordinator.register(options.queue, {
    retryMs: 30_000,
    pausePassiveMaintenance: true,
    onStop: () => { recoveryGateObservers.get(coordinator)?.delete(observeCoordinatorGate); stopped = true; revision++; options.onStop?.(); },
    onSettled: hints => { revision++; for (const hint of hints ?? ["*"]) {
      noteHint(hint, "onSettled (source unavailable)");
      dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    } },
    run: async signal => {
      revision++; running = true;
      let passStarted = false, passFailed = false, passCompleted = false;
      const passAt = performance.now();
      let loadMs = 0;
      let beforePassMs = 0, checkMs = 0, checkSqlMs = 0;
      let diagnosticPassId: string | null = null;
      try {
        if (!canRun()) { diagnostic("pass-blocked", { canRun: false }); return; }
        if (Date.now() < earliest) return;
        for (const [hint, until] of reconstructAfter) {
          if (until <= Date.now()) reconstructAfter.delete(hint);
        }
        const ready = [...dirty].filter(hint => Math.max(reconstructAfter.get(hint) ?? 0, scopeFailures.get(hint)?.retryAt ?? 0) <= Date.now());
        if (ready.length === 0 && ![...entries.values()].some(entry => Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())) return;
        earliest = Date.now() + (options.minimumPassIntervalMs ?? 1000);
        passStarted = true;
        dueEntryCount = 0; checksRunThisPass = 0;
        diagnosticPassId = `${ownerRevision}:${revision}`;
        passDetails = { passId: diagnosticPassId };
        const beforeAt = performance.now();
        try { await options.beforePass?.(); } catch (error) {
          for (const hint of ready) failed(scopeFailures, hint);
          for (const entry of entries.values()) if (entry.dueAt <= Date.now()) failed(failures, entry.id);
          throw error;
        } finally { beforePassMs = performance.now() - beforeAt; }
        const errors: unknown[] = [];
        const requested = ready.includes("*")
          ? ["*", ...ready.filter(hint => hint !== "*")].slice(0, 25)
          : ready.slice(0, 25);
        for (const hint of requested) dirty.delete(hint);
        for (let index = 0; index < requested.length; index++) {
          if (signal.aborted || !canRun()) { for (const hint of requested.slice(index)) dirty.add(hint); return; }
          const hint = requested[index];
          let scope: Scope | undefined;
          let decoded = false;
          try {
            scope = options.decodeScope(hint); decoded = true;
            const rescan = scans.has(hint);
            const scan = scans.get(hint) ?? { version: versions.get(hint) ?? 0, seen: new Set<string>() };
            scans.set(hint, scan);
            const loadAt = performance.now();
            let loaded: Awaited<ReturnType<typeof options.load>>;
            try { loaded = await options.load(scope, signal); }
            finally { loadMs += performance.now() - loadAt; }
            const result = Array.isArray(loaded) ? { rows: loaded, complete: true } : loaded;
            for (const entry of result.rows ?? []) {
              const pending = entries.get(entry.id);
              const merged = pending && options.mergeEntry ? options.mergeEntry(pending, entry) : entry;
              entries.set(entry.id, merged);
              if (!pending || merged.dueAt !== pending.dueAt) provenance.set(entry.id, {
                cause: pending || checkedIds.has(entry.id) ? "rearmedAfterCheck" : rescan ? "scopeRescan" : "freshDirtyScope",
                hintKind: hintKind(hint), fromDueAt: pending?.dueAt, dueAt: merged.dueAt,
              });
              for (const [other, progress] of scans) if (options.matches(entry, options.decodeScope(other))) progress.seen.add(entry.id);
            }
            if (!result.complete) { noteHint(hint, "incomplete scope re-scan"); dirty.add(hint); continue; }
            if (result.rows !== null) for (const entry of entries.values()) if (options.matches(entry, scope) && !scan.seen.has(entry.id)) {
              entries.delete(entry.id); failures.delete(entry.id); provenance.delete(entry.id);
            }
            scans.delete(hint);
            const reconstructionInterval = typeof options.reconstructionIntervalMs === "function"
              ? options.reconstructionIntervalMs(scope) : (options.reconstructionIntervalMs ?? 0);
            if (reconstructionInterval > 0) {
              reconstructAfter.set(hint, Date.now() + reconstructionInterval);
            }
            if ((versions.get(hint) ?? 0) !== scan.version) { noteHint(hint, "scope changed during scan"); dirty.add(hint); } else versions.delete(hint);
            if (!scope) scopeFailures.clear(); else scopeFailures.delete(hint);
          } catch (error) {
            const retryHint = decoded ? hint : "*";
            if (!decoded) { scans.delete(hint); versions.delete(hint); }
            noteHint(retryHint, "scope load error");
            dirty.add(retryHint); failed(scopeFailures, retryHint); errors.push(error);
          }
        }
        const unavailable = dirtyScopes();
        const due = [...entries.values()].filter(entry => !unavailable.some(scope => options.matches(entry, scope))
          && Math.max(entry.dueAt, failures.get(entry.id)?.retryAt ?? 0) <= Date.now())
          .sort((a, b) => (options.priority?.(b) ?? 0) - (options.priority?.(a) ?? 0)
            || a.dueAt - b.dueAt || a.id.localeCompare(b.id));
        dueEntryCount = due.length;
        const newlyDue = due.filter(entry => !previousDue.has(entry.id));
        const dueReasons: Record<string, number> = { pendingDeadline: 0, rearmedAfterCheck: 0, freshDirtyScope: 0, scopeRescan: 0, unknown: 0 };
        const freshDirtyHints: Record<string, number> = {};
        for (const entry of newlyDue) {
          const origin = provenance.get(entry.id);
          dueReasons[origin?.cause ?? "unknown"]++;
          if (origin?.cause === "freshDirtyScope" && origin.hintKind) freshDirtyHints[origin.hintKind] = (freshDirtyHints[origin.hintKind] ?? 0) + 1;
        }
        previousDue = new Set(due.map(entry => entry.id));
        passDetails = { passId: diagnosticPassId, newlyDueCount: newlyDue.length, dueReasons, freshDirtyHints,
          rearmHistoryLimit: 2048,
          newlyDueEntries: newlyDue.map(entry => ({ id: entry.id, companyId: entry.companyId, ...provenance.get(entry.id) })) };
        const batch = takeCompanyWorkBatch(due, options.batchSize ?? 25, lastCompany); lastCompany = batch.lastCompany;
        // An owner may share more than one resource (for example a task and an
        // endpoint). Merge intersecting keys before dispatch so waiting siblings
        // do not occupy the bounded check slots ahead of independent work.
        const parents = batch.entries.map((_, index) => index);
        const root = (index: number): number => {
          while (parents[index] !== index) index = parents[index];
          return index;
        };
        const owners = new Map<string, number>();
        for (const [index, entry] of batch.entries.entries()) {
          const configured = options.concurrentChecks?.key(entry) ?? "";
          const keys = typeof configured === "string" ? [configured] : configured;
          for (const key of keys) {
            const previous = owners.get(key);
            if (previous === undefined) owners.set(key, index);
            else parents[root(index)] = root(previous);
          }
        }
        const groups = new Map<number, Entry[]>();
        for (const [index, entry] of batch.entries.entries()) {
          const key = root(index);
          const group = groups.get(key) ?? [];
          group.push(entry); groups.set(key, group);
        }
        const pending = [...groups.values()];
        let nextGroup = 0;
        const admitDueWhileActive = options.concurrentChecks?.admitDueWhileActive === true;
        const keysOf = (entry: Entry) => {
          const configured = options.concurrentChecks?.key(entry) ?? "";
          return typeof configured === "string" ? [configured] : [...configured];
        };
        // Entries owned by this pass (queued in a group or running) and the
        // resource keys they hold. Every batch group reserves its keys until the
        // whole group finishes, so admission can neither overlap a queued
        // sibling nor jump ahead of it. Admission never overlaps either set.
        const owned = new Set(batch.entries.map(entry => entry.id));
        const busyKeys = new Map<string, number>();
        const reserve = (keys: readonly string[]) => {
          for (const key of keys) busyKeys.set(key, (busyKeys.get(key) ?? 0) + 1);
        };
        const release = (keys: readonly string[]) => {
          for (const key of keys) {
            const count = (busyKeys.get(key) ?? 1) - 1;
            if (count > 0) busyKeys.set(key, count); else busyKeys.delete(key);
          }
        };
        const groupKeys = pending.map(group => [...new Set(group.flatMap(keysOf))]);
        for (const keys of groupKeys) reserve(keys);
        const lastChecked = new Map<string, number>();
        const spacing = options.minimumPassIntervalMs ?? 1000;
        let running = 0;
        let changed: (() => void) | null = null;
        const notify = () => { const resolve = changed; changed = null; resolve?.(); };
        const checkEntry = async (entry: Entry) => {
          checksRunThisPass++;
          previousDue.delete(entry.id);
          running += 1;
          const checkAt = performance.now(), dueLagMs = Date.now() - entry.dueAt;
          const timing = { sqlMs: 0, queries: 0, slowestSqlMs: 0, slowestQuery: null as string | null, outcome: "none" };
          try {
            const current = await recoveryCheckDiagnostic.run(timing, () => options.check(entry, signal));
            if (current) {
              entries.set(entry.id, current);
              provenance.set(entry.id, { cause: "pendingDeadline", fromDueAt: entry.dueAt, dueAt: current.dueAt });
              if (timing.outcome === "none") timing.outcome = "pending deadline";
            } else { entries.delete(entry.id); provenance.delete(entry.id); }
            checkedIds.add(entry.id);
            // Diagnostic-only identity history, bounded independently of queue state.
            if (checkedIds.size > 2048) checkedIds.delete(checkedIds.values().next().value!);
            failures.delete(entry.id);
          } catch (error) { timing.outcome = "error"; failed(failures, entry.id); errors.push(error); }
          finally {
            const ms = performance.now() - checkAt;
            checkMs += ms; checkSqlMs += timing.sqlMs;
            if (recoveryQueues.has(options.queue)) logDiagnostic({ queue: options.queue, phase: "check", passId: diagnosticPassId,
              kind: options.queue === DELIVERY_QUEUES.taskWatchdogs ? "watchdog" :
                options.queue === DELIVERY_QUEUES.orphanBlockers || options.queue === DELIVERY_QUEUES.activeRecoveryActions ? "company" : "issue",
              id: entry.id, issueId: options.queue === DELIVERY_QUEUES.taskWatchdogs ||
                options.queue === DELIVERY_QUEUES.orphanBlockers || options.queue === DELIVERY_QUEUES.activeRecoveryActions ? null : entry.id,
              companyId: entry.companyId,
              dueLagMs, ms, ...timing,
              sqlTimingBoundary: "postgres-js unsafe consumption; includes pool/network/event-loop waits and unsafe savepoints; excludes driver-tagged SQL/BEGIN/COMMIT",
            });
            running -= 1;
            lastChecked.set(entry.id, Date.now());
            notify();
          }
        };
        const nextAdmission = () => {
          // Mid-pass settlements mark scopes dirty, but reconstruction waits for
          // the next pass. Admission therefore relies on check() revalidating
          // the entry against durable state, as the option requires.
          const now = Date.now();
          let wakeAt: number | null = null;
          let candidate: Entry | null = null;
          for (const item of entries.values()) {
            if (owned.has(item.id)) continue;
            if (keysOf(item).some(key => busyKeys.has(key))) continue;
            const at = Math.max(item.dueAt, failures.get(item.id)?.retryAt ?? 0, (lastChecked.get(item.id) ?? -Infinity) + spacing);
            if (at > now) { wakeAt = wakeAt === null ? at : Math.min(wakeAt, at); continue; }
            if (!candidate || item.dueAt < candidate.dueAt || (item.dueAt === candidate.dueAt && item.id < candidate.id)) candidate = item;
          }
          return { candidate, wakeAt };
        };
        const waitForChange = (wakeAt: number | null) => new Promise<void>(resolve => {
          const timer = wakeAt === null ? undefined : setTimeout(finish, Math.max(0, wakeAt - Date.now()));
          function finish() {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            if (changed === finish) changed = null;
            resolve();
          }
          const previous = changed;
          changed = previous ? () => { previous(); finish(); } : finish;
          signal.addEventListener("abort", finish, { once: true });
        });
        const checkGroups = async () => {
          while (!signal.aborted && canRun()) {
            const index = nextGroup++;
            const group = pending[index];
            if (group) {
              try {
                for (const entry of group) {
                  if (signal.aborted || !canRun()) return;
                  try { await checkEntry(entry); } finally { owned.delete(entry.id); }
                }
              } finally { release(groupKeys[index]); notify(); }
              continue;
            }
            if (!admitDueWhileActive) return;
            const { candidate, wakeAt } = nextAdmission();
            if (candidate) {
              const keys = keysOf(candidate);
              owned.add(candidate.id); reserve(keys);
              try { await checkEntry(candidate); } finally { owned.delete(candidate.id); release(keys); notify(); }
              continue;
            }
            // Nothing is admissible now. Stay available only while another
            // check still holds this pass open; otherwise the pass ends and the
            // coordinator schedules the next saved deadline as usual.
            if (running === 0) return;
            await waitForChange(wakeAt);
          }
        };
        // With admission enabled, spare slots start too: a pass that begins with
        // one slow group must still admit other resources that come due later.
        const workers = admitDueWhileActive ? options.concurrentChecks!.limit
          : Math.min(options.concurrentChecks?.limit ?? 1, pending.length);
        const checks = await Promise.allSettled(Array.from({ length: workers }, checkGroups));
        for (const result of checks) if (result.status === "rejected") errors.push(result.reason);
        if (errors.length) throw new AggregateError(errors, `${options.queue} could not settle`);
        lastRunFailed = false;
        passCompleted = true;
      } catch (error) { passFailed = true; lastRunFailed = true; throw error; }
      finally {
        if (passStarted) {
          diagnostic(passFailed ? "pass-failed" : signal.aborted ? "pass-aborted" : passCompleted ? "pass-completed" : "pass-interrupted", {
            passMs: performance.now() - passAt, loadMs, beforePassMs, checkMs, checkSqlMs,
            dirtyHintsByKind: { ...hintCounts },
            remainingDirtyHintsByKind: [...dirty].reduce<Record<string, number>>((counts, hint) => {
              const kind = hintKind(hint); counts[kind] = (counts[kind] ?? 0) + 1; return counts;
            }, {}),
            dirtyHintSources: Object.entries(hintSources).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([source, count]) => ({ source, count })),
          });
          for (const key of Object.keys(hintCounts)) delete hintCounts[key];
          for (const key of Object.keys(hintSources)) delete hintSources[key];
          if (passCompleted) lastCompletedPassAt = Date.now();
        }
        running = false; revision++;
      }
    },
    // Retain scopes/deadlines for resume without retaining a settled write's
    // idle hold during drain. The coordinator still fences unresolved XIDs.
    hasPending: async () => canRun() && dirty.size > 0,
    nextRunAt: next,
    nextRunAtOnError: next,
  });
  if (recoveryQueues.has(options.queue)) {
    const observers = recoveryGateObservers.get(coordinator) ?? new Set();
    observers.add(observeCoordinatorGate);
    recoveryGateObservers.set(coordinator, observers);
  }
  function invalidate(hint = "*") {
    revision++;
    noteHint(hint, "invalidate/refresh");
    dirty.add(hint); versions.set(hint, (versions.get(hint) ?? 0) + 1);
    worker.wake();
  }
  return { ...worker,
    reconciliationSnapshot: (): DeadlineReconciliationSnapshot => ({
      revision: `${ownerRevision}:${revision}`,
      reconciled: !stopped && !running && !lastRunFailed && dirty.size === 0 && scans.size === 0
        && failures.size === 0 && scopeFailures.size === 0,
    }),
    wake() { revision++; worker.wake(); },
    invalidate,
    refresh(hint = "*") {
      reconstructAfter.delete(hint);
      invalidate(hint);
    },
  };
}
