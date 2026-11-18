import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  agentTaskSessions, agents, authUsers, closeCheckpointDb, closeLivenessDb, companies, companyMemberships, createDb, environmentLeases, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, issueThreadInteractions, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { deliverConversationComments } from "../../services/agent-conversations.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../../services/execution-recovery-resolution.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { issueService } from "../../services/issues.js";
import { persistHeartbeatRunProcessMetadata } from "../../services/heartbeat/run-lifecycle.js";

export const F1_REFUSALS = ["runner_harness_state_mismatch: resumed_unavailable",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding"] as const;
export const F1_HISTORY = "Remember ALDER-B from the saved conversation.";
export const F1_MESSAGE = "First new message: what word did I ask you to remember?";
/** Silent-replay variant (RFL 09:35Z; gate 3 rows, db-f5c33c68.txt): the person's
 * request (live 1dfc69ee) that made the old turn (live 0a23d168) run a foreground
 * sleep and ask a required question in parallel, then park. */
export const F1_REPLAY_REQUEST = "Run `printf SR_SLEEP_STARTED; sleep 120; printf SR_SLEEP_FINISHED` and, in parallel, ask me whether to repeat the word. End parked.";
export const F1_REPLAY_COMMAND = "printf SR_SLEEP_STARTED; sleep 120; printf SR_SLEEP_FINISHED";
export const F1_REPLAY_ANSWER = "Yes: repeat the word";
export type F1Variant = "comment" | "answered_question";

/** Same stranded-owner/no-later-hold incident as RFL's window, without importing
 * its unrelated historical tests or leaking their runs into this fixture. */
export async function f1PersonFlow(refusal: string, clock: "real" | "advancing", variant: F1Variant = "comment") {
  const answered = variant === "answered_question";
  const database = await startEmbeddedPostgresTestDatabase("paperclip-f1-person-flow-");
  const db: Db = createDb(database.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH } });
  await once(child, "spawn");
  const pid = child.pid!;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  const t0 = Date.now(), userId = randomUUID(), sessionId = randomUUID();
  const [user] = await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).returning();
  const [company] = await db.insert(companies).values({ name: "F1 person", issuePrefix: "F1P", defaultResponsibleUserId: user.id }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: user.id,
    status: "active", membershipRole: "owner" });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Saved work", role: "engineer", status: "idle",
    adapterType: "paperclip_runner", adapterConfig: answered ? { provider: "pi_rpc", model: "paperclip/claude-fable-5-2", piRpcThinkingLevel: "high" } : { provider: "codex", model: "gpt-5.6-luna" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue the saved conversation", status: "in_progress",
    responsibleUserId: user.id, assigneeAgentId: agent.id, conversationAgentId: agent.id,
    conversationUserId: user.id, conversationState: "active" }).returning();
  // Answered-question variant (gate 3 order): the person's request (1dfc69ee),
  // the run that ran bash and asked (0a23d168; both calls have results), the
  // person's answer (1c287ff0), then the refused run that the answer woke
  // (`source`, a37d4698).
  let replay: { requestId: string; askerId: string; interactionId: string } | null = null;
  if (answered) {
    const [request] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user",
      authorUserId: user.id, body: F1_REPLAY_REQUEST, createdAt: new Date(t0 - 700_000) }).returning();
    const [asker] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "succeeded", responsibleUserId: user.id,
      createdAt: new Date(t0 - 690_000), startedAt: new Date(t0 - 690_000), finishedAt: new Date(t0 - 680_000),
      contextSnapshot: { issueId: issue.id, conversation: true, conversationSessionGeneration: 0, commentId: request.id,
        wakeCommentIds: [request.id], wakeReason: "issue_commented" } }).returning();
    // Live: the bash call has its result ("Command aborted"), not an open call.
    await db.insert(heartbeatRunEvents).values({ companyId: company.id, runId: asker.id, agentId: agent.id, seq: 1,
      eventType: "item.completed", createdAt: new Date(t0 - 689_000), payload: { prpEvent: { runId: asker.id, itemId: "sr-bash-1",
        eventType: "item.completed", payload: { kind: "commandExecution", item: { id: "sr-bash-1", type: "commandExecution",
          command: F1_REPLAY_COMMAND, status: "failed", aggregatedOutput: "Command aborted" } } } } });
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: issue.id,
      kind: "ask_user_questions", status: "answered", continuationPolicy: "wake_assignee", idempotencyKey: "sr-valid",
      sourceRunId: asker.id, createdByAgentId: agent.id, title: "Repeat the word?", summary: "Repeat the word when I continue?",
      resolvedByUserId: user.id, resolvedAt: new Date(t0 - 125_000), createdAt: new Date(t0 - 688_000),
      payload: { version: 1, questions: [{ id: "continue", prompt: "Repeat the word when I continue?", selectionMode: "single",
        required: true, options: [{ id: "yes", label: F1_REPLAY_ANSWER }] }] },
      result: { version: 1, answers: [{ questionId: "continue", optionIds: ["yes"] }],
        summaryMarkdown: `Resolved questions and answers:\n- Repeat the word when I continue?: ${F1_REPLAY_ANSWER}` } } as typeof issueThreadInteractions.$inferInsert).returning();
    replay = { requestId: request.id, askerId: asker.id, interactionId: question.id };
    // The chat's saved Pi conversation (live: Pi generation 1 before the fresh thread).
    await db.insert(agentTaskSessions).values({ companyId: company.id, agentId: agent.id, adapterType: "paperclip_runner",
      taskKey: issue.id, lastRunId: asker.id, sessionParamsJson: { sessionId, __paperclipPiConversation: {
        schema: "paperclip.pi-conversation.v1", id: sessionId, generation: 1, previousId: null, reason: "first_message", runId: asker.id,
        boundary: { provider: "pi_rpc", trust: "standard", cwd: null, workspaceId: null } } } });
  }
  // a37d4698.context_snapshot: the interaction-respond wake names the answer AND
  // the asking turn's origin comment (commentId/wakeCommentIds/replay cutoff).
  const answerWake = replay ? { source: "issue.interaction.respond", mutation: "interaction", wakeReason: "issue_commented",
    wakeSource: "automation", sourceRunId: replay.askerId, interactionId: replay.interactionId, interactionKind: "ask_user_questions",
    interactionStatus: "answered", commentId: replay.requestId, wakeCommentId: replay.requestId, wakeCommentIds: [replay.requestId],
    sourceCommentId: replay.requestId, conversationReplayThroughCommentId: replay.requestId, conversationMode: true } : {};
  // a37d4698.native_execution_input.interactionResponses held the person's answer.
  const answerInput = replay ? { runnerProfileJson: { nativeExecutionInput: { interactionResponses: [{
    kind: "ask_user_questions", interactionId: replay.interactionId, response: { status: "answered", result: {
      version: 1, answers: [{ questionId: "continue", optionIds: ["yes"] }],
      summaryMarkdown: `Resolved questions and answers:\n- Repeat the word when I continue?: ${F1_REPLAY_ANSWER}` } } }] } } } : {};
  const [owner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
    nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "running", nativePhase: null,
    responsibleUserId: user.id, createdAt: new Date(t0 - 600_000), contextSnapshot: { issueId: issue.id, conversation: true, conversationSessionGeneration: 0 } }).returning();
  await persistHeartbeatRunProcessMetadata(db, owner.id, { pid, processGroupId: pid, startedAt: new Date().toISOString(), targetKind: "remote" });
  await db.insert(nativeRunFinalizations).values({ runId: owner.id, companyId: company.id, issueId: issue.id,
    phase: "observed", attempt: 2, leaseOwner: "prior-native-owner", leaseExpiresAt: new Date(0) });
  const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, heartbeatRunId: owner.id,
    provider: "boat", providerLeaseId: `closed-${owner.id}`, status: "released", cleanupStatus: "success",
    acquiredAt: new Date(t0 - 600_000), releasedAt: new Date(t0 - 300_000) }).returning();
  await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: {
    schema: "paperclip.remote-termination.v1", companyId: company.id, runId: owner.id, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: lease.releasedAt!.toISOString(),
  } } }).where(eq(environmentLeases.id, lease.id));
  const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
    nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
    errorCode: refusal, error: refusal, responsibleUserId: user.id, createdAt: new Date(t0 - 120_000), finishedAt: new Date(t0 - 60_000),
    // Answered variant: this refused run is the one the person's answer woke (live a37d4698).
    contextSnapshot: { issueId: issue.id, conversation: true, conversationSessionGeneration: 0, ...answerWake }, ...answerInput }).returning();
  await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id,
    phase: "terminal_failure", failureCode: refusal, recoveryState: "blocked" });
  // The answered variant's saved history precedes its request (t0 - 700 s).
  const historyShift = answered ? 560_000 : 0;
  await db.insert(issueComments).values([
    { companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: user.id, body: F1_HISTORY, createdAt: new Date(t0 - 250_000 - historyShift) },
    { companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id, body: "Noted ALDER-B.", createdAt: new Date(t0 - 240_000 - historyShift) },
  ]);
  // The refused run's existing failure notice for the person's request (live:
  // e2453887, unanswered-person-message.ts writer), still current.
  if (replay) await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "system",
    body: "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.",
    createdAt: new Date(t0 - 30_000), metadata: { version: 1, sourceRunId: source.id, recoveryResponsibility: "user",
      authorizationReason: `unanswered_message:${replay.requestId}`, sections: [] } } as typeof issueComments.$inferInsert);
  if (clock === "advancing") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  // The pi_rpc variant verifies the built provider pack (pnpm --filter
  // @paperclipai/paperclip-runner build:provider-pack) like a pack launch.
  const packPath = answered ? process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH : undefined;
  const hb = heartbeatService(db, { runtimeEnv: { PAPERCLIP_NATIVE_RUNTIME_ENABLED: "true",
    ...(packPath ? { PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: packPath } : {}) } });
  const errors: unknown[] = [], passes = new Set<Promise<unknown>>();
  const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
  const register = coordinator.register.bind(coordinator);
  coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
    const pass = Promise.resolve(task.run(signal)); passes.add(pass);
    void pass.then(() => passes.delete(pass), () => passes.delete(pass)); return pass;
  } });
  const snapshot = async () => ({
    refusal, clock, elapsedMs: Date.now() - t0, ownerId: owner.id, sourceId: source.id,
    issue: (await db.select().from(issues).where(eq(issues.id, issue.id)))[0],
    blocker: await getExecutionBlocker(db, company.id, issue.id),
    runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id)),
    comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
    actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)),
    events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, company.id)),
    errors,
  });
  return {
    db, owner, source, sessionId, issue, hb, snapshot, replay,
    async start() {
      await hb.registerResidualRecoveryWork(coordinator, () => true).ready;
      await hb.registerActiveRunSilenceWork(coordinator, () => true).ready;
      await hb.registerIssueStateRecoveryWork(coordinator, () => true).ready;
      await hb.registerDeferredReceiptWork(coordinator, () => true).ready;
      await hb.registerRunDispatchWork(coordinator, () => true).ready;
      await hb.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
      // Exactly one person action. No direct fallback, manual queued execution,
      // later-source hold, rescue send, or provider capability change in product.
      // Answered variant: the person's one action (the answer) is already
      // recorded and woke the refused owner; no new message is sent.
      if (!answered) {
        await issueService(db).addComment(issue.id, F1_MESSAGE, { userId: user.id }, { clientRequestId: randomUUID() });
        await deliverConversationComments(db, issue, hb.wakeup);
      }
      await hb.drainActiveRunExecutions();
      await hb.reapOrphanedRuns();
      await settleUnrecoverableExecutions(db);
      await hb.reconcileStrandedAssignedIssues();
      await hb.drainActiveRunExecutions();
      // No person message follows the answer: the executionContinuation queue's
      // next pass (index.ts deliverReconciledExecutions) delivers the recorded
      // automatic successor (live: f5c33c68, 70 s after the refusal).
      if (answered) {
        await deliverReconciledExecutions(db, hb.wakeup);
        await hb.drainActiveRunExecutions();
      }
      await Promise.allSettled([...passes]);
    },
    async untilSubmitted(requireEvent = false) {
      const deadline = t0 + 120_000;
      for (;;) {
        const row = await snapshot();
        if (row.events.some(event => event.eventType === "turn.submitted") || (!requireEvent &&
          row.runs.some(run => run.id !== owner.id && run.id !== source.id && run.runnerProfileJson?.nativeExecutionInput))) return row;
        if (row.runs.some(run => run.id !== owner.id && run.id !== source.id && run.status === "failed") || Date.now() >= deadline) return row;
        if (clock === "advancing") await vi.advanceTimersByTimeAsync(Math.min(500, deadline - Date.now()));
        else await delay(20);
        await immediate();
        await hb.drainActiveRunExecutions();
        await Promise.allSettled([...passes]);
      }
    },
    async cleanup() {
      await coordinator.stop();
      await hb.drainActiveRunExecutions();
      await Promise.allSettled([...passes]);
      vi.useRealTimers();
      try {
        await closeLivenessDb(db, 0);
        await closeCheckpointDb(db, 0);
        await db.$client.end({ timeout: 0 });
      } finally { await database.cleanup(); }
    },
    async evidence(label: string) {
      const row = await snapshot();
      if (process.env.TASK_OUT) await appendFile(`${process.env.TASK_OUT}/${label}.jsonl`, JSON.stringify(row) + "\n");
      return row;
    },
  };
}
