// A person's native Retry that admission routes to a fresh isolated workspace
// (the old box is not task-owned or not reusable, e.g. a remote sandbox) must
// open a fresh provider thread on its FIRST run. Keeping the conversation's
// session id makes the server restore the last checkpoint matched by
// company/agent/task/session into the new scope root, where the identity check
// refuses it (prior_owner_scope_mismatch): one failed run, then the
// held_recovery fresh continuation answers ~1-2 min later. The Retry records
// the same fresh-thread record that follow-up records, at admission.
// A Retry that reuses the task's own box keeps the session id.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentTaskSessions, agentWakeupRequests, companies, companyMemberships, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueComments, issueRecoveryActions, issues, issueThreadInteractions, nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { heartbeatService } from "./heartbeat.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { materializeNativeInteractionResponses } from "./native-runtime/native-interaction-bridge.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { createSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { PROCESS_IDENTITY_RECORDED } from "./native-local-process-stop.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import os from "node:os";
import { PI_CONVERSATION_KEY, selectPiConversation } from "./native-runtime/pi-conversation-record.js";
import { findNativeSessionResumeRun } from "./native-runtime/native-session-resume.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshContinuationSessionBoundary, recordRetryFreshProviderThread } from "./fresh-continuation-fallback.js";
import { freshContinuationTimes, sharedContinuationAttempts } from "./recovery/continuation-ledger.js";
import { taskAutomaticAttempts } from "./recovery/task-automatic-attempts.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { settleUnansweredPersonMessage } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native Retry routed to a fresh isolated workspace", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const dirs: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retry-fresh-thread-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end(); await database?.cleanup();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function seed(box: "remote" | "own_local" | "not_task_owned") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), successorRunId = randomUUID(), sessionId = randomUUID(), wakeId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry fresh thread", defaultResponsibleUserId: "board",
      issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer the person", status: "blocked", assigneeAgentId: agentId });
    // A local process that already exited: its stop is provable on this host.
    const child = execFile(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise(resolve => child.on("exit", resolve));
    const [source] = await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode: "native_runner_lost", nativeSessionId: sessionId,
      processPid: box === "remote" ? process.pid : child.pid!, processStartedAt: new Date(Date.now() - 120_000),
      contextSnapshot: { issueId }, createdAt: new Date(Date.now() - 180_000), startedAt: new Date(Date.now() - 170_000),
      finishedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", attempt: 3,
      failureDetail: { replacementDenied: "uncertain_external_action" } });
    const recovery = failSystemRecovery(createSystemRecovery(sourceRunId, wakeId),
      new SystemRecoveryFailure("historical_source_missing", "use_alternative_strategy"));
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "uncertain_external_action", fingerprint: sourceRunId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped.", evidence: { runId: sourceRunId, systemRecovery: recovery,
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1", generationId: wakeId, sourceRunId,
        actorId: "board", strategy: "evaluate" } } });
    // One local environment exists per instance.
    const [environment] = box === "remote"
      ? await db.insert(environments).values({ name: `box-${sourceRunId}`, driver: "sandbox" }).returning()
      : await db.select().from(environments).where(eq(environments.driver, "local")).then(async rows => rows.length ? rows
        : db.insert(environments).values({ name: "Local", driver: "local" }).returning());
    let workspaceId: string | null = null;
    if (box === "remote") {
      const identity = { id: randomUUID(), companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId: "sandbox-1" };
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment!.id, issueId, status: "released",
        leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success", metadata: {
          remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: "sandbox-1", state: "destroyed" }) } });
    } else {
      const cwd = await mkdtemp(join(tmpdir(), "retry-own-box-"));
      dirs.push(cwd);
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, mode: "isolated_workspace",
        strategyType: "project_primary", providerType: "local_fs", name: "Task workspace", cwd, status: "active" }).returning();
      workspaceId = workspace!.id;
      // A replaced box: the task no longer owns the source's directory.
      if (box === "own_local") await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: sourceRunId, environmentId: environment!.id, issueId,
        executionWorkspaceId: workspaceId, provider: "local", status: "released", leasePolicy: "ephemeral",
        releasedAt: new Date(), cleanupStatus: "success" });
      await appendHeartbeatRunEvent(db, { companyId, runId: sourceRunId, agentId, eventType: PROCESS_IDENTITY_RECORDED,
        stream: "system", level: "info", message: "Recorded the exited local process", payload: { targetKind: "local",
          hostname: os.hostname(), processPid: source!.processPid, processGroupId: null,
          processStartedAt: source!.processStartedAt!.toISOString() } });
    }
    // The conversation as the heartbeat's real writer recorded it for the source run.
    const boundary = { provider: "pi_rpc", cwd: "/workspaces/old-box", remoteCwd: null, workspaceId, trust: "trust" };
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId,
      lastRunId: sourceRunId, sessionParamsJson: { sessionId, [PI_CONVERSATION_KEY]: { schema: "paperclip.pi-conversation.v1",
        id: sessionId, generation: 1, boundary, previousId: null, reason: "first_message", runId: sourceRunId } } });
    return { companyId, agentId, issueId, sourceRunId, successorRunId, sessionId, wakeId, workspaceId };
  }

  async function pressRetry(f: Awaited<ReturnType<typeof seed>>) {
    let blockedWith: string | null = null;
    const admitted = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      actorType: "user", actorId: "board", reason: "task_retry", commentId: null, successorRunId: f.successorRunId,
      taskRetryRequestId: f.wakeId, onBlocked: (reason, message) => { blockedWith = `${reason}: ${message}`; } });
    expect(blockedWith).toBeNull();
    expect(admitted).not.toBeNull();
    // Queue admission stores the continuation on the one successor run it creates.
    await db.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", invocationSource: "on_demand",
      contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true, taskRetryRequestId: f.wakeId,
        previousRunId: admitted!.previousRunId, explicitUserContinuation: admitted } });
    const select = () => selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: f.successorRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null,
        workspaceId: f.workspaceId, trust: "trust" } });
    return { admitted: admitted!, select };
  }

  const systemNotes = (f: { companyId: string; issueId: string }) => db.select().from(issueComments)
    .where(and(eq(issueComments.companyId, f.companyId), eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));

  it.each(["not_task_owned", "remote"] as const)("opens the first Retry run on a NEW provider thread, restores nothing old, and posts the one fresh-thread note (%s)", async box => {
    const f = await seed(box);
    const { admitted, select } = await pressRetry(f);
    expect(admitted.readiness).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId });
    const conversation = await select();
    // A new session id for the first run: no checkpoint of the old box's scope
    // matches it, so nothing is restored into the new root and the identity
    // check that refuses it (prior_owner_scope_mismatch) is never reached.
    expect(conversation.id).not.toBe(f.sessionId);
    expect(conversation).toMatchObject({ previousId: f.sessionId, runId: f.successorRunId, generation: 2,
      reason: expect.stringMatching(/^fresh_continuation:/) });
    expect(await findNativeSessionResumeRun(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      normalizedSessionId: conversation.id, currentRunId: f.successorRunId, beforeCreatedAt: new Date() })).toBeNull();
    // A replay of the same run keeps that thread: never a second new thread.
    expect(await select()).toEqual(conversation);
    const notes = await systemNotes(f);
    expect(notes.filter(note => note.metadata?.authorizationReason === conversation.reason.replace(/^fresh_continuation:/, "fresh_provider_thread:")))
      .toHaveLength(1);
    // Exactly one run: the Retry's successor is the continuation; nothing else is pending to start.
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.nativeIssueId, f.issueId)));
    expect(runs.map(run => run.id).sort()).toEqual([f.sourceRunId, f.successorRunId].sort());
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,
      conversation.reason.replace(/^fresh_continuation:/, "")));
    expect(action!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: f.successorRunId,
      freshContinuation: { sourceRunId: f.sourceRunId, isolation: "fresh_isolated_workspace" } });
  }, 60_000);

  it("keeps the conversation's session id when the Retry reuses the task's own box", async () => {
    const f = await seed("own_local");
    const { admitted, select } = await pressRetry(f);
    expect(admitted.readiness).toMatchObject({ mode: "reuse_issue_workspace", workspaceId: f.workspaceId });
    const conversation = await select();
    expect(conversation.id).toBe(f.sessionId);
    expect(conversation.reason).toBe("first_message");
    expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:")))
      .toHaveLength(0);
  }, 60_000);

  it("a pressed Retry admitted with its successor in one transaction (as queue admission does) opens a new provider thread", async () => {
    const f = await seed("not_task_owned");
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
    expect(receipt).toMatchObject({ accepted: true });
    // The successor's created_at is this transaction's clock; the record must not be later.
    const admitted = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const continuation = await admitExplicitNativeContinuation({ db: tx as unknown as typeof db, companyId: f.companyId,
        issueId: f.issueId, agentId: f.agentId, actorType: "user", actorId: "board", reason: "task_retry", commentId: null,
        successorRunId: f.successorRunId, taskRetryRequestId: receipt.requestId! });
      await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "queued", invocationSource: "on_demand",
        contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true,
          taskRetryRequestId: receipt.requestId, previousRunId: continuation?.previousRunId, explicitUserContinuation: continuation } });
      return continuation;
    });
    expect(admitted?.readiness).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.successorRunId));
    const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: f.successorRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
    expect(conversation.id).not.toBe(f.sessionId);
    expect(conversation).toMatchObject({ previousId: f.sessionId, runId: f.successorRunId,
      reason: expect.stringMatching(/^fresh_continuation:/) });
    expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:")))
      .toHaveLength(1);
  }, 60_000);

  // The Retry, or an automatic resume filed through the same Retry path, as
  // queue admission runs it: the request, then admission with its successor
  // in one transaction, then the successor's first conversation selection.
  async function retryThroughQueue(f: Awaited<ReturnType<typeof seed>>,
    automatic: Partial<Parameters<typeof requestTaskRetry>[0]> = {}) {
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      idempotencyKey: randomUUID(), observedRunId: f.sourceRunId, ...automatic });
    expect(receipt).toMatchObject({ accepted: true });
    const admitted = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      const continuation = await admitExplicitNativeContinuation({ db: tx as unknown as typeof db, companyId: f.companyId,
        issueId: f.issueId, agentId: f.agentId, actorType: "user", actorId: "board", reason: "task_retry", commentId: null,
        successorRunId: f.successorRunId, taskRetryRequestId: receipt.requestId! });
      await tx.insert(heartbeatRuns).values({ id: f.successorRunId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "queued", invocationSource: "on_demand",
        contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true,
          taskRetryRequestId: receipt.requestId, previousRunId: continuation?.previousRunId, explicitUserContinuation: continuation } });
      return continuation;
    });
    expect(admitted?.readiness).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.successorRunId));
    const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: f.successorRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
    const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.fingerprint, `fresh-continuation:retry:${f.successorRunId}`)));
    return { conversation, record: record! };
  }

  const automaticCount = async (f: { companyId: string; issueId: string }) => {
    const at = new Date(Date.now() + 1_000);
    return { fresh: (await freshContinuationTimes(db, f.companyId, f.issueId, new Date(Date.now() - 3_600_000))).length,
      shared: (await sharedContinuationAttempts(db, f.companyId, f.issueId, at)).length,
      started: (await taskAutomaticAttempts(db, f.companyId, f.issueId, at)).started.length };
  };

  it("a person's Retry into a fresh workspace is labelled person_retry and is NOT counted as an automatic attempt", async () => {
    const f = await seed("not_task_owned");
    const { conversation, record } = await retryThroughQueue(f);
    expect(conversation.id).not.toBe(f.sessionId);
    expect(record.evidence).toMatchObject({ freshContinuation: { trigger: "person_retry" },
      freshContinuationSettlement: { requestedBy: "person_retry" } });
    expect(await automaticCount(f)).toEqual({ fresh: 0, shared: 0, started: 0 });
  }, 60_000);

  // Restart recovery, the provider-limit reset and the budget resume file the
  // Retry for the person (requestedByActorType "user"); they are automatic and
  // must count against the automatic cap, or they could loop uncapped.
  it.each([
    ["restart recovery", { initiatedBy: "restart_recovery" }, "retry_restart_recovery"],
    ["provider-limit reset", { initiatedBy: "provider_limit_reset" }, "retry_provider_limit_reset"],
    ["budget resume", { resumedBy: "budget_resume" }, "retry_budget_resume"],
  ] as const)("an automatic resume (%s) into a fresh workspace opens a new thread, is NOT labelled person_retry, and IS counted", async (_name, automatic, trigger) => {
    const f = await seed("not_task_owned");
    const { conversation, record } = await retryThroughQueue(f, automatic as Partial<Parameters<typeof requestTaskRetry>[0]>);
    expect(conversation.id).not.toBe(f.sessionId);
    expect(conversation).toMatchObject({ previousId: f.sessionId, runId: f.successorRunId,
      reason: `fresh_continuation:${record.id}` });
    expect(record.evidence).toMatchObject({ freshContinuation: { trigger },
      freshContinuationSettlement: { requestedBy: "system" } });
    expect(await automaticCount(f)).toEqual({ fresh: 1, shared: 1, started: 1 });
  }, 60_000);

  it("honours the Retry's record only for the run it is bound to, with that run's fresh readiness and a Retry trigger", async () => {
    const f = await seed("not_task_owned");
    await pressRetry(f);
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.fingerprint, `fresh-continuation:retry:${f.successorRunId}`)));
    const evidence = action!.evidence as Record<string, unknown>;
    const fresh = evidence.freshContinuation as Record<string, unknown>;
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId));
    const context = successor!.contextSnapshot as Record<string, unknown>;
    const continuation = context.explicitUserContinuation as Record<string, unknown>;
    const readiness = continuation.readiness as Record<string, unknown>;
    const boundary = async (change: { evidence?: Record<string, unknown>; readiness?: Record<string, unknown> } = {}) => {
      await db.update(issueRecoveryActions).set({ evidence: change.evidence ?? evidence })
        .where(eq(issueRecoveryActions.id, action!.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, explicitUserContinuation: { ...continuation,
        readiness: change.readiness ?? readiness } } }).where(eq(heartbeatRuns.id, f.successorRunId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId));
      return readFreshContinuationSessionBoundary(db, run!, f.issueId);
    };
    // The record as admitted: its own successor takes the fresh thread.
    expect(await boundary()).toMatchObject({ recoveryActionId: action!.id, sourceRunId: f.sourceRunId,
      sourceSessionId: f.sessionId });
    // Another run's record (M3): bound to a different run, or to none.
    expect(await boundary({ evidence: { ...evidence, continuationRunId: randomUUID() } })).toBeNull();
    const { continuationRunId: _bound, ...unbound } = evidence;
    expect(await boundary({ evidence: unbound })).toBeNull();
    // Another trigger (M4), without the run's isolation context, is ignored.
    expect(await boundary({ evidence: { ...evidence, freshContinuation: { ...fresh, trigger: "held_recovery" } } })).toBeNull();
    const { trigger: _trigger, ...untriggered } = fresh;
    expect(await boundary({ evidence: { ...evidence, freshContinuation: untriggered } })).toBeNull();
    // A foreign Retry's record (h3-ii): the record names this Retry's request,
    // the run's context names the same one, and its readiness agrees.
    expect(fresh.retryIntentId).toBe(f.wakeId);
    expect(await boundary({ evidence: { ...evidence, freshContinuation: { ...fresh, retryIntentId: randomUUID() } } })).toBeNull();
    const { retryIntentId: _intent, ...unintended } = fresh;
    expect(await boundary({ evidence: { ...evidence, freshContinuation: unintended } })).toBeNull();
    expect(await boundary({ readiness: { ...readiness, retryIntentId: randomUUID() } })).toBeNull();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, taskRetryRequestId: randomUUID() } })
      .where(eq(heartbeatRuns.id, f.successorRunId));
    const [foreign] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.successorRunId));
    await db.update(issueRecoveryActions).set({ evidence }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await readFreshContinuationSessionBoundary(db, foreign!, f.issueId)).toBeNull();
    await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, f.successorRunId));
    // A non-fresh admitted readiness (M2): the run reused the box, so its thread is kept.
    expect(await boundary({ readiness: { ...readiness, mode: "reuse_issue_workspace" } })).toBeNull();
    expect(await boundary({ readiness: { ...readiness, sourceRunId: randomUUID() } })).toBeNull();
    // Restored, the record is honoured again: each refusal above was the change alone.
    expect(await boundary()).toMatchObject({ recoveryActionId: action!.id });
  }, 60_000);

  it("a second Retry that reuses the box, after a first fresh one, keeps its session and posts no second note", async () => {
    const f = await seed("not_task_owned");
    const { admitted, select } = await pressRetry(f);
    const first = await select();
    expect(first.id).not.toBe(f.sessionId);
    // The first Retry's run ends; the task now owns a box the second Retry reuses.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), nativeSessionId: first.id })
      .where(eq(heartbeatRuns.id, f.successorRunId));
    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: secondRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", invocationSource: "on_demand",
      createdAt: new Date(Date.now() + 1_000), contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry",
        forceFreshSession: true, previousRunId: f.successorRunId, explicitUserContinuation: { ...admitted,
          readiness: { mode: "reuse_issue_workspace", sourceRunId: f.successorRunId, workspaceId: f.workspaceId } } } });
    const [second] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRunId));
    expect(await readFreshContinuationSessionBoundary(db, second!, f.issueId)).toBeNull();
    const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: secondRunId, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null,
        workspaceId: f.workspaceId, trust: "trust" } });
    // The same thread the first Retry opened: no second rotation for this run.
    expect(conversation).toMatchObject({ id: first.id, generation: first.generation, reason: first.reason });
    expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:")))
      .toHaveLength(1);
  }, 60_000);

  it.each([
    ["still running", { status: "running", finishedAt: null }],
    ["failed but not yet finished", { status: "failed", finishedAt: null }],
    ["finished with success", { status: "succeeded", finishedAt: new Date() }],
  ] as const)("a Retry whose source is %s writes no fresh-thread record and leaves the source's authority", async (_name, state) => {
    const f = await seed("not_task_owned");
    await db.update(heartbeatRuns).set(state).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await recordRetryFreshProviderThread(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.sourceRunId, successorRunId: f.successorRunId, trigger: "person_retry", retryIntentId: f.wakeId })).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.fingerprint, `fresh-continuation:retry:${f.successorRunId}`)))).toHaveLength(0);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(source!.resultJson ?? {}).not.toHaveProperty("freshContinuationSupersededAt");
    // Control: the finished cut-off source does get the record.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(await recordRetryFreshProviderThread(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.sourceRunId, successorRunId: f.successorRunId, trigger: "person_retry", retryIntentId: f.wakeId })).toEqual(expect.any(String));
  }, 60_000);

  // h3-ii (gate 4, RC2A-H3-A2-2): a person's Retry after a failed answer run.
  // The source has only the native terminal hold (no recovery generation), so
  // admission had no fresh candidate; preparation picked the new box after
  // native selection had kept the old Pi thread, and the fence refused it
  // (prior_owner_scope_mismatch). The production path end to end:
  // requestTaskRetry -> heartbeat resumeTaskRetry -> queue admission.
  it("h3-ii: a person's Retry after a failed answer run, on a new box, opens a NEW Pi thread and carries the answer once", async () => {
    const f = await seed("not_task_owned");
    // The answer the failed answer-resume run held: a card the agent asked, the person answered.
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, resolvedByUserId: "board",
      resolvedAt: new Date(), title: "Continue?", idempotencyKey: randomUUID(), payload: { version: 1, questions: [{ id: "q",
        prompt: "Continue?", required: true, selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }], summaryMarkdown: "YES H3_PERSON" } } as never).returning();
    await db.update(heartbeatRuns).set({ errorCode: "native_run_failed", contextSnapshot: { issueId: f.issueId,
      source: "issue.interaction.respond", mutation: "interaction", wakeReason: "issue_commented",
      interactionId: card!.id, interactionIds: [card!.id], interactionStatus: "answered" } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    // Only the native terminal hold the wake queue writes (postgres.ts recordNativeTerminalRecoveryIfNeeded).
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${f.sourceRunId}`,
      nextAction: "The run stopped before it finished. Paperclip continues the task from its last saved work.",
      evidence: { runId: f.sourceRunId, originalFailureCode: "native_run_failed", nativeFailureBlock: { runId: f.sourceRunId } },
      attemptCount: 1, maxAttempts: 3 } as never);
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    // Hold dispatch: the admitted successor is the assertion, not a live turn.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    // The person, as the local board acts (the route's actor).
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const queued = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")))).filter(run => run.contextSnapshot?.issueId === f.issueId);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    // Exactly one successor: pressing Retry acts on the answer once.
    expect(queued, JSON.stringify({ wake: wake && { status: wake.status, payload: wake.payload, error: wake.error } })).toHaveLength(1);
    const successor = queued[0]!;
    expect(successor.contextSnapshot).toMatchObject({ taskRetryRequestId: receipt.requestId, previousRunId: f.sourceRunId,
      interactionIds: [card!.id] });
    // Preparation picks the new box (this task owns no reusable workspace).
    expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "fresh_isolated_workspace",
      sourceRunId: f.sourceRunId, retryIntentId: receipt.requestId });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor.id));
    const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: successor.id, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
    // A NEW Pi conversation id, never the failed run's nativeSessionId.
    expect(conversation.id).not.toBe(f.sessionId);
    expect(conversation).toMatchObject({ previousId: f.sessionId, runId: successor.id, reason: expect.stringMatching(/^fresh_continuation:/) });
    const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.fingerprint, `fresh-continuation:retry:${successor.id}`)));
    expect(record!.evidence).toMatchObject({ continuationRunId: successor.id, freshContinuation: { sourceRunId: f.sourceRunId,
      trigger: "person_retry", retryIntentId: receipt.requestId } });
    // Its built input carries the person's answer (H3's seam -> interactionResponses).
    const responses = await materializeNativeInteractionResponses({ db, companyId: f.companyId, issueId: f.issueId,
      runId: successor.id, agentId: f.agentId, interactionIds: successor.contextSnapshot!.interactionIds as string[],
      wakeReason: "task_retry" });
    expect(responses.map(response => response.interactionId)).toEqual([card!.id]);
    expect(JSON.stringify(responses)).toContain("YES H3_PERSON");
    expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:")))
      .toHaveLength(1);
  }, 90_000);
  // h3-ii-live (gate 4 fam-h3 famh3-retry-2, 2026-11-17 19:50Z, fork fl/h3-fam 094cfd30): the
  // live rows, field by field. Source 1c722cee: native answer-resume run (wakeReason
  // issue_commented, interactionStatus answered), failed native_run_failed after a Pi SIGKILL,
  // its failed result ACCEPTED and COMMITTED (nativePhase committed, coordinator committed,
  // finalizationReasonCode run_failed_partial_evidence_preserved, issue stays in_progress).
  // NO recovery action names it: no native terminal hold, no recovery generation. The
  // conversation owner pressed Retry (receipt 4e20b9f6, actorSource session). Successor
  // bbbdd169: forceFreshSession=true, previousRunId=1c722cee, taskRetryRequestId=4e20b9f6,
  // NO explicitUserContinuation; a NEW box; the OLD Pi id 234bcf10; failed
  // runner_state_identity_mismatch: prior_owner_scope_mismatch. No fresh-continuation:retry record.
  // remote: the old box is a sandbox whose lease carries its termination receipt.
  it.each(["task", "chat", "remote"] as const)("h3-ii-live: a person's Retry of a COMMITTED failed answer run with no hold records the retry-fresh decision at admission and opens a NEW Pi thread on the new box (%s)", async shape => {
    const f = await seed(shape === "remote" ? "remote" : "not_task_owned");
    const settings = instanceSettingsService(db), experimental = await settings.getExperimental();
    const person = `person-${randomUUID()}`;
    try {
      // The conversation owner: a signed-in board member of the company.
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: person,
        status: "active", membershipRole: "owner" });
      const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, resolvedByUserId: person,
        resolvedAt: new Date(), title: "TEST famh3-retry-2 person answer", idempotencyKey: randomUUID(), payload: { version: 1,
          questions: [{ id: "answer", prompt: "Which should I use: ALDER-A or ALDER-B?", required: true, selectionMode: "single",
            options: [{ id: "a", label: "ALDER-A" }, { id: "b", label: "ALDER-B" }] }] },
        result: { version: 1, answers: [{ questionId: "answer", optionIds: ["b"] }], summaryMarkdown: "ALDER-B" } } as never).returning();
      // The live source row: an accepted, committed failed result (no hold names it).
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: contractId,
        createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ errorCode: "native_run_failed", nativePhase: "committed", completionContractId: contractId,
        invocationSource: "automation", triggerDetail: "system", responsibleUserId: person,
        resultJson: { finalizationPhase: "committed", finalizationReasonCode: "run_failed_partial_evidence_preserved",
          issueStatusAfter: "in_progress", prpRunTerminalState: "failed", nativeTerminal: { schema: "paperclip.prp.terminal.v1",
            runTerminalState: "failed", turnTerminalState: "failed", reportedWorkDisposition: "needs_review" } },
        contextSnapshot: { issueId: f.issueId, source: "issue.interaction.respond", mutation: "interaction",
          wakeReason: "issue_commented", interactionId: card!.id, interactionKind: "ask_user_questions",
          interactionStatus: "answered", ...(shape === "chat" ? { conversationSessionGeneration: 0 } : {}) } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.sourceRunId,
        completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
        resultJson: { schema: "paperclip.run_result.v1", summary: "The Pi run failed before it completed.",
          terminal: { runTerminalState: "failed", turnTerminalState: "failed" } } });
      await db.update(nativeRunFinalizations).set({ phase: "committed", resultId, attempt: 1, failureDetail: null })
        .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
      // No recovery action names the source (recovery-actions [] at 19:50:31.919Z).
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
      await db.update(issues).set({ status: "in_progress", ...(shape === "chat" ? { conversationAgentId: f.agentId,
        conversationUserId: person, conversationState: "waiting", conversationSessionGeneration: 0 } : {}) })
        .where(eq(issues.id, f.issueId));
      if (shape === "chat") await settings.updateExperimental({ enableAgentChat: true });
      // Hold dispatch: the admitted successor is the assertion, not a live turn.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      // POST /issues/:id/retry as the conversation owner (route: requestTaskRetry, then resumeTaskRetry).
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: person,
        actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: f.sourceRunId });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
      const queued = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.status, "queued")))).filter(run => run.contextSnapshot?.issueId === f.issueId);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(queued, JSON.stringify({ wake: wake && { status: wake.status, payload: wake.payload, error: wake.error } })).toHaveLength(1);
      const successor = queued[0]!;
      // The live successor's fields (bbbdd169), as queue admission writes them.
      expect(successor.contextSnapshot).toMatchObject({ wakeReason: "task_retry", forceFreshSession: true,
        previousRunId: f.sourceRunId, taskRetryRequestId: receipt.requestId, actorId: person, interactionIds: [card!.id] });
      // Admission adopted the Retry: its readiness is the new box, bound to this Retry.
      expect(successor.contextSnapshot?.explicitUserContinuation).toMatchObject({ previousRunId: f.sourceRunId,
        taskRetryRequestId: receipt.requestId, readiness: { mode: "fresh_isolated_workspace", sourceRunId: f.sourceRunId,
          retryIntentId: receipt.requestId } });
      // The retry-fresh record exists BEFORE selection, naming this Retry.
      const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
        eq(issueRecoveryActions.fingerprint, `fresh-continuation:retry:${successor.id}`)));
      expect(record?.evidence).toMatchObject({ continuationRunId: successor.id, freshContinuation: { sourceRunId: f.sourceRunId,
        trigger: "person_retry", retryIntentId: receipt.requestId } });
      expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "fresh_isolated_workspace",
        sourceRunId: f.sourceRunId, retryIntentId: receipt.requestId });
      // The live successor ran with the chat's generation in its context (bbbdd169: conversationSessionGeneration 0).
      await db.update(heartbeatRuns).set({ status: "running", ...(shape === "chat" ? { contextSnapshot: {
        ...successor.contextSnapshot, conversationSessionGeneration: 0 } } : {}) }).where(eq(heartbeatRuns.id, successor.id));
      const conversation = await selectPiConversation(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        runId: successor.id, boundary: { provider: "pi_rpc", cwd: "/workspaces/new-box", remoteCwd: null, workspaceId: null, trust: "trust" } });
      // A NEW Pi id on the new box, never the failed run's 234bcf10-equivalent.
      expect(conversation.id).not.toBe(f.sessionId);
      expect(conversation).toMatchObject({ previousId: f.sessionId, runId: successor.id,
        reason: `fresh_continuation:${record!.id}` });
      // The answer is carried exactly once.
      const responses = await materializeNativeInteractionResponses({ db, companyId: f.companyId, issueId: f.issueId,
        runId: successor.id, agentId: f.agentId, interactionIds: successor.contextSnapshot!.interactionIds as string[],
        wakeReason: "task_retry" });
      expect(responses.map(response => response.interactionId)).toEqual([card!.id]);
      expect(JSON.stringify(responses)).toContain("ALDER-B");
      expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("fresh_provider_thread:")))
        .toHaveLength(1);
    } finally {
      await settings.updateExperimental({ enableAgentChat: experimental.enableAgentChat });
    }
  }, 90_000);

  // h3-combine 5(a), the live (ii) duplicate shape (stack-lead famh3-retry-2, 19:50-19:52Z): after a
  // person's Retry of a failed answer run, EXACTLY ONE successor answers, once. Only what this head
  // controls: the recovery side (disposition pass, sweep, a second resume of the same Retry) and the
  // carry side (readContinuationCommentInput from the answering run) add no second run carrying the
  // card answer, and the answer is posted once. The generic native_status_decision successor that
  // ran live after the answer (5b235ded, wakeReason issue_status_changed, no interaction ids) is
  // barnbrain-lead's unit 1b and is not asserted here.
  it("h3-combine (ii) live duplicate shape: after a person's Retry of a failed answer run exactly one successor answers, once", async () => {
    const f = await seed("not_task_owned");
    const person = `person-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: person,
      status: "active", membershipRole: "owner" });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, resolvedByUserId: person,
      resolvedAt: new Date(Date.now() - 90_000), title: "TEST famh3-retry-2 person answer", idempotencyKey: randomUUID(), payload: { version: 1,
        questions: [{ id: "answer", prompt: "Which should I use: ALDER-A or ALDER-B?", required: true, selectionMode: "single",
          options: [{ id: "a", label: "ALDER-A" }, { id: "b", label: "ALDER-B" }] }] },
      result: { version: 1, answers: [{ questionId: "answer", optionIds: ["b"] }], summaryMarkdown: "ALDER-B" } } as never).returning();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: contractId,
      createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ errorCode: "native_run_failed", nativePhase: "committed", completionContractId: contractId,
      invocationSource: "automation", triggerDetail: "system", responsibleUserId: person,
      resultJson: { finalizationPhase: "committed", finalizationReasonCode: "run_failed_partial_evidence_preserved",
        issueStatusAfter: "in_progress", prpRunTerminalState: "failed" },
      contextSnapshot: { issueId: f.issueId, source: "issue.interaction.respond", mutation: "interaction",
        wakeReason: "issue_commented", interactionId: card!.id, interactionKind: "ask_user_questions", interactionStatus: "answered" } })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.sourceRunId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", canonicalSha256: resultId,
      resultJson: { schema: "paperclip.run_result.v1", summary: "The Pi run failed before it completed.",
        terminal: { runTerminalState: "failed", turnTerminalState: "failed" } } });
    await db.update(nativeRunFinalizations).set({ phase: "committed", resultId, attempt: 1, failureDetail: null })
      .where(eq(nativeRunFinalizations.runId, f.sourceRunId));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    // Hold dispatch: the admitted successor is the assertion, not a live turn.
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: person,
      actorSource: "session", idempotencyKey: randomUUID(), observedRunId: f.sourceRunId });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const carrying = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.contextSnapshot?.issueId === f.issueId && run.id !== f.sourceRunId
        && (run.contextSnapshot?.interactionId === card!.id
          || (Array.isArray(run.contextSnapshot?.interactionIds) && (run.contextSnapshot!.interactionIds as string[]).includes(card!.id))));
    const [successor, ...extra] = await carrying();
    expect(extra, "one Retry successor carries the answer").toHaveLength(0);
    expect(successor!.contextSnapshot).toMatchObject({ taskRetryRequestId: receipt.requestId, interactionIds: [card!.id] });
    // The Retry successor runs and ANSWERS (the live dcce6481 reply, H3_FINAL ... ALDER-B), then ends.
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, successor!.id));
    expect((await materializeNativeInteractionResponses({ db, companyId: f.companyId, issueId: f.issueId, runId: successor!.id,
      agentId: f.agentId, interactionIds: [card!.id], wakeReason: "task_retry" })).map(r => r.interactionId)).toEqual([card!.id]);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: successor!.id, body: "H3_FINAL famh3-retry-2 ALDER-B" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor!.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy!.id));
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    // The recovery side, twice, as the server runs it; the same Retry resumed again.
    for (let pass = 0; pass < 2; pass += 1) {
      await settleUnrecoverableExecutions(db);
      await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
      await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId });
      await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    }
    expect((await carrying()).map(run => run.id), "no second successor carries the answer").toEqual([successor!.id]);
    // The carry side: a seed from the answering run never carries the answered card again.
    const seedInput = await readContinuationCommentInput(db, { companyId: f.companyId, issueId: f.issueId, runId: successor!.id });
    expect(seedInput.interactionIds ?? [], "an answered card is not pending input for a later seed").not.toContain(card!.id);
    // The answer is posted once, and the sweep owes the card nothing.
    const posts = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "agent")));
    expect(posts.map(post => post.body)).toEqual(["H3_FINAL famh3-retry-2 ALDER-B"]);
    expect((await systemNotes(f)).filter(note => String(note.metadata?.authorizationReason ?? "").startsWith("unanswered_message:")))
      .toHaveLength(0);
  }, 90_000);
});
