import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRunEvents, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { queuedInteractionId, unansweredResolvedInteractionIds } from "../queued-interaction-response.js";

type Scope = { companyId: string; issueId: string; runId: string; agentId?: string };
type Evidence = { sessionId: string; commentIds: string[] };

/** No runner/Boat call is permitted while the issue or run is locked. ACKs
 * nominate candidates only; provider-retained correlation IDs prove input.
 * Text equality is never input identity (including for legacy receipts). */
export async function readContinuousSessionInput(db: Pick<Db, "select">, scope: Scope): Promise<Evidence | null> {
  const [row] = await db.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.nativeIssueId, scope.issueId)));
  if (!row?.run.nativeSessionId || row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc" ||
      resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return null;
  const prior = await db.select({ id: heartbeatRuns.id, result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, row.run.agentId),
    eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.nativeSessionId, row.run.nativeSessionId),
    eq(heartbeatRuns.runtimeMode, "native")));
  const settled = new Set<string>();
  for (const source of prior) {
    const result = parseObject(source.result);
    for (const reply of Object.values(parseObject(result.continuousReplies))) {
      const ids = parseObject(reply).questionCommentIds;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") settled.add(id);
    }
    const returned = parseObject(result.personStop).returned;
    if (Array.isArray(returned)) for (const id of returned) if (typeof id === "string") settled.add(id);
  }
  const candidates = [...new Set(prior.filter(source => source.id !== scope.runId).flatMap(source =>
    Object.entries(parseObject(parseObject(source.result).queuedSteeringAcknowledgements))
      .filter(([id, receipt]) => !settled.has(id) && parseObject(receipt).status === "acknowledged").map(([id]) => id)))];
  if (!candidates.length) return null;
  const { readNativeSessionUserInputIds } = await import("./native-session-executor.js");
  const entries = await readNativeSessionUserInputIds(scope.runId, row.run.nativeSessionId);
  if (!entries) return null; // Missing/unreadable/legacy history: no retention proof.
  const comments = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId), inArray(issueComments.id, candidates)));
  const interactions = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, scope.companyId), eq(issueThreadInteractions.issueId, scope.issueId),
    inArray(issueThreadInteractions.id, candidates), inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"])));
  const retained = new Set(entries);
  return { sessionId: row.run.nativeSessionId, commentIds: [...comments, ...interactions]
    .filter(input => retained.has(input.id)).map(input => input.id) };
}

/** Board reads use only the receipt written atomically with queue settlement. */
export async function continuousSessionAcknowledgedCommentIds(db: Pick<Db, "select">, scope: Scope): Promise<Set<string>> {
  const [run] = await db.select({
    continuedSessionInput: sql<Record<string, unknown> | null>`${heartbeatRuns.resultJson}->'continuedSessionInput'`,
    nativeSessionId: heartbeatRuns.nativeSessionId,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId)));
  const saved = parseObject(run?.continuedSessionInput);
  return new Set(saved.runId === scope.runId && saved.sessionId === run?.nativeSessionId && Array.isArray(saved.commentIds)
    ? saved.commentIds.filter((id): id is string => typeof id === "string") : []);
}

/** Issue -> deferred wakes -> run. Attribution and wake settlement are one
 * transaction. Publication can join this transaction using its pre-read proof. */
