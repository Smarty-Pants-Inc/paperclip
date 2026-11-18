import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, environments,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// The withheld accepted reply (DESIGN option (c)).
//
// REAL in every row (the route or producer is named at its call):
//   the person's message M ...... POST /api/issues/:id/comments (routes/issues.ts)
//   the streamed answer ......... NativeRunCoordinatorStore.appendEvent (item.delta, item.completed)
//   acceptance .................. NativeRunCoordinatorStore.completeRun
//   every copy-back attempt ..... reconcileNativeFinalizations -> attemptNativeWorkspaceFinalization
//                                 -> recordNativeWorkspaceFinalizationFailure -> recordNativeFinalizationFailure
//   the pause cancel ............ POST /api/agents/:id/pause (routes/agents.ts -> heartbeat.cancelActiveForAgent)
//   the board Retry ............. retryNativeWorkspaceExport (the function behind
//                                 POST /api/issues/:id/recovery-actions/retry-workspace-export)
//   publication ................. the reply-presentation worker (register, or load + check)
//   what the person sees ........ GET /api/issues/:id/comments
//   answered / the sweep ........ answeredPersonMessageSql / settleUnansweredPersonMessagesForTask
// FAKED: only the box. resolveEnvironmentExecutionTarget and resumeNativeWorkspaceSync (the
// sandbox export) are scripted; the board Retry gets a scripted environment runtime.
// PLANTED (named, no real-path twin in this file; see result.md): the run row that carries M
// and its sandbox lease. The heartbeat executor that would create them needs a live provider.
const box = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("../environment-execution-target.js", async importOriginal => ({
  ...await importOriginal<typeof import("../environment-execution-target.js")>(),
  resolveEnvironmentExecutionTarget: async () => ({ kind: "remote", transport: "sandbox", remoteCwd: "/work",
    runner: { execute: async () => ({ exitCode: 0, timedOut: false }) } }),
}));
vi.mock("./native-workspace-sync.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-workspace-sync.js")>(),
  resumeNativeWorkspaceSync: box.resume,
}));
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_REASON_PREFIX } from "../recovery/unanswered-person-message.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

// The words are RFL's to finalize; the constants live in native-withheld-reply.ts.
// At the base commit that module does not exist, so the drafts stand in and every row is red on behaviour.
const withheldModule = "./native-withheld-reply.js";
const words: { FILE_LINE_LOST?: string; FILE_LINE_KEPT?: string } = await import(/* @vite-ignore */ withheldModule).catch(() => ({}));
const FILE_LINE_LOST = words.FILE_LINE_LOST ?? "The file changes from this reply couldn't be saved.";
const FILE_LINE_KEPT = words.FILE_LINE_KEPT ?? "The file changes from this reply are kept and can be recovered from the task's saved files.";

