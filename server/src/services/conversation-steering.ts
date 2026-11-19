import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { acceptSteeredIdentity, reconcileSteeredIdentity, rejectSteeredIdentity, reserveSteeredIdentity, storedSteeringAcknowledgement } from "./run-identity.js";
import { nativeRunHasStopRequest } from "./native-runtime/native-run-stop-request.js";
import { logger } from "../middleware/logger.js";

/** Existing outbox lock; shared with task-comment admission and run-end adoption. */
export const personCommentDeliveryLockKey = (issueId: string): string => `conversation-delivery:${issueId}`;

export type SteerablePersonComment = Pick<typeof issueComments.$inferSelect,
  "id" | "companyId" | "issueId" | "body" | "authorAgentId" | "authorUserId"> & { deletedAt?: Date | null };

export type PersonCommentSteeringOptions = {
  /** Only the existing conversation outbox, while holding the lock above. */
  lockHeld?: boolean;
  deliveryIntent?: "steer" | "queue" | "interrupt";
  /** Definite provider refusal uses the caller's ordinary, idempotent admission. */
  onRejected?: () => Promise<unknown>;
};

// The native attachment is process-owned. This promise chain only preserves RPC
// order at that owner; durable custody remains the saved comment + carrying run.
// It never holds the admission lock or makes a later POST await a provider ACK.
const COMMENT_STEER_ACK_TIMEOUT_MS = 30_000;
const dispatches = new Map<string, Promise<void>>();
export async function waitForPendingCommentSteers(): Promise<void> {
  while (dispatches.size) await Promise.all([...dispatches.values()]);
}

function logSteeringFailure(error: unknown) {
  const errorClass = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError"
    : error instanceof Error ? "Error" : "NonError";
  logger.warn({ errorClass }, "Conversation steering failed; using ordinary delivery");
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** A saved comment is the outbox. Its existing activity receipt keeps an explicit
 * Queue/Interrupt durable across a server crash, without manufacturing a wake. */
async function deliveryIntent(db: Db, comment: SteerablePersonComment) {
  const [receipt] = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, comment.companyId), eq(activityLog.entityId, comment.issueId),
    eq(activityLog.action, "issue.comment_added"), sql`${activityLog.details}->>'commentId' = ${comment.id}`,
  )).orderBy(desc(activityLog.createdAt)).limit(1);
  return receipt?.details?.deliveryIntent;
}

/** Default Send adopts Pi's existing steer command. The conversation outbox
 * already serializes sends across servers; no second dispatch owner is added.
 * A pending hand-off is named in the run BEFORE RPC, so even a crash or Stop
 * between acceptance and our receipt restores it through the existing release.
 * Pi's one-at-a-time mode is deliberately left unchanged.
 */
