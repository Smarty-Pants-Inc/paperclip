import { isWellFormedExecutionWait, PersistedExecutionWaitRefusal, wellFormedExecutionWaitSql } from "../deferred-execution-wait.js";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { assignmentWakePayloadSql, type DeferredExecutionScope, type DeferredReceiptRecoveryOptions } from "../deferred-execution-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { dependencyResolvedWakePayloadSql } from "../issue-dependency-wakeups.js";
import { anchorParkedWake, noticeParkedWakeDeadline, PARKED_WAKE_RETRY_MS, parkedWakeAnchor, parkedWakeDeadlineMs,
  parkedWake, parkedWakeNoticedSql, parkedWakeSql, personSendSql } from "./parked-wake-deadline.js";

type Entry = { id: string; companyId: string; dueAt: number; immediate: boolean; operatorRetry?: boolean };
/** S124: 30 s after the last attempt, never past the first park's deadline. */
function parkedDue(updatedAt: Date, anchor: number | null) {
  const cadence = updatedAt.getTime() + PARKED_WAKE_RETRY_MS;
  return anchor === null ? cadence : Math.min(cadence, anchor + parkedWakeDeadlineMs());
}
const scope0 = (entry: Entry) => ({ companyId: entry.companyId, requestId: entry.id });
type NativeIntentOptions = DeferredExecutionScope & {
  onDeferredDeadline(at: number): void;
  onError(error: unknown): void;
};