export async function settleContinuousSessionInput(tx: Db, scope: Scope, evidence: Evidence | null) {
  if (!evidence?.commentIds.length) return;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId))).for("no key update");
  if (!issue?.assigneeAgentId || issue.executionRunId !== scope.runId ||
      (scope.agentId && issue.assigneeAgentId !== scope.agentId)) return;
  const wakes = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
  )).orderBy(asc(agentWakeupRequests.id)).for("update");
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, scope.runId),
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, issue.assigneeAgentId),
    eq(heartbeatRuns.nativeIssueId, scope.issueId))).for("update");
  if (!run || run.status !== "running" || run.runtimeMode !== "native" || run.nativeSessionId !== evidence.sessionId) return;
  const result = parseObject(run.resultJson), saved = parseObject(result.continuedSessionInput);
  const ids = saved.runId === scope.runId && saved.sessionId === run.nativeSessionId && Array.isArray(saved.commentIds)
    ? [...new Set([...saved.commentIds.filter((id): id is string => typeof id === "string"), ...evidence.commentIds])] : evidence.commentIds;
  const consumed = new Set(ids), now = new Date();
  for (const wake of wakes) {
    const interactionId = queuedInteractionId(wake.payload);
    if (interactionId && consumed.has(interactionId)) {
      await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, updatedAt: now })
        .where(eq(agentWakeupRequests.id, wake.id));
      continue;
    }
    const pending = queuedCommentIdsFromWakePayload(wake.payload), remaining = pending.filter(id => !consumed.has(id));
    if (remaining.length === pending.length) continue;
    await tx.update(agentWakeupRequests).set({ ...(remaining.length
      ? { payload: withQueuedCommentIdsInWakePayload(wake.payload, remaining) } : { status: "cancelled", finishedAt: now }), updatedAt: now,
    }).where(eq(agentWakeupRequests.id, wake.id));
  }
  await tx.update(heartbeatRuns).set({ resultJson: { ...result,
    continuedSessionInput: { runId: scope.runId, sessionId: run.nativeSessionId, commentIds: ids } }, updatedAt: now,
  }).where(eq(heartbeatRuns.id, scope.runId));
}

/** A failed held conversation is not itself a new question. Only a saved,
 * unanswered person input can authorize its automatic failure continuation. */
export async function answeredContinuousHeldRun(db: Db, scope: Scope): Promise<boolean> {
  const [row] = await db.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId))).where(and(
      eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.nativeIssueId, scope.issueId),
      scope.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined));
  if (!row || row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc" ||
      resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return false;
  const result = parseObject(row.run.resultJson);
  if (!Object.keys(parseObject(result.continuousReplies)).length) return false;
  // An ordinary successor may have answered between recovery delivery and
  // admission. Inventory durable input, then subtract attributable answers or
  // explicit returns across this assignee's runs, never transport statuses.
  const runs = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, row.run.agentId),
    or(eq(heartbeatRuns.nativeIssueId, scope.issueId), eq(heartbeatRuns.issueId, scope.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`)));
  const answered = new Set<string>();
  for (const source of runs) {
    const saved = parseObject(source.result);
    for (const reply of Object.values(parseObject(saved.continuousReplies))) {
      const ids = parseObject(reply).questionCommentIds;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") answered.add(id);
    }
    const returned = parseObject(saved.personStop).returned;
    if (Array.isArray(returned)) for (const id of returned) if (typeof id === "string") answered.add(id);
  }
  const comments = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId), isNull(issueComments.deletedAt),
    or(eq(issueComments.authorType, "user"), sql`${issueComments.authorUserId} IS NOT NULL`)));
  const interactions = await unansweredResolvedInteractionIds(db, {
    companyId: scope.companyId, issueId: scope.issueId, agentId: row.run.agentId,
  });
  const context = row.run.contextSnapshot;
  const pending = new Set([
    ...comments.map(comment => comment.id), ...interactions,
    ...queuedCommentIdsFromRunContext(context),
    ...(typeof context?.wakeCommentId === "string" ? [context.wakeCommentId] : []),
    ...(Array.isArray(context?.wakeCommentIds) ? context.wakeCommentIds : []),
    ...Object.keys(parseObject(result.queuedSteeringAcknowledgements)),
    ...(Array.isArray(parseObject(context?.firstTurnQueuedInput).commentIds) ? parseObject(context?.firstTurnQueuedInput).commentIds as string[] : []),
    ...(Array.isArray(parseObject(context?.firstTurnQueuedInput).interactionIds) ? parseObject(context?.firstTurnQueuedInput).interactionIds as string[] : []),
    ...(Array.isArray(parseObject(result.continuedSessionInput).commentIds) ? parseObject(result.continuedSessionInput).commentIds as string[] : []),
  ]);
  const wakes = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, row.run.agentId),
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`));
  for (const wake of wakes) {
    // Card/question responses are distinct input, never settled by a comment
    // attribution. Keep ordinary failure arbitration while their wake is pending.
    const payload = parseObject(wake.payload), wakeContext = parseObject(payload._paperclipWakeContext);
    const interactionId = payload.interactionId ?? wakeContext.interactionId;
    if (typeof interactionId === "string") pending.add(interactionId);
    for (const id of queuedCommentIdsFromWakePayload(wake.payload)) pending.add(id);
  }
  const [response] = await db.select({ id: issueQuestionResponseDeliveries.id }).from(issueQuestionResponseDeliveries).where(and(
    eq(issueQuestionResponseDeliveries.companyId, scope.companyId), eq(issueQuestionResponseDeliveries.issueId, scope.issueId),
    inArray(issueQuestionResponseDeliveries.status, ["pending", "delivering"]))).limit(1);
  return !response && [...pending].every(id => answered.has(id));
}

