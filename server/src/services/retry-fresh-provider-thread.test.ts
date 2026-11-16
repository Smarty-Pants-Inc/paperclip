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
  agents, agentTaskSessions, agentWakeupRequests, companies, createDb, environmentLeases, environments, executionWorkspaces,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
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
      contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", forceFreshSession: true,
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
          previousRunId: continuation?.previousRunId, explicitUserContinuation: continuation } });
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
});