export async function trySteerPersonComment(db: Db, comment: SteerablePersonComment, options: PersonCommentSteeringOptions = {}): Promise<boolean> {
  if (!comment.authorUserId || comment.authorAgentId || comment.deletedAt || comment.body.trim() === "/new") return false;
  if (!options.lockHeld) return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${personCommentDeliveryLockKey(comment.issueId)}, 0))`);
    return trySteerPersonComment(db, comment, { ...options, lockHeld: true });
  });
  // POST retries retain their original custody even if its run has now ended.
  const [carrying] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, comment.companyId),
    sql`(${heartbeatRuns.nativeIssueId} = ${comment.issueId}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${comment.issueId})`,
    sql`coalesce(${heartbeatRuns.contextSnapshot}->'steeredCommentIds', '[]'::jsonb) ? ${comment.id}`,
  )).limit(1);
  if (carrying) return true;
  const intent = options.deliveryIntent ?? await deliveryIntent(db, comment);
  if (intent === "queue" || intent === "interrupt") return false;
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId)));
  if (!issue || ["done", "cancelled"].includes(issue.status)) return false;
  // Chat stays owner-only. Task comments have already passed the ordinary
  // comment route's access/pause checks; they target the current task assignee.
  if (issue.conversationAgentId && issue.conversationUserId !== comment.authorUserId) return false;
  const agentId = issue.conversationAgentId ?? issue.assigneeAgentId;
  if (!agentId) return false;
  const [agent] = await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, issue.companyId)));
  if (agent?.adapterType !== "paperclip_runner" || object(agent.adapterConfig).provider !== "pi_rpc") return false;
  // An explicit queued message (especially /new or a fresh-session response)
  // is an ordering boundary. Default Send never jumps across it.
  const waiting = await db.execute(sql`select 1 from agent_wakeup_requests w
    where w.company_id = ${issue.companyId}::uuid and w.agent_id = ${agentId}::uuid
      and w.status in ('queued', 'deferred_issue_execution') and w.payload->>'issueId' = ${issue.id}
      and w.run_id is null limit 1`);
  if (waiting.length) return false;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
    eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    sql`(${heartbeatRuns.nativeIssueId} = ${issue.id}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id})`,
    issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (!run || nativeRunHasStopRequest(run.resultJson) || (issue.conversationAgentId && run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration)) return false;
  // Lazy import keeps the existing conversation/runtime dependency cycle inert.
  const { getNativeSessionSteeringState, steerNativeSession, NativeSessionSteeringError } = await import("./native-runtime/native-session-executor.js");
  let state: Awaited<ReturnType<typeof getNativeSessionSteeringState>>;
  try {
    state = await getNativeSessionSteeringState(run.id);
  } catch (error) {
    // Probe failure precedes custody; ordinary admission still owns the comment.
    logSteeringFailure(error);
    return false;
  }
  if (state?.disposition !== "available" || !state.activeTurnId) return false; // includes provider-ended / saving-files
  const prepared = await db.transaction(async tx => {
    const [currentIssue] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, issue.companyId))).for("no key update");
    if (!current || current.status !== "running" || nativeRunHasStopRequest(current.resultJson) ||
      currentIssue?.executionRunId !== run.id || currentIssue.assigneeAgentId !== agentId ||
      (issue.conversationAgentId && currentIssue.conversationSessionGeneration !== issue.conversationSessionGeneration)) return false;
    const context = object(current.contextSnapshot), result = object(current.resultJson);
    const now = new Date();
    await tx.update(heartbeatRuns).set({ contextSnapshot: { ...context,
      wakeCommentIds: [...new Set([...ids(context.wakeCommentIds), ...[context.wakeCommentId, context.commentId].filter((id): id is string => typeof id === "string"), comment.id])],
      steeredCommentIds: [...new Set([...ids(context.steeredCommentIds), comment.id])],
    }, resultJson: { ...result, queuedSteeringAcknowledgements: { ...object(result.queuedSteeringAcknowledgements),
      [comment.id]: { status: "pending", queueId: null, turnId: state.activeTurnId, acknowledgedAt: now.toISOString(), deliveryIntent: "steer" },
    } }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    return true;
  });
  if (!prepared) return false;
  // Return the durable steer-or-queue decision now. Identity reservation and
  // RPC ACK belong to ordered dispatch, not the HTTP latency path. Reserving a
  // second identity before the first ACK would otherwise reject rapid Sends.
  const previous = dispatches.get(run.id) ?? Promise.resolve();
  const dispatch = previous.then(async () => {
    let identity: Awaited<ReturnType<typeof reserveSteeredIdentity>> = null;
    try {
      const [currentRun] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, issue.companyId),
      ));
      // An ACK-blocked predecessor can outlive Stop or run end. Do not dispatch
      // a later accepted input after that fence; the existing release/hold owns it.
      if (!currentRun || currentRun.status !== "running" || nativeRunHasStopRequest(currentRun.resultJson) ||
        !ids(currentRun.contextSnapshot?.steeredCommentIds).includes(comment.id)) return;
      const currentState = await getNativeSessionSteeringState(run.id);
      if (currentState.disposition !== "available" || currentState.activeTurnId !== state.activeTurnId)
        throw new NativeSessionSteeringError("steering_stale_turn", "The accepted native turn is no longer attached.");
      identity = await reserveSteeredIdentity(db, { companyId: issue.companyId, issueId: issue.id, runId: run.id, messageId: comment.id, source: "comment" });
      const reserved = identity;
      const acknowledgement = await storedSteeringAcknowledgement(db, { companyId: issue.companyId, runId: run.id, messageId: comment.id }) ?? await steerNativeSession({
        runId: run.id, message: comment.body, correlationId: comment.id, timeoutMs: COMMENT_STEER_ACK_TIMEOUT_MS,
        onAcknowledged: reserved ? () => reconcileSteeredIdentity(db, reserved) : undefined,
      });
      if (typeof acknowledgement?.turnId !== "string" || !acknowledgement.turnId.trim()) {
        throw new TypeError("Invalid steering acknowledgement");
      }
      await db.transaction(async tx => {
        // Match identity reconciliation's task-before-run lock order.
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("no key update");
        const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("no key update");
        if (!current) return;
        if (identity) await acceptSteeredIdentity(tx, identity);
        const result = object(current.resultJson), acks = object(result.queuedSteeringAcknowledgements);
        await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: {
          ...acks, [comment.id]: { ...object(acks[comment.id]), status: "acknowledged", turnId: acknowledgement.turnId },
        } } }).where(eq(heartbeatRuns.id, run.id));
      });
    } catch (error) {
      // Only a timeout is uncertain: the carrying run retains custody until
      // the shared answered predicate can reconcile read/answer evidence.
      if (error instanceof NativeSessionSteeringError && error.code === "steering_timeout") return;
      if (!(error instanceof NativeSessionSteeringError)) logSteeringFailure(error);
      if (!options.onRejected) return; // fail closed: still owed at run end
      if (identity) await rejectSteeredIdentity(db, identity);
      await db.transaction(async lock => {
        await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${personCommentDeliveryLockKey(issue.id)}, 0))`);
        // Admit before dropping custody. A pause can refuse admission without
        // throwing; only a real durable wake receipt permits releasing custody.
        await options.onRejected!();
        const admitted = await lock.execute(sql`select 1 from agent_wakeup_requests
          where company_id = ${issue.companyId}::uuid and agent_id = ${agentId}::uuid
            and idempotency_key = ${`conversation-comment:${comment.id}`}
            and status in ('queued', 'deferred_issue_execution', 'claimed', 'coalesced', 'completed') limit 1`);
        if (!admitted.length) return;
        await db.transaction(async tx => {
          const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("no key update");
          if (!current) return;
          const context = object(current.contextSnapshot), result = object(current.resultJson), acks = object(result.queuedSteeringAcknowledgements);
          await tx.update(heartbeatRuns).set({ contextSnapshot: { ...context,
            wakeCommentIds: ids(context.wakeCommentIds).filter(id => id !== comment.id), steeredCommentIds: ids(context.steeredCommentIds).filter(id => id !== comment.id),
          }, resultJson: { ...result, queuedSteeringAcknowledgements: { ...acks, [comment.id]: { ...object(acks[comment.id]), status: "rejected" } } } })
            .where(eq(heartbeatRuns.id, run.id));
        });
      });
    }
  }).catch(error => {
    logger.error({ err: error, runId: run.id, commentId: comment.id }, "comment steer reconciliation failed; durable custody retained");
  });
  dispatches.set(run.id, dispatch);
  void dispatch.then(() => { if (dispatches.get(run.id) === dispatch) dispatches.delete(run.id); });
  return true;
}