export function registerDeferredReceiptWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    resume(scope: DeferredReceiptRecoveryOptions): Promise<unknown>;
    /** S8q: the native run an Interrupt stopped has proven it can no longer write. */
    interruptTargetStopped?(scope: Required<DeferredExecutionScope>): Promise<boolean>;
    /** Hold50: a person's message saved after a native Stop whose exact source
     * run has the same stop proof. Not covered: a failed run (no acknowledged Stop). */
    executionWaitSourceStopped?(scope: Required<DeferredExecutionScope>): Promise<boolean>;
    settleTaskChat(scope: DeferredExecutionScope): Promise<unknown>;
    createNativeBatch(): (scope: NativeIntentOptions) => Promise<unknown>;
    schedulingSuppressed(): Promise<boolean>;
    subscribeRefresh?(refresh: () => void): () => void;
  },
  canRun: () => boolean,
) {
  // Outer columns are written fully qualified: inside a select list Drizzle
  // renders them bare, and the subquery's own tables would capture them.
  // Only this press's own proof counts: the run it recorded as its target,
  // stopped by its actor no earlier than the press (fixed-width ISO text).
  const interruptedNativeReleased = sql<boolean>`exists (select 1 from heartbeat_runs r
    join native_run_finalizations f on f.company_id = r.company_id and f.run_id = r.id
    where r.company_id = agent_wakeup_requests.company_id and r.agent_id = agent_wakeup_requests.agent_id
      and r.id::text = agent_wakeup_requests.payload->'queuedCommentInterrupt'->>'targetRunId'
      and r.result_json->>'interruptedByActorId' = agent_wakeup_requests.payload->'queuedCommentInterrupt'->>'actorId'
      and to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        >= agent_wakeup_requests.payload->'queuedCommentInterrupt'->>'requestedAt'
      and r.runtime_mode = 'native' and r.status = 'cancelled'
      and r.result_json->>'queuedCommentInterruptQueueId' = agent_wakeup_requests.id::text
      and f.lease_owner is null and f.phase in ('terminal_failure', 'applied'))`;
  // Hold50 cheap hint: a person's non-interrupt saved message whose task has
  // a stopped native run with a released controller. It is no time filter: a
  // native run finishes after its Stop request (run-cancellation.ts). check()
  // requires the full stop proof, the exact source and a post-Stop request.
  const stoppedNativeSource = sql<boolean>`(agent_wakeup_requests.requested_by_actor_type = 'user'
    and ${wellFormedExecutionWaitSql(sql.raw("agent_wakeup_requests.payload"))}
    and agent_wakeup_requests.payload->'queuedCommentInterrupt' is null
    and exists (select 1 from heartbeat_runs r
      join native_run_finalizations f on f.company_id = r.company_id and f.run_id = r.id
      where r.company_id = agent_wakeup_requests.company_id and r.agent_id = agent_wakeup_requests.agent_id
        and r.context_snapshot->>'issueId' = agent_wakeup_requests.payload->>'issueId'
        and r.runtime_mode = 'native' and r.status = 'cancelled'
        and f.lease_owner is null and f.phase in ('terminal_failure', 'applied')))`;
  let unsubscribeRefresh: (() => void) | undefined;
  function releaseRefresh() {
    unsubscribeRefresh?.();
    unsubscribeRefresh = undefined;
  }
  function register(kind: "deferred" | "task_chat" | "native") {
    const cursors = new Map<string, string>();
    let enabled = false;
    let dispatchNative: ReturnType<typeof owner.createNativeBatch>;
    const queue = kind === "deferred" ? DELIVERY_QUEUES.deferredExecutionReceipts
      : kind === "task_chat" ? DELIVERY_QUEUES.taskRetryReceiptSettlement : DELIVERY_QUEUES.nativeStatusWakeIntents;
    return registerScopedDeadlineWork<Entry, DeferredExecutionScope>(coordinator, {
      queue,
      batchSize: kind === "native" ? 100 : undefined,
      // An exact one-wake hint is a single-row read. It must not wait out the
      // interval that bounds company and instance scans (S8q).
      reconstructionIntervalMs: scope => kind === "deferred" && scope?.requestId ? 0 : 30_000,
      beforePass: async () => {
        enabled = !(await owner.schedulingSuppressed());
        if (kind === "native") dispatchNative = owner.createNativeBatch();
      },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId && (!scope.requestId || entry.id === scope.requestId),
      // A busy company can invalidate a paginated scan before the pending
      // batch drains. Keep unread ready receipts ahead of freshly reloaded
      // receipts already checked; actual wait/claim deadlines still replace.
      mergeEntry: (pending, loaded) => pending.immediate && loaded.immediate
        ? { ...loaded, dueAt: Math.min(pending.dueAt, loaded.dueAt) } : loaded,
      priority: entry => entry.operatorRetry ? 1 : 0,
      onStop: releaseRefresh,
      load: async scope => {
        const key = scope ? JSON.stringify({ companyId: scope.companyId, requestId: scope.requestId }) : "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        const operatorRetry = sql`coalesce(${agentWakeupRequests.reason}, '') = 'task_retry'
          and coalesce(${agentWakeupRequests.requestedByActorType}, '') = 'user'`;
        const columns = { id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
          status: agentWakeupRequests.status, updatedAt: agentWakeupRequests.updatedAt,
          claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
          operatorRetry: sql<boolean>`${operatorRetry}`,
          delayed: sql<boolean>`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null
            or ${agentWakeupRequests.payload}->'executionWait' is not null`,
          // S124: the parked Send's first-park anchor and its press. S124d:
          // every Stop/Send receipt (QCI or a person's executionWait receipt);
          // only a person-controlled wait (their pause, a budget) is not a silent park.
          parked: parkedWakeSql(agentWakeupRequests.payload, personSendSql()),
          pressedAt: sql<string | null>`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'requestedAt'`,
          firstParkedAt: sql<string | null>`${agentWakeupRequests.payload}->>'firstParkedAt'`,
          interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
            where r.company_id = agent_wakeup_requests.company_id and r.agent_id = agent_wakeup_requests.agent_id
              and r.runtime_mode = 'legacy' and r.status = 'cancelled'
              and r.result_json->>'queuedCommentInterruptQueueId' = agent_wakeup_requests.id::text)`,
          // Cheap hint only: the run's controller released its native session.
          // check() requires the full stop proof before skipping the age gate.
          interruptedNative: owner.interruptTargetStopped ? interruptedNativeReleased : sql<boolean>`false`,
          stoppedSource: owner.executionWaitSourceStopped ? stoppedNativeSource : sql<boolean>`false`,
        };
        const eligible = and(
          scope ? eq(agentWakeupRequests.companyId, scope.companyId) : undefined,
          // S124: a parked Send whose one note is written waits for the
          // person's Retry (a new press), never for another silent retry.
          kind === "deferred" ? sql`not ${parkedWakeNoticedSql(agentWakeupRequests.payload)}` : undefined,
          scope?.requestId ? eq(agentWakeupRequests.id, scope.requestId) : undefined,
          kind === "native" ? and(
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
            inArray(agentWakeupRequests.status, ["queued", "claimed"]), isNull(agentWakeupRequests.runId),
          ) : and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
            kind === "task_chat" ? and(eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' is not null`) : or(
              eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
              sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
              sql`jsonb_typeof(${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'
                and ${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
              sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
              // Plugin requestWakeup saves input without comment IDs. Keep
              // reconstruction aligned with the stranded-queue admission scan.
              sql`(${agentWakeupRequests.payload}->>'mutation' = 'plugin_wakeup'
                and ${agentWakeupRequests.payload}->>'pluginId' = ${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,pluginId}'
                and ${agentWakeupRequests.payload}->>'pluginKey' = ${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,pluginKey}'
                and ${agentWakeupRequests.payload}->>'pluginId' is not null
                and ${agentWakeupRequests.payload}->>'pluginKey' is not null
                and ${agentWakeupRequests.requestedByActorType} = 'system'
                and ${agentWakeupRequests.requestedByActorId} = ${agentWakeupRequests.payload}->>'pluginId')`,
              dependencyResolvedWakePayloadSql,
              assignmentWakePayloadSql,
              sql`exists (select 1 from heartbeat_runs r where r.company_id = ${agentWakeupRequests.companyId}
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text)`,
            )),
        );
        const prioritized = kind === "deferred" && !cursor
          ? await db.select(columns).from(agentWakeupRequests).where(and(eligible, operatorRetry))
            .orderBy(asc(agentWakeupRequests.id)).limit(100)
          : [];
        const rows = await db.select(columns).from(agentWakeupRequests).where(and(eligible,
          cursor ? gt(agentWakeupRequests.id, cursor) : undefined))
          .orderBy(asc(agentWakeupRequests.id)).limit(100);
        const complete = rows.length < 100;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        const now = Date.now();
        return { rows: [...prioritized, ...rows].map(row => {
          const deadline = kind === "native" && row.status === "claimed" && row.claimedAt ? row.claimedAt.getTime() + 60_000
            : kind === "native" && row.error ? row.updatedAt.getTime() + 30_000
            : kind === "deferred" && row.delayed && !row.interruptedLegacy && !row.interruptedNative && !row.stoppedSource
              ? parkedDue(row.updatedAt, row.parked ? parkedWakeAnchor({ queuedCommentInterrupt: { requestedAt: row.pressedAt },
                firstParkedAt: row.firstParkedAt }) : null)
            : null;
          const immediate = deadline === null || deadline <= now;
          return { id: row.id, companyId: row.companyId, dueAt: immediate ? now : deadline, immediate,
            operatorRetry: kind === "deferred" && row.operatorRetry };
        }), complete };
      },
      check: async entry => {
        if (!enabled) return null;
        if (kind !== "task_chat") {
          const [current] = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload,
            updatedAt: agentWakeupRequests.updatedAt, claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
            requestedByActorType: agentWakeupRequests.requestedByActorType, reason: agentWakeupRequests.reason,
            // Qualified like interruptedNativeReleased: bare outer columns
            // would bind to the subquery's run.
            interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
              where r.company_id = agent_wakeup_requests.company_id and r.agent_id = agent_wakeup_requests.agent_id
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = agent_wakeup_requests.id::text)`,
          }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, entry.companyId),
            eq(agentWakeupRequests.id, entry.id)));
          if (!current) return null;
          // S124: a parked Send keeps its FIRST park time (stored once); its
          // 30 s cadence and its one deadline count from it, not updatedAt.
          const parked = kind === "deferred" && current.status === "deferred_issue_execution" && !current.interruptedLegacy
            && parkedWake(current.payload, { actorType: current.requestedByActorType, reason: current.reason });
          const anchor = parked ? parkedWakeAnchor(current.payload) ?? await anchorParkedWake(db, scope0(entry)) : null;
          if (anchor !== null && anchor + parkedWakeDeadlineMs() <= Date.now()) {
            // Past the deadline: ONE true note (+ Retry), no further silent retry.
            await noticeParkedWakeDeadline(db, scope0(entry));
            return null;
          }
          const due = kind === "native" && current.status === "claimed" && current.claimedAt
            ? current.claimedAt.getTime() + 60_000
            : kind === "native" && current.status === "queued" && current.error ? current.updatedAt.getTime() + 30_000
              : kind === "deferred" && current.status === "deferred_issue_execution" && !current.interruptedLegacy
                && (current.payload?.queuedCommentInterrupt || current.payload?.executionWait)
                ? parkedDue(current.updatedAt, anchor) : null;
          const stoppedInterrupt = kind === "deferred" && due !== null && due > Date.now() &&
            Boolean(current.payload?.queuedCommentInterrupt) && owner.interruptTargetStopped &&
            await owner.interruptTargetStopped({ companyId: entry.companyId, requestId: entry.id });
          const stoppedSource = kind === "deferred" && due !== null && due > Date.now() && !stoppedInterrupt &&
            isWellFormedExecutionWait(current.payload?.executionWait) && !current.payload?.queuedCommentInterrupt &&
            owner.executionWaitSourceStopped &&
            await owner.executionWaitSourceStopped({ companyId: entry.companyId, requestId: entry.id });
          if (due !== null && due > Date.now() && !stoppedInterrupt && !stoppedSource) return { ...entry, dueAt: due, immediate: false };
        }
        const errors: unknown[] = [];
        let next: number | null = null;
        const scope = { companyId: entry.companyId, requestId: entry.id };
        if (kind === "native") await dispatchNative({ ...scope,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); },
          onError: error => { errors.push(error); },
        });
        else if (kind === "task_chat") await owner.settleTaskChat(scope);
        else {
          const failed = (error: unknown) => { if (!(error instanceof PersistedExecutionWaitRefusal)) errors.push(error); };
          try { await owner.resume({ ...scope, onError: failed }); }
          catch (error) { failed(error); }
        }
        if (errors.length) throw new AggregateError(errors, `Deferred receipt ${entry.id} could not settle`);
        // S124: a parked Send that is still parked is checked again on its
        // cadence, at the latest at its deadline (where its one note is due).
        // A wake that is no longer a silent park (dispatched, or refused into a
        // person-controlled wait) has no anchor here: null, as before S124.
        if (next === null && kind === "deferred") {
          const [still] = await db.select({ payload: agentWakeupRequests.payload, updatedAt: agentWakeupRequests.updatedAt })
            .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, entry.companyId),
              eq(agentWakeupRequests.id, entry.id), eq(agentWakeupRequests.status, "deferred_issue_execution")));
          const stillAnchor = still ? parkedWakeAnchor(still.payload) : null;
          if (still && stillAnchor !== null) next = parkedDue(still.updatedAt, stillAnchor);
        }
        return next === null ? null : { ...entry, dueAt: next, immediate: false };
      },
    }, canRun);
  }
  const workers = [register("deferred"), register("task_chat"), register("native")];
  unsubscribeRefresh = owner.subscribeRefresh?.(() => { for (const worker of workers) worker.refresh(); });
  return { ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