const RENDER_FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../ui/src/components/__fixtures__/withheld-reply-thread.json");
const PERSON = "withheld-person";
/** Measured waits, for the record (WITHHELD_REPLY_TIMINGS=<file>). */
function timing(label: string, since: number) {
  const file = process.env.WITHHELD_REPLY_TIMINGS;
  if (file) void fs.appendFile(file, `${label}: ${Math.round(performance.now() - since)} ms\n`);
}
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("withheld accepted reply: published once when the run ends without a committed reply", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const environmentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-withheld-reply-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "withheld@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(environments).values({ id: environmentId, name: `Box ${environmentId}`, driver: "sandbox" });
  }, 120_000);
  afterEach(() => { vi.useRealTimers(); box.resume.mockReset(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  // The streamed answer, in the pieces the person watched arrive.
  const STREAM = ["Done. I renamed the helper ", "and updated its two callers.\n\n", "- `src/util.ts`\n- `src/app.ts`  \n", "Tests pass ✅"];
  const ANSWER = STREAM.join("");

  async function scenario() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Withheld reply", issuePrefix: `W${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "fixture" }, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Rename the helper", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `W${companyId.slice(0, 6)}-1` });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);

    // REAL: the person's message M.
    const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Please rename the helper.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const messageId: string = sent.body.id;

    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Rename the helper", criteria: [] },
      canonicalSha256: `withheld-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    // PLANTED: the native run that carries M, already executing in its box.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", responsibleUserId: PERSON, startedAt: new Date(),
      contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented", wakeCommentId: messageId, commentId: messageId },
      runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(),
        leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "ephemeral", metadata: { pluginId: "plugin-test" } });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, issueId));

    const store = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    let sourceSeq = 0;
    const event = (eventType: string, payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", schemaVersion: 1, runId, normalizedSessionId: sessionId, turnId: "answer-turn", itemId: "answer-item",
      sourceInstanceId: runnerId, sourceEventId: `answer-${++sourceSeq}`, sourceSeq, sourceKind: "runner", eventType, priority: 0,
      emittedAt: new Date().toISOString(), payload } as PrpEvent);
    /** REAL: the runner's stream, then its accepted result. */
    async function streamAndAccept() {
      for (const text of STREAM) await store.appendEvent(event("item.delta", { kind: "agentMessage", channel: "final", text }));
      await store.appendEvent(event("item.completed", { kind: "agentMessage", channel: "final", providerPhase: "final", text: ANSWER }));
      await store.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
        summary: "Renamed the helper.", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
        terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
        turnId: "answer-turn" });
    }
    const runtime = { resumeRunLease: vi.fn(async () => ({ providerLeaseId, metadata: { remoteCwd: "/work" } })),
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" })) };
    /** REAL: one copy-back attempt by the reconciler; a success also commits the result. */
    const copyBack = () => reconcileNativeFinalizations(db, [runId], { environmentRuntime: runtime as never });
    const coordinator = async () => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0];
    const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    /** REAL: the reply-presentation worker's own discovery and check, as after a restart. */
    async function presentationWorker() {
      const work = nativeResponsePresentationWork(db);
      for (const entry of await work.load({ companyId, issueId })) await work.check(entry);
    }
    /** REAL: what the person's thread loads. */
    async function thread() {
      const got = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return got.body as Array<{ id: string; body: string; authorType: string; authorAgentId: string | null; createdByRunId: string | null; metadata?: any }>;
    }
    const replies = async () => (await thread()).filter(comment => comment.authorType === "agent");
    /** The ONE answered rule, asked about M. */
    async function answered() {
      const m = { id: sql`m.id`, companyId: sql`m.company_id`, issueId: sql`m.issue_id`, createdAt: sql`m.created_at` };
      const rows = await db.execute<{ answered: boolean }>(sql`select ${answeredPersonMessageSql(m)} as answered from ${issueComments} m where m.id = ${messageId}`);
      return [...rows].map(row => row.answered);
    }
    /** M is answered once, and the unanswered sweep has nothing to say about it. */
    async function expectAnsweredOnceAndNoNotice() {
      expect(await answered()).toEqual([true]);
      const far = new Date(Date.now() + 30 * 60_000);
      expect(await settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: far })).toEqual({ noticed: 0, pending: 0 });
      const notices = (await thread()).filter(comment =>
        String(comment.metadata?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX));
      expect(notices).toEqual([]);
    }
    /** Three failed copy-backs while the box still exists: retry_exhausted. */
    async function failCopyBackThreeTimes() {
      box.resume.mockRejectedValue(new Error("Daytona syncOut directory download failed: timeout"));
      // Each retry is due 30 s after the last. Only the clock moves, and only
      // forward (afterEach restores it): no saved deadline is edited.
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      for (let attempt = 1; attempt <= 3; attempt++) {
        await copyBack();
        expect((await coordinator()).failureDetail).toMatchObject({ workspaceFinalizeAttempt: attempt });
        if (attempt < 3) vi.setSystemTime(Date.now() + 31_000);
      }
      expect(await coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_retry_exhausted" });
    }
    /** REAL: the board's Retry of the saved-files export, then a copy-back that works. */
    async function boardRetrySucceeds() {
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted")));
      // The box (faked): the platform stopped the retained sandbox after the terminal write.
      // PLANTED: its stop receipt, in the provider's own receipt shape; the export marker stays.
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId, state: "stopped" }) } })
        .where(eq(environmentLeases.id, leaseId));
      await expect(retryNativeWorkspaceExport({ db, companyId, issueId, actionId: action.id, runId, actorId: PERSON,
        repairNote: "The sandbox provider is reachable again; the saved work is preserved.", environmentRuntime: runtime as never }))
        .resolves.toMatchObject({ status: "queued" });
      box.resume.mockReset().mockResolvedValue(true);
      await copyBack();
      expect(await coordinator()).toMatchObject({ phase: "committed" });
    }
    return { app, companyId, agentId, issueId, runId, leaseId, messageId, streamAndAccept, copyBack, coordinator, run, presentationWorker,
      thread, replies, answered, expectAnsweredOnceAndNoNotice, failCopyBackThreeTimes, boardRetrySucceeds };
  }

  it("R1: accept -> copy-back fails 3 times with the box retained -> the registered worker posts exactly 1 reply + the KEPT line", async () => {
    const s = await scenario();
    const errors: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(delivery, () => true);
    try {
      await worker.ready;
      await s.streamAndAccept();
      expect(await s.replies()).toEqual([]);
      await s.failCopyBackThreeTimes();
      const terminalAt = performance.now();
      // No test-side call into the worker: the terminal write alone must make it publish.
      await vi.waitFor(async () => expect(await s.replies()).toHaveLength(1), { timeout: 15_000, interval: 25 });
      timing("R1 terminal write -> published reply (registered worker)", terminalAt);
      expect(errors).toEqual([]);
    } finally { worker.stop(); await delivery.stop(); }
    const [reply] = await s.replies();
    expect(reply).toMatchObject({ body: `${ANSWER}\n\n${FILE_LINE_KEPT}`, authorAgentId: s.agentId, createdByRunId: s.runId });
    // The box is retained for the board's "Recover saved files": the terminal write tagged its lease.
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId)))[0])
      .toMatchObject({ status: "pending_cleanup", metadata: { nativeWorkspaceExportResume: { runId: s.runId } } });
    expect((await s.run()).resultJson).toMatchObject({
      presentationDecision: { commentAction: "create", commentId: reply.id },
      nativeWithheldReply: { state: "published", fileLine: "kept", commentId: reply.id,
        resultId: (await s.coordinator()).resultId, canonicalSha256: expect.any(String),
        failureCode: "native_workspace_sync_out_retry_exhausted" } });
    await s.expectAnsweredOnceAndNoNotice();
    // A restarted worker finds nothing left to publish.
    await s.presentationWorker(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("R2 + R2s: accept -> the agent is paused -> the box is gone -> terminal on the first copy-back -> 1 reply, the streamed text byte for byte + the LOST line", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    // REAL: the pause route cancels the agent's running run (errorCode agent_paused).
    const paused = await request(s.app).post(`/api/agents/${s.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(await s.run()).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
    // The accepted result survives the cancel; nothing is published by it.
    expect((await s.coordinator()).resultId).toEqual(expect.any(String));
    expect(await s.replies()).toEqual([]);
    // The box: a pause stops and releases it. Its lease is then no longer exportable.
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    const startedAt = performance.now();
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_unrecoverable",
      failureDetail: { workspaceFinalizeAttempt: 1 } });
    expect(box.resume).not.toHaveBeenCalled();
    await s.presentationWorker();
    timing("R2 start of the first copy-back -> published reply (one worker pass)", startedAt);
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    // R2s: byte for byte the streamed text, then the one file line.
    expect(Buffer.from(replies[0].body).equals(Buffer.from(`${ANSWER}\n\n${FILE_LINE_LOST}`))).toBe(true);
    expect(Buffer.from(replies[0].body.slice(0, ANSWER.length)).equals(Buffer.from(STREAM.join("")))).toBe(true);
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", fileLine: "lost",
      failureCode: "native_workspace_sync_out_unrecoverable" } });
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("R3: the healthy committed control is unchanged: nothing before the commit, then exactly 1 reply with no file line", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    expect(await s.replies()).toEqual([]);
    expect((await s.coordinator()).phase).not.toBe("committed");
    box.resume.mockResolvedValue(true);
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    await s.presentationWorker(); await s.presentationWorker();
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(ANSWER);
    expect((await s.run()).status).toBe("succeeded");
    expect((await s.run()).resultJson).not.toHaveProperty("nativeWithheldReply");
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("R4: after the withheld reply is published, a board Retry that succeeds commits the run and posts nothing more", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    await s.presentationWorker();
    const before = await s.replies();
    expect(before).toHaveLength(1);
    await s.boardRetrySucceeds();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    const after = await s.replies();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, body: `${ANSWER}\n\n${FILE_LINE_KEPT}` });
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("R5: accept -> cancel -> the retried copy-back succeeds -> exactly 1 reply with NO file line", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const paused = await request(s.app).post(`/api/agents/${s.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(await s.run()).toMatchObject({ status: "cancelled" });
    // The box survived the cancel this time, and its export works.
    box.resume.mockResolvedValue(true);
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect((await s.run()).status).toBe("cancelled");
    await s.presentationWorker();
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(ANSWER);
    expect(replies[0].body).not.toContain(FILE_LINE_LOST);
    expect(replies[0].body).not.toContain(FILE_LINE_KEPT);
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", fileLine: null, failureCode: null } });
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("RENDERED-THREAD source: the real GET after a LOST publish is the fixture the ui test renders", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.copyBack();
    await s.presentationWorker();
    const comments = (await s.thread()).map(comment => ({ authorType: comment.authorType, body: comment.body,
      byRun: comment.createdByRunId === s.runId, isMessage: comment.id === s.messageId }));
    // REAL: the card's source, the recovery action the terminal write opened (GET /api/issues/:id).
    const detail = await request(s.app).get(`/api/issues/${s.issueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const action = detail.body.recoveryAction ?? detail.body.activeRecoveryAction;
    expect(action).toMatchObject({ cause: "native_workspace_sync_out_unrecoverable", ownerType: "board" });
    const fixture = { comments, issueStatus: detail.body.status,
      recoveryAction: { kind: action.kind, status: action.status, ownerType: action.ownerType, cause: action.cause, nextAction: action.nextAction } };
    if (process.env.UPDATE_WITHHELD_REPLY_FIXTURE === "1") {
      await fs.mkdir(path.dirname(RENDER_FIXTURE), { recursive: true });
      await fs.writeFile(RENDER_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    expect(JSON.parse(await fs.readFile(RENDER_FIXTURE, "utf8"))).toEqual(fixture);
    expect(comments.filter(comment => comment.authorType === "agent")).toEqual([
      { authorType: "agent", body: `${ANSWER}\n\n${FILE_LINE_LOST}`, byRun: true, isMessage: false }]);
  }, 120_000);
});