/** Compatibility for existing conversation callers; both surfaces share one owner. */
export const trySteerConversationComment = trySteerPersonComment;

export type SteeredCommentDisplay = {
  steeredIntoRunId: string | null;
  steeredAt: string | null;
  steerDeliveredAt: string | null;
  steeringStatus: "accepted" | "delivered" | null;
  steeringDeliveryEventSeq: number | null;
  deliveryOutcome: "steered" | "queued" | "ordinary";
  steeringUnavailableReason: string | null;
};

/** Display is custody, not an answer. Only Pi's own read event says delivered. */
export async function withSteeredCommentDisplay<T extends { id: string; issueId: string; companyId: string }>(db: Db, comments: T[]): Promise<Array<T & SteeredCommentDisplay>> {
  if (!comments.length) return [];
  const first = comments[0]!;
  const runs = await db.select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, first.companyId), sql`(${heartbeatRuns.nativeIssueId} = ${first.issueId}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${first.issueId})`,
      sql`${heartbeatRuns.contextSnapshot} ? 'steeredCommentIds'`)).orderBy(desc(heartbeatRuns.createdAt));
  const wakes = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, first.companyId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${first.issueId}`,
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
  ));
  const waiting = new Set(wakes.flatMap(({ payload }) => {
    const context = object(payload?._paperclipWakeContext);
    return [...ids(context.wakeCommentIds), ...ids(payload?.commentIds),
      ...[payload?.commentId, context.wakeCommentId, context.commentId].filter((id): id is string => typeof id === "string")];
  }));
  const receipts = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, first.companyId), eq(activityLog.entityId, first.issueId), eq(activityLog.action, "issue.comment_added"),
    sql`${activityLog.details}->>'commentId' in (${sql.join(comments.map(comment => sql`${comment.id}`), sql`, `)})`,
  ));
  const intents = new Map(receipts.map(({ details }) => [String(details?.commentId), details?.deliveryIntent]));
  const [chat] = await db.select({ agentId: issues.conversationAgentId }).from(issues)
    .where(and(eq(issues.companyId, first.companyId), eq(issues.id, first.issueId)));
  const [agent] = chat?.agentId ? await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.companyId, first.companyId), eq(agents.id, chat.agentId))) : [];
  const [latest] = chat?.agentId ? await db.select({ status: heartbeatRuns.status, nativePhase: heartbeatRuns.nativePhase,
    startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, first.companyId),
      eq(heartbeatRuns.agentId, chat.agentId), sql`(${heartbeatRuns.nativeIssueId} = ${first.issueId}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${first.issueId})`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1) : [];
  const unavailable = agent?.adapterType !== "paperclip_runner" || object(agent.adapterConfig).provider !== "pi_rpc"
    ? "not a native Pi session" : !latest || !["running", "queued"].includes(latest.status) ? "run ended"
      : !latest.startedAt || latest.status === "queued" || latest.nativePhase === "starting" ? "run starting" : "steering unavailable";
  return comments.map(comment => {
    const run = runs.find(run => ids(run.contextSnapshot?.steeredCommentIds).includes(comment.id));
    const ack = object(object(run?.resultJson?.queuedSteeringAcknowledgements)[comment.id]);
    const seq = object(run?.contextSnapshot?.steeredDeliveryEventSeqs)[comment.id];
    const deliveredAt = object(run?.contextSnapshot?.steeredDeliveredAts)[comment.id];
    return { ...comment, steeredIntoRunId: run?.id ?? null, steeredAt: typeof ack.acknowledgedAt === "string" ? ack.acknowledgedAt : null,
      steeringStatus: run ? typeof seq === "number" ? "delivered" : "accepted" : null,
      steeringDeliveryEventSeq: typeof seq === "number" ? seq : null,
      steerDeliveredAt: typeof deliveredAt === "string" ? deliveredAt : null,
      deliveryOutcome: run ? "steered" : waiting.has(comment.id) ? "queued" : "ordinary",
      steeringUnavailableReason: !run && waiting.has(comment.id) && intents.get(comment.id) === "steer" ? unavailable : null };
  });
}
