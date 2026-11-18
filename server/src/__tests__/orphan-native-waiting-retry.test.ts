import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb,
  heartbeatRuns, issues, issueComments, nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../vendor/paperclip-runner/testing.js";

const fixture = vi.hoisted(() => ({
  sourceExecute: vi.fn(),
  blockNext: null as Promise<void> | null,
  calls: [] as { runId: string; prompt: string; handoff: string | null; nativeContinuationSource: string | null; hasTypedInput: boolean }[],
  db: undefined as unknown, companyId: "", agentId: "", issueId: "",
}));
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>()), executeNativeSession: fixture.sourceExecute,
}));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    const runId = input.execution.binding.runId;
    const handoff = await input.getFreshSessionHandoff?.() ?? null;
    const { readNativeContinuationSource } = await import("../services/native-runtime/native-continuation-delivery.js");
    const nativeContinuationSource = await readNativeContinuationSource(fixture.db as any, { companyId: fixture.companyId, issueId: fixture.issueId, runId });
    const hasTypedInput = `${input.execution.task.prompt}\n${handoff ?? ""}`.includes("Typed: please answer the never-twice request.");
    fixture.calls.push({ runId, prompt: input.execution.task.prompt, handoff, nativeContinuationSource, hasTypedInput });
    const block = fixture.blockNext; fixture.blockNext = null; await block;
    if (!hasTypedInput) return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "no typed input; no answer" };
    const { issueService } = await import("../services/issues.js");
    await issueService(fixture.db as any).addComment(fixture.issueId,
      `Answer to the typed request from ${runId}`,
      { agentId: fixture.agentId, runId }, { completionReply: true });
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "answered" };
  }) as typeof actual.executePaperclipNativeSession };
});
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deliverConversationComments, undeliveredConversationComments, prepareConversationTurn } from "../services/agent-conversations.js";
import { buildNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";

// Real native terminal/finalizer/committer creates the queued retry intent.
// Only provider execution is scripted; no fabricated native-decision lineage.
describe("rf4: native retry exists only as a queued wake when typed outbox runs", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let home: string; const prevHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("rf4-native-waiting-"); db = createDb(temp.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "rf4-native-waiting-")); process.env.PAPERCLIP_HOME = home;
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => {
    if (prevHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = prevHome;
    await db?.$client.end({ timeout: 1 }); await temp?.cleanup();
    const writable = async (dir: string): Promise<void> => { const st = await fs.lstat(dir).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) return; await fs.chmod(dir, 0o700); for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name)); };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
  });

  it("a real queued native failed-turn retry and outbox must not both answer the typed request", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(authUsers).values({ id: "rf4-native-person", name: "Person", email: "rf4@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Native retry", issuePrefix: `N${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "rf4-native-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "rf4-native-person", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "openrouter/test-model" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    let [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_review", workMode: "standard",
      assigneeAgentId: agentId, responsibleUserId: "rf4-native-person", createdByUserId: "rf4-native-person",
      conversationAgentId: agentId, conversationUserId: "rf4-native-person", conversationState: "waiting" }).returning();
    const [m] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "rf4-native-person", authorType: "user",
      origin: "comment", clientRequestId: randomUUID(), body: "Typed: please answer the never-twice request." }).returning();
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "claimed", requestedByActorType: "user", requestedByActorId: "rf4-native-person",
      idempotencyKey: `conversation-comment:${m.id}`, payload: { issueId, commentId: m.id } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue",
      status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: "rf4-native-person",
      invocationSource: "on_demand", triggerDetail: "manual", wakeupRequestId: receipt.id,
      contextSnapshot: { issueId, taskKey: issueId, commentId: m.id, wakeCommentId: m.id, wakeCommentIds: [m.id] } }).returning();
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    // Run the actual heartbeat conversation preparation; do not invent the failed-turn state.
    await prepareConversationTurn(db, run);
    [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const startedIssue = { status: issue.status, conversationState: issue.conversationState };
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: m.body, workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const event: PrpEvent = { schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-terminal", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: { code: "opencode_empty_response", message: "No answer", retryable: false } } };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    fixture.sourceExecute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture",
        driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    // This FIRST provider call reports failure and writes NO answer. Every later typed call
    // goes through fixture.executePaperclipNativeSession above and writes one answer.
    const actual = await vi.importActual<typeof import("../services/native-runtime/native-session-executor.js")>("../services/native-runtime/native-session-executor.js");
    await actual.executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
      backend: { descriptor: async () => { throw new Error("unexpected provider"); }, openSession: async () => { throw new Error("unexpected provider"); } } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [failedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [failedReceipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    const failedReplies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorAgentId, agentId)));
    // finalizeNativeRun projects the failed run and settles its source wake; no manual state writes.
    expect(startedIssue).toEqual({ status: "in_progress", conversationState: "active" });
    expect(failedIssue.conversationState).toBe("active");
    expect(failedReceipt.status).toBe("failed");
    expect(failedReplies).toHaveLength(0);
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const initialWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const pendingBefore = await undeliveredConversationComments(db, companyId, issueId);
    fixture.db = db; fixture.companyId = companyId; fixture.agentId = agentId; fixture.issueId = issueId; fixture.calls = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    let release!: () => void;
    fixture.blockNext = new Promise<void>(resolve => { release = resolve; });
    let dispatch: unknown;
    try {
      await deliverConversationComments(db, failedIssue, (id, opts) => heartbeat.wakeup(id, opts));
      if (pendingBefore.length > 0) await expect.poll(() => fixture.calls.length, { timeout: 10_000 }).toBe(1);
      // The outbox has admitted M1, but has not published its answer yet.
      // Dispatch the already durable retry while the chat is replying, not after
      // the waiting-conversation guard would suppress it.
      dispatch = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    } finally { release(); }
    await heartbeat.drainActiveRunExecutions();
    for (let i = 0; i < 8; i++) { await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions(); await new Promise(r => setTimeout(r, 200)); }
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const replies = await db.select({ id: issueComments.id, runId: issueComments.createdByRunId, body: issueComments.body }).from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorAgentId, agentId)));
    await fs.writeFile(path.join(process.env.TASK_OUT!, "native-waiting-retry.json"), JSON.stringify({ m1: m.id, sourceRunId: runId,
      startedIssue, failedIssue, failedReceipt, failedReplyCount: failedReplies.length,
      decisions, initialWakes, pendingBefore: pendingBefore.map(row => row.id), dispatch, calls: fixture.calls, replies,
      runs: runs.map(r => ({ id: r.id, status: r.status, ctx: r.contextSnapshot })), wakes }, null, 2));
    expect(initialWakes.some(w => w.requestedByActorId === "native-status-committer" && w.runId === null), "real queued retry must exist").toBe(true);
    expect(fixture.calls.every(call => call.hasTypedInput), "only answer when the real prompt/handoff supplies the typed text").toBe(true);
    const retryIntent = initialWakes.find(w => w.requestedByActorId === "native-status-committer" && w.runId === null)!;
    expect(decisions.some(d => d.id === retryIntent.payload?.nativeDecisionId && d.runId === runId && d.applicationState === "applied"), "queued retry was genuinely committed for the failed source run").toBe(true);
    const retryCall = fixture.calls.find(call => runs.find(r => r.id === call.runId)?.contextSnapshot?.nativeStatusWakeIntentId === retryIntent.id);
    if (retryCall) expect(retryCall.handoff, "fresh retry context contains M1, not merely a blindly scripted reply").toContain("Typed: please answer the never-twice request.");
    // Do not require two answering calls: one owner answering once is a valid design.
    expect(replies, "outbox and queued native retry must not both answer").toHaveLength(1);
  }, 120_000);
});