/** Exact revisions accepted by the selected retained session, not the frozen
 * origin envelope. Queue receipts alone are not provider delivery evidence.
 * This read is DB-only: it runs before the successor's native session opens. */
export async function retainedSessionCommentCoverage(db: Pick<Db, "select">, scope: {
  companyId: string; issueId: string; agentId: string; runId?: string;
  previousRunId: string; sessionId: string; providerSessionId: string;
  messages: ReadonlyArray<{ id: string; updatedAt: string }>;
}): Promise<{ received: Set<string>; owed: Set<string> } | null> {
  const runs = await db.select({ id: heartbeatRuns.id,
    coverage: sql<Record<string, unknown> | null>`${heartbeatRuns.contextSnapshot} #> '{executionContinuation,coverage}'`,
    // Transfer revision identities, not N copies of the task's message bodies.
    messages: sql<Array<{ id: string; updatedAt: string }>>`(select coalesce(jsonb_agg(jsonb_build_object(
      'id', message->'id', 'updatedAt', message->'updatedAt')), '[]'::jsonb)
      from jsonb_array_elements(case
        when jsonb_typeof(${heartbeatRuns.contextSnapshot} #> '{executionContinuation,resumeDelta,messages}') = 'array'
          then ${heartbeatRuns.contextSnapshot} #> '{executionContinuation,resumeDelta,messages}'
        when jsonb_typeof(${heartbeatRuns.contextSnapshot} #> '{executionContinuation,messages}') = 'array'
          then ${heartbeatRuns.contextSnapshot} #> '{executionContinuation,messages}'
        else '[]'::jsonb end) message)`,
    result: sql<Record<string, unknown>>`jsonb_build_object(
      'queuedSteeringAcknowledgements', ${heartbeatRuns.resultJson}->'queuedSteeringAcknowledgements',
      'personStop', ${heartbeatRuns.resultJson}->'personStop')`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    eq(heartbeatRuns.nativeSessionId, scope.sessionId), eq(heartbeatRuns.runtimeMode, "native"),
    or(eq(heartbeatRuns.nativeIssueId, scope.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`),
    scope.runId ? sql`${heartbeatRuns.id} <> ${scope.runId}` : undefined,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  if (!runs.some(run => run.id === scope.previousRunId)) return null;
  const events = await db.select({ runId: heartbeatRunEvents.runId, seq: heartbeatRunEvents.seq,
    eventType: heartbeatRunEvents.eventType, sourceEventId: heartbeatRunEvents.sourceEventId,
    payload: heartbeatRunEvents.payload,
  }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, scope.companyId), inArray(heartbeatRunEvents.runId, runs.map(run => run.id)),
    or(inArray(heartbeatRunEvents.eventType, ["turn.accepted", "turn.started", "session.started", "session.resumed", "session.reconciled"]),
      and(eq(heartbeatRunEvents.eventType, "item.completed"),
        sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'steering_acknowledgement'`)),
  )).orderBy(asc(heartbeatRunEvents.seq));
  const eventsByRun = new Map<string, typeof events>();
  for (const event of events) {
    const entries = eventsByRun.get(event.runId) ?? [];
    entries.push(event); eventsByRun.set(event.runId, entries);
  }
  const sameGeneration = (run: typeof runs[number], throughSeq = Number.POSITIVE_INFINITY) => {
    const session = eventsByRun.get(run.id)?.findLast(event => event.seq <= throughSeq && event.eventType.startsWith("session."));
    // A later session event overrides saved coverage after a failed resume.
    return (session ? parseObject(parseObject(session.payload?.prpEvent).payload).providerSessionId
      : run.coverage?.providerSessionId) === scope.providerSessionId;
  };
  if (!sameGeneration(runs.find(run => run.id === scope.previousRunId)!)) return null;
  const queueIds = runs.flatMap(run => Object.values(parseObject(run.result.queuedSteeringAcknowledgements))
    .flatMap(value => typeof parseObject(value).queueId === "string" ? [parseObject(value).queueId as string] : []));
  const wakes = await db.select({ id: agentWakeupRequests.id, createdAt: agentWakeupRequests.createdAt,
    status: agentWakeupRequests.status, payload: agentWakeupRequests.payload,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
    or(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
      queueIds.length ? inArray(sql<string>`${agentWakeupRequests.id}::text`, queueIds) : undefined),
  ));
  const wakesById = new Map(wakes.map(wake => [wake.id, wake]));
  const revisions = new Map(scope.messages.map(message => [message.id, message.updatedAt]));
  const received = new Set<string>(), owed = new Set<string>();
  const accept = (id: unknown, revision: unknown) => {
    if (typeof id === "string" && typeof revision === "string" && revisions.get(id) === revision) {
      received.add(id); owed.delete(id);
    }
  };
  for (const run of runs) {
    const runEvents = eventsByRun.get(run.id) ?? [];
    if (sameGeneration(run)) {
      if (runEvents.some(event => ["turn.accepted", "turn.started"].includes(event.eventType) && sameGeneration(run, event.seq))) {
        // A successor's full history is fallback data, not its delivered delta.
        for (const message of run.messages) accept(message.id, message.updatedAt);
        const coverage = run.coverage;
        if (coverage?.nativeSessionId === scope.sessionId && coverage.providerSessionId === scope.providerSessionId && Array.isArray(coverage.omitted)) {
          for (const value of coverage.omitted) { const message = parseObject(value); accept(message.id, message.updatedAt); }
        }
      }
      for (const [id, value] of Object.entries(parseObject(run.result.queuedSteeringAcknowledgements))) {
        const receipt = parseObject(value);
        if (receipt.status !== "acknowledged" || typeof receipt.turnId !== "string") continue;
        const acknowledged = runEvents.some(event => {
          const prp = parseObject(event.payload?.prpEvent), payload = parseObject(prp.payload);
          return event.eventType === "item.completed" && event.sourceEventId !== null && sameGeneration(run, event.seq)
            && prp.normalizedSessionId === scope.sessionId && prp.turnId === receipt.turnId
            && prp.itemId === `${receipt.turnId}:steer:${id}`
            && payload.kind === "steering_acknowledgement" && payload.status === "acknowledged";
        });
        if (!acknowledged) continue;
        if (typeof receipt.commentUpdatedAt === "string") accept(id, receipt.commentUpdatedAt);
        else {
          // Older ACKs stored no revision. Only the unchanged pre-queue
          // revision is provable; a later edit can never be hidden by its ACK.
          const wake = typeof receipt.queueId === "string" ? wakesById.get(receipt.queueId) : undefined;
          const revision = revisions.get(id);
          if (wake && revision && Date.parse(revision) <= wake.createdAt.getTime()) accept(id, revision);
        }
      }
    }
    const returned = parseObject(run.result.personStop).returned;
    if (Array.isArray(returned)) for (const id of returned) if (typeof id === "string") { received.delete(id); owed.add(id); }
  }
  // Pending/returned input is debt, even when an older revision was received.
  for (const wake of wakes) if (["queued", "deferred_issue_execution"].includes(wake.status)) {
    for (const id of queuedCommentIdsFromWakePayload(wake.payload)) { received.delete(id); owed.add(id); }
  }
  return { received, owed };
}

export async function reconcileContinuousSessionInput(db: Db, scope: Scope) {
  const evidence = await readContinuousSessionInput(db, scope);
  await db.transaction(tx => settleContinuousSessionInput(tx as unknown as Db, scope, evidence));
}
