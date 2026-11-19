import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { acceptSteeredIdentity, reconcileSteeredIdentity, rejectSteeredIdentity, reserveSteeredIdentity, storedSteeringAcknowledgement } from "./run-identity.js";
import { nativeRunHasStopRequest } from "./native-runtime/native-run-stop-request.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** A saved comment is the outbox. Its existing activity receipt keeps an explicit
 * Queue/Interrupt durable across a server crash, without manufacturing a wake. */
async function deliveryIntent(db: Db, comment: typeof issueComments.$inferSelect) {
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
export async function trySteerConversationComment(db: Db, comment: typeof issueComments.$inferSelect): Promise<boolean> {
  if (comment.body.trim() === "/new") return false;
  const intent = await deliveryIntent(db, comment);
  if (intent === "queue" || intent === "interrupt") return false;
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId)));
  if (!issue?.conversationAgentId || issue.conversationUserId !== comment.authorUserId) return false;
  const [agent] = await db.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig }).from(agents)
    .where(and(eq(agents.id, issue.conversationAgentId), eq(agents.companyId, issue.companyId)));
  if (agent?.adapterType !== "paperclip_runner" || object(agent.adapterConfig).provider !== "pi_rpc") return false;
  // An explicit queued message (especially /new or a fresh-session response)
  // is an ordering boundary. Default Send never jumps across it.
  const waiting = await db.execute(sql`select 1 from agent_wakeup_requests w
    where w.company_id = ${issue.companyId}::uuid and w.agent_id = ${issue.conversationAgentId}::uuid
      and w.status in ('queued', 'deferred_issue_execution') and w.payload->>'issueId' = ${issue.id}
      and w.run_id is null limit 1`);
  if (waiting.length) return false;
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
    eq(heartbeatRuns.agentId, issue.conversationAgentId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    sql`(${heartbeatRuns.nativeIssueId} = ${issue.id}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id})`,
    issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (!run || nativeRunHasStopRequest(run.resultJson) || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) return false;
  // Lazy import keeps the existing conversation/runtime dependency cycle inert.
  const { getNativeSessionSteeringState, steerNativeSession, NativeSessionSteeringError } = await import("./native-runtime/native-session-executor.js");
  const state = await getNativeSessionSteeringState(run.id);
  if (state.disposition !== "available" || !state.activeTurnId) return false; // includes provider-ended / saving-files
  const identity = await reserveSteeredIdentity(db, { companyId: issue.companyId, issueId: issue.id, runId: run.id, messageId: comment.id, source: "comment" });
  const prepared = await db.transaction(async tx => {
    const [currentIssue] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, issue.companyId))).for("update");
    if (!current || current.status !== "running" || nativeRunHasStopRequest(current.resultJson) ||
      currentIssue?.executionRunId !== run.id || currentIssue.conversationSessionGeneration !== issue.conversationSessionGeneration) return false;
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
  if (!prepared) { if (identity) await rejectSteeredIdentity(db, identity); return false; }
  try {
    const acknowledgement = await storedSteeringAcknowledgement(db, { companyId: issue.companyId, runId: run.id, messageId: comment.id }) ?? await steerNativeSession({
      runId: run.id, message: comment.body, correlationId: comment.id, timeoutMs: 750,
      onAcknowledged: identity ? () => reconcileSteeredIdentity(db, identity) : undefined,
    });
    await db.transaction(async tx => {
      const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      if (!current) return;
      if (identity) await acceptSteeredIdentity(tx, identity);
      const result = object(current.resultJson), acks = object(result.queuedSteeringAcknowledgements);
      await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: {
        ...acks, [comment.id]: { ...object(acks[comment.id]), status: "acknowledged", turnId: acknowledgement.turnId },
      } } }).where(eq(heartbeatRuns.id, run.id));
    });
    return true;
  } catch (error) {
    // Timeout is uncertain, not refusal. The run keeps custody and its end
    // restores the message once; enqueueing here could answer it twice.
    if (!(error instanceof NativeSessionSteeringError) || error.code === "steering_timeout") throw error;
    if (identity) await rejectSteeredIdentity(db, identity);
    await db.transaction(async tx => {
      const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      if (!current) return;
      const context = object(current.contextSnapshot), result = object(current.resultJson), acks = object(result.queuedSteeringAcknowledgements);
      await tx.update(heartbeatRuns).set({ contextSnapshot: { ...context,
        wakeCommentIds: ids(context.wakeCommentIds).filter(id => id !== comment.id), steeredCommentIds: ids(context.steeredCommentIds).filter(id => id !== comment.id),
      }, resultJson: { ...result, queuedSteeringAcknowledgements: { ...acks, [comment.id]: { ...object(acks[comment.id]), status: "rejected" } } } })
        .where(eq(heartbeatRuns.id, run.id));
    });
    return false;
  }
}

export type SteeredCommentDisplay = {
  steeredIntoRunId: string | null;
  steeredAt: string | null;
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
    return { ...comment, steeredIntoRunId: run?.id ?? null, steeredAt: typeof ack.acknowledgedAt === "string" ? ack.acknowledgedAt : null,
      steeringStatus: run ? typeof seq === "number" ? "delivered" : "accepted" : null,
      steeringDeliveryEventSeq: typeof seq === "number" ? seq : null,
      deliveryOutcome: run ? "steered" : waiting.has(comment.id) ? "queued" : "ordinary",
      steeringUnavailableReason: !run && waiting.has(comment.id) && intents.get(comment.id) === "steer" ? unavailable : null };
  });
}
