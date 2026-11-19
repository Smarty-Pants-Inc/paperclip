import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, environments,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations, agentWakeupRequests, type Db } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// NOFLIP rows (RULING RFL 11-19 05:33Z, CHOICE 2 (C)): K12, K15a, K15b, K15c.
// The harness below is native-withheld-reply.test.ts's own (same real routes and producers, named
// at their calls). Added for these rows, each named at its call:
//   the SYSTEM recovery ......... reconcileRetainedWorkspaces (the call heartbeat/recovery.ts:976 makes at
//                                 server startup, and :3149 on its timer) -> recoverRetainedWorkspace
//                                 -> resumePreservedResultFinalization; then the finalizer's own pass
//   Retry export ................ retryNativeWorkspaceExport (the function behind
//                                 POST /api/issues/:id/recovery-actions/retry-workspace-export)
//   outcomes .................... GET /api/issues/:id/runs (status, file line), GET /api/issues/:id/comments
// NAMED INJECTION SAVE-TIMES-OUT: the box's save call fails with a timeout three times (the retry budget).
// PLANTED (named at each use): the box's stop receipt (the provider's own receipt shape; no provider
// here), an expired lease (as row R2 of the withheld file), and in K15c the newer run row.
//
// (the withheld file's own header follows)
// The withheld accepted reply (DESIGN option (c)).
//
// REAL in every row (the route or producer is named at its call):
//   the person's message M ...... POST /api/issues/:id/comments (routes/issues.ts)
//   the streamed answer ......... NativeRunCoordinatorStore.appendEvent (item.delta, item.completed)
//   acceptance .................. NativeRunCoordinatorStore.completeRun
//   acceptance, the runner's ..... PaperclipControlPlanePort.openRun / appendEvent / completeRun, in the
//                                 order packages/paperclip-runner native-session-runtime.ts calls them (F1 rows)
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
// L3 P-c exception: real prepare/resumeNativeWorkspaceSync and real lease-cleanup
// producers; only sandbox command execution/stop are substituted at the box boundary.
// PLANTED (named, no real-path twin in this file; see result.md): the run row that carries M
// and its sandbox lease. The heartbeat executor that would create them needs a live provider.
const box = vi.hoisted(() => ({ resume: vi.fn(), targets: new Map<string, AdapterSandboxExecutionTarget>() }));
// The ONE switch, WITHHELD_REPLY_TRIGGER. It ships as "acceptance" (Ruling P; row T0 reads the real
// module). "shipped" = the REAL exported value, unmocked: every acceptance row (A*, P*) runs on it,
// so turning the shipped switch back to "terminal" turns them red. The R rows pass the other
// setting, "terminal", as a parameter here.
const setting = vi.hoisted(() => ({ trigger: "terminal" as "terminal" | "shipped" }));
vi.mock("./native-withheld-reply-trigger.js", async importOriginal => {
  const original = await importOriginal<typeof import("./native-withheld-reply-trigger.js")>();
  return { ...original, get WITHHELD_REPLY_TRIGGER() { return setting.trigger === "shipped" ? original.WITHHELD_REPLY_TRIGGER : setting.trigger; } };
});
vi.mock("../environment-execution-target.js", async importOriginal => ({
  ...await importOriginal<typeof import("../environment-execution-target.js")>(),
  resolveEnvironmentExecutionTarget: async (input: { leaseId?: string }) => box.targets.get(input.leaseId!) ?? ({ kind: "remote", transport: "sandbox", remoteCwd: "/work",
    runner: { execute: async () => ({ exitCode: 0, timedOut: false }) } }),
}));
vi.mock("./native-workspace-sync.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-workspace-sync.js")>(),
  resumeNativeWorkspaceSync: box.resume,
}));
import { FILE_LINE_KEPT_NO_BUTTON, FILE_LINE_NOT_SAVED_YET, FILE_LINE_SAVING, readReplyFileLine, replyFileLineText } from "@paperclipai/shared";
import { nativeRunResults } from "@paperclipai/db";
import { activityRoutes } from "../../routes/activity.js";
import { nativeWithheldReplyCandidates, publishWithheldAcceptedReply } from "./native-withheld-reply.js";
import { nativeResponsePresentationCandidates } from "./native-response-presentation-query.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { errorHandler } from "../../middleware/index.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_REASON_PREFIX } from "../recovery/unanswered-person-message.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { heartbeatService } from "../heartbeat.js";
import { registerRunDispatchWork } from "../heartbeat/dispatch-work.js";
import { environmentRuntimeService, type EnvironmentRuntimeDriver } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { issueService } from "../issues.js";
import os from "node:os";
import { classifyEnvironmentCapabilities } from "../environment-runtime.js";
import { reconcileRetainedWorkspaces } from "../workspace-recovery.js";
import { attachPreservedWorkspaceSnapshots } from "../workspace-recovery-snapshot.js";
import { readSystemRecovery } from "../system-recovery-state.js";

// The words are RFL's to finalize; every one lives in packages/shared/src/reply-file-line.ts.
import { FILE_LINE_KEPT, FILE_LINE_LOST } from "./native-withheld-reply.js";

const RENDER_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../ui/src/components/__fixtures__");
const SAVING_DEADLINE_MS = 10 * 60_000;
/** The task row after a healthy commit in this file's scenario (no status worker runs here); the same under both settings. */
const HEALTHY_TASK_AFTER_COMMIT = (runId: string) => ({ status: "in_progress", executionRunId: runId });
const PERSON = "withheld-person";
/** Measured waits, for the record (WITHHELD_REPLY_TIMINGS=<file>). */
function timing(label: string, since: number) {
  const file = process.env.WITHHELD_REPLY_TIMINGS;
  if (file) void fs.appendFile(file, `${label}: ${Math.round(performance.now() - since)} ms\n`);
}
async function l3Evidence(label: string, value: unknown) {
  const line = `${label} ${JSON.stringify(value)}\n`;
  console.log(line.trimEnd());
  if (process.env.L3_EVIDENCE) await fs.appendFile(process.env.L3_EVIDENCE, line);
}
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("NOFLIP (RFL 11-19): a run that already ended is never rewritten; a late save follows K15", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const environmentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-noflip-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "withheld@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(environments).values({ id: environmentId, name: `Box ${environmentId}`, driver: "sandbox" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    // The kept-aside snapshot store and the sync descriptors live under a scratch home, never the real one.
    process.env.PAPERCLIP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "noflip-home-")); process.env.PAPERCLIP_INSTANCE_ID = "noflip";
  }, 120_000);
  afterEach(() => { vi.useRealTimers(); box.resume.mockReset(); box.targets.clear(); setting.trigger = "terminal"; });
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
  });

  // The streamed answer, in the pieces the person watched arrive.
  const STREAM = ["Done. I renamed the helper ", "and updated its two callers.\n\n", "- `src/util.ts`\n- `src/app.ts`  \n", "Tests pass ✅"];
  const ANSWER = STREAM.join("");

  async function scenario(options: { chat?: boolean; wakeOnDemand?: boolean; realSync?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Withheld reply", issuePrefix: `W${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "fixture" }, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Rename the helper", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `W${companyId.slice(0, 6)}-1`,
      // An Agent Chat conversation: the person's own thread with this agent.
      ...(options.chat ? { conversationAgentId: agentId, conversationUserId: PERSON, conversationState: "active" } : {}) });
    const [{ generation }] = await db.select({ generation: issues.conversationSessionGeneration }).from(issues).where(eq(issues.id, issueId));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {}));
    app.use("/api", activityRoutes(db)); app.use(errorHandler);

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
      contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented", wakeCommentId: messageId, commentId: messageId,
        ...(options.chat ? { conversationSessionGeneration: generation } : {}) },
      runnerProfileJson: options.realSync ? {} : { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(),
        leaseId, providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy" } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "ephemeral", metadata: { pluginId: "plugin-test", remoteCwd: "/work" } });
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, issueId));
    // The planted run R stands for M's own wake, so M's wake stays off above. From here on the
    // agent wakes on a person's message, as in production (P-c).
    if (options.wakeOnDemand) await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));

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
    // The runner's own production acceptance path (RFL F1). REAL: PaperclipControlPlanePort, bound as
    // native-session-executor.ts binds it, driven in the order native-session-runtime.ts drives it:
    // openRun, the stream, the two control events (run.result.accepted, run.terminal), completeRun.
    const controlPlaneId = randomUUID();
    const RESULT = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "done" as const,
      summary: "Renamed the helper.", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const TERMINAL = { schema: "paperclip.prp.terminal.v1" as const, runTerminalState: "succeeded" as const,
      turnTerminalState: "completed" as const, reportedWorkDisposition: "done" as const };
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId,
      completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: controlPlaneId });
    /** REAL: the runner's stream and its accepted result, through the PORT (not the coordinator store). */
    async function streamAndAcceptThroughPort() {
      await port.openRun({ identity: { companyId, issueId, runId, agentId, sessionId }, backendKind: "runner", sourceInstanceId: runnerId });
      for (const text of STREAM) await port.appendEvent(event("item.delta", { kind: "agentMessage", channel: "final", text }));
      await port.appendEvent(event("item.completed", { kind: "agentMessage", channel: "final", providerPhase: "final", text: ANSWER }));
      const control = (seq: number, eventType: string, payload: Record<string, unknown>): PrpEvent => ({
        schema: "paperclip.prp.event.v1", schemaVersion: 1, runId, normalizedSessionId: sessionId, turnId: "answer-turn",
        sourceInstanceId: controlPlaneId, sourceEventId: `${controlPlaneId}:${runId}:${seq}`, sourceSeq: seq, sourceKind: "control_plane",
        eventType, priority: 0, emittedAt: new Date().toISOString(), payload } as PrpEvent);
      await port.appendEvent(control(1, "run.result.accepted", { result: RESULT }));
      await port.appendEvent(control(2, "run.terminal", TERMINAL));
      await port.completeRun({ result: RESULT, terminal: TERMINAL, turnId: "answer-turn",
        callerResultId: `${runnerId}:${runId}:result`, callerDedupeKey: `${runId}:${contract.canonicalSha256}` });
    }
    /** REAL: a coordinator replay of the same accepted result (NativeRunCoordinatorStore.completeRun). */
    const coordinatorReplay = () => store.completeRun({ result: RESULT, terminal: TERMINAL, turnId: "answer-turn" })
      .then(done => done.disposition, (error: Error) => `refused:${error.message}`);
    const runtime = { resumeRunLease: vi.fn(async () => ({ providerLeaseId, metadata: { remoteCwd: "/work" } })),
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" })) };
    /** REAL: one copy-back attempt by the reconciler; a success also commits the result. */
    const copyBack = (options: { skipNativeResponsePresentation?: boolean } = {}) =>
      reconcileNativeFinalizations(db, [runId], { environmentRuntime: runtime as never, ...options });
    const coordinator = async () => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0];
    const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    /** What the commit did to the task itself: the committed path's other effects, beside the reply. */
    const task = async () => { const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      return { status: row.status, executionRunId: row.executionRunId }; };
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
    /** REAL: the run as the person's thread loads it beside the comments (GET /api/issues/:id/runs). */
    async function servedRun() {
      const got = await request(app).get(`/api/issues/${issueId}/runs`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return (got.body as Array<{ runId: string; status: string; resultJson: Record<string, any> | null }>).find(row => row.runId === runId)!;
    }
    /** REAL: the stored file-line state as served to the thread: { commentId, state, deadlineAt? } or null. */
    const fileLine = async () => (await servedRun()).resultJson?.replyFileLine ?? null;
    /** The ONE renderer (replyFileLineText, the function the ui thread calls) on the served state. */
    const line = async (options: { nowMs?: number; recoverSavedFilesShown?: boolean } = {}) =>
      replyFileLineText(readReplyFileLine(await fileLine()),
        { nowMs: options.nowMs ?? Date.now(), recoverSavedFilesShown: options.recoverSavedFilesShown ?? false });
    /** When the result was accepted (the saved row's own time). */
    const acceptedAt = async () => (await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)))[0].createdAt.getTime();
    /** The same function the worker calls, called again: idempotent by (run, resultId, canonicalSha256). */
    const publishAgain = async () => [await publishWithheldAcceptedReply(db, { companyId, issueId, runId }, "acceptance"),
      await publishWithheldAcceptedReply(db, { companyId, issueId, runId }, "terminal")];
    /** REAL: everything the rendered rows need, from the real GETs, with the random ids and times removed. */
    async function renderSource() {
      const comments = (await thread()).map(comment => ({ authorType: comment.authorType, body: comment.body,
        byRun: comment.createdByRunId === runId, isMessage: comment.id === messageId }));
      const detail = await request(app).get(`/api/issues/${issueId}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      const action = detail.body.recoveryAction ?? detail.body.activeRecoveryAction ?? null;
      const served = await servedRun(), state = served.resultJson?.replyFileLine ?? null;
      const [reply] = await replies();
      const recovery = action?.evidence?.workspaceRecovery ?? null, system = action?.evidence?.systemRecovery ?? null;
      // REAL: the saved-files source the top panel inspects before it offers "Recover saved files".
      const inspected = action ? await request(app).get(`/api/issues/${issueId}/recovery-actions`)
        .query({ inspectSourceRunId: runId, inspectSourceActionId: action.id }) : null;
      return { comments, issueStatus: detail.body.status as string,
        run: { status: served.status, replyFileLine: state && { onTheReply: state.commentId === reply?.id, state: state.state,
          deadlineAfterAcceptanceMs: state.deadlineAt ? Date.parse(state.deadlineAt) - await acceptedAt() : null } },
        recoveryAction: action && { kind: action.kind, status: action.status, ownerType: action.ownerType, cause: action.cause,
          nextAction: action.nextAction, evidenceRunIsThisRun: action.evidence?.runId === runId,
          workspaceRecovery: recovery && { status: recovery.status ?? null, retryable: recovery.retryable ?? null },
          systemRecovery: system && { state: system.state ?? null },
          sourceInspection: (inspected?.body.sourceInspection?.status as string | undefined) ?? null } };
    }
    /** The fixture file the ui rows render IS this real source (UPDATE_WITHHELD_REPLY_FIXTURE=1 rewrites it). */
    async function expectRenderFixture(name: string) {
      const file = path.join(RENDER_FIXTURES, name), fixture = await renderSource();
      if (process.env.UPDATE_WITHHELD_REPLY_FIXTURE === "1") {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
      }
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(fixture);
      return fixture;
    }
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
    /** REAL: the saved-files source that the board's "Recover saved files" control reads
     * (GET /api/issues/:id/recovery-actions?inspectSourceRunId=..., ui WorkspaceExportRecovery.tsx). */
    async function savedFilesSource(cause: string) {
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, cause)));
      const got = await request(app).get(`/api/issues/${issueId}/recovery-actions`)
        .query({ inspectSourceRunId: runId, inspectSourceActionId: action.id });
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return { active: got.body.active?.cause as string | undefined, inspection: got.body.sourceInspection?.status as string | undefined };
    }
    async function recoverSavedFiles(cause: string) {
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, cause)));
      const got = await request(app).post(`/api/issues/${issueId}/recovery-actions/recover-workspace`)
        .send({ actionId: action.id, runId, idempotencyKey: randomUUID() });
      return { status: got.status, state: got.body.status as string | undefined };
    }
    /** Everything about the task, the run and the agent that publishing must NOT touch (condition (vi)). */
    async function untouchedByPublish() {
      const [{ updatedAt: _i, ...issue }] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [{ updatedAt: _r, resultJson: _j, ...runRow }] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [{ updatedAt: _a, ...agent }] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [{ updatedAt: _c, ...finalization }] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).length;
      const runs = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length;
      return { issue, run: runRow, agent, finalization, wakes, runs };
    }
    /** REAL: a later message from the person (POST /api/issues/:id/comments). */
    async function personSays(body: string) {
      const got = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(got.status, JSON.stringify(got.body)).toBe(201);
      return got.body.id as string;
    }
    /** The wakes and runs that message caused: [wake status, its run's status or null]. */
    async function wakesFor(commentId: string) {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      // A coalesced receipt is delivery history, not a second parked message.
      const mine = rows.filter(wake => wake.status !== "coalesced" && JSON.stringify(wake.payload ?? {}).includes(commentId));
      return Promise.all(mine.map(async wake => ({ status: wake.status, runId: wake.runId,
        run: wake.runId ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId)))[0] ?? null : null })));
    }
    const otherRuns = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).filter(row => row.id !== runId);
    return { streamAndAcceptThroughPort, coordinatorReplay, untouchedByPublish, personSays, wakesFor, otherRuns, task, servedRun, fileLine, line, acceptedAt, publishAgain, expectRenderFixture, savedFilesSource, recoverSavedFiles, app, companyId, agentId, issueId, runId, leaseId, messageId, streamAndAccept, copyBack, coordinator, run, presentationWorker,
      thread, replies, answered, expectAnsweredOnceAndNoNotice, failCopyBackThreeTimes, boardRetrySucceeds };
  }
  // ---------------------------------------------------------------------------------------------
  const CONTENT_OF_R = "the report R wrote in its box\n";
  /** FAKED BOX transport only (commands run in a local directory). REAL prepareNativeWorkspaceSync. */
  async function realBox(s: Awaited<ReturnType<typeof scenario>>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "noflip-host-"));
    const host = path.join(root, "host"), remote = path.join(root, "box");
    await fs.mkdir(host); await fs.writeFile(path.join(host, "base.txt"), "base\n");
    const [planted] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId));
    const [lease] = await db.update(environmentLeases).set({ metadata: { ...planted.metadata, remoteCwd: remote,
      driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true } }).where(eq(environmentLeases.id, s.leaseId)).returning();
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test",
      leaseId: s.leaseId, remoteCwd: remote, timeoutMs: 30_000,
      runner: { execute: input => new Promise(resolve => {
        const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
          timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
            exitCode: error ? 1 : 0, signal: error?.signal ?? null, timedOut: error?.killed ?? false,
            stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() }));
        child.stdin?.on("error", () => undefined); child.stdin?.end(input.stdin ?? "");
      }),
      // The provider's file transport, for the kept-aside snapshot: real files, copied.
      syncIn: async operations => { for (const operation of operations) for (const file of operation.files)
        await fs.cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        return { filesTransferred: 1, bytesTransferred: 0, operations: [] }; },
      syncOut: async operations => { for (const operation of operations) for (const file of operation.files)
        await fs.cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        return { filesTransferred: 1, bytesTransferred: 0, operations: [] }; } } };
    box.targets.set(s.leaseId, target);
    const realSync = await vi.importActual<typeof import("./native-workspace-sync.js")>("./native-workspace-sync.js");
    await realSync.prepareNativeWorkspaceSync({ db, companyId: s.companyId, workspaceId: s.issueId,
      workspaceLocalDir: host, runId: s.runId, lease: lease as EnvironmentLease, target, resourceDisposition: "destroy" });
    await fs.writeFile(path.join(remote, "report.txt"), CONTENT_OF_R);
    const providerLeaseId = lease.providerLeaseId!;
    // The scripted provider: the same box comes back, then stops again.
    const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", acquireRunLease: vi.fn(), releaseRunLease: vi.fn(),
      resumeRunLease: vi.fn(async () => ({ providerLeaseId, metadata: { remoteCwd: remote } })),
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" as const })),
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
    } as never] });
    const hostFile = () => fs.readFile(path.join(host, "report.txt"), "utf8").catch(() => null);
    /** PLANTED: the box's stop receipt, in the provider's own receipt shape (the platform stopped the retained box). */
    async function plantStopReceipt() {
      const [current] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId));
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...current.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(current as never, { providerLeaseId, state: "stopped" }) } })
        .where(eq(environmentLeases.id, s.leaseId));
    }
    /** SERVER RESTART: the save call now passes. REAL: the startup reconciler's own call
     * (heartbeat/recovery.ts:976 reconcileRetainedWorkspaces), then the finalizer's own pass. */
    async function restartWithTheSaveCallPassing() {
      box.resume.mockReset().mockImplementation(input => realSync.resumeNativeWorkspaceSync(input));
      for (let pass = 0; pass < 3; pass++) {
        const work = await reconcileRetainedWorkspaces(db, environmentRuntime, async () => {});
        await Promise.all(work ?? []);
        await s.copyBack(); await s.presentationWorker();
      }
    }
    const action = async () => (await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, s.issueId),
      eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted"))))[0];
    /** The bytes kept aside for R: stored recovery snapshots of R's box, restored to a scratch directory to read them. */
    async function keptAside() {
      const operations = (await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
        eq(workspaceOperations.status, "succeeded")))).filter(operation => operation.phase === "workspace_recovery_snapshot");
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "noflip-aside-"));
      const copies = await attachPreservedWorkspaceSnapshots({ db, companyId: s.companyId, issueId: s.issueId, sourceRunIds: [s.runId], cwd: scratch });
      const files = await Promise.all(copies.map(copy => fs.readFile(path.join(copy.path, "files", "report.txt"), "utf8").catch(() => null)));
      return { operations: operations.length, files };
    }
    return { host, remote, hostFile, plantStopReceipt, restartWithTheSaveCallPassing, action, keptAside, environmentRuntime };
  }
  /** R as it ended: what no later write may change (K12). Read from the real GET and the run row. */
  async function ended(s: Awaited<ReturnType<typeof scenario>>) {
    const served = await s.servedRun(), row = await s.run();
    return { status: served.status, error: row.error, errorCode: row.errorCode, finishedAt: row.finishedAt?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null, failureCode: (row.resultJson as Record<string, unknown> | null)?.failureCode ?? null };
  }

  it("NOFLIP K12 + K15a, SERVER RESTART: save times out -> retry exhausted (FAILED, KEPT) -> restart with the call passing -> the files are saved, the line moves once to saved, R stays FAILED", async () => {
    const s = await scenario({ realSync: true }), b = await realBox(s);
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();               // NAMED INJECTION SAVE-TIMES-OUT; REAL finalizer exhausted branch
    await s.presentationWorker();                   // REAL: the reply-presentation worker
    const [reply] = await s.replies();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    const before = await ended(s);
    expect(before).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_retry_exhausted", finishedAt: expect.any(String) });
    expect(await b.hostFile()).toBeNull();
    await b.plantStopReceipt();
    await b.restartWithTheSaveCallPassing();
    // K15a: the files are saved into the task's workspace and the line moved to saved.
    expect(readSystemRecovery((await b.action()).evidence)?.state).toBe("complete");
    expect(await b.hostFile()).toBe(CONTENT_OF_R);
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "saved" });
    // K12: R is exactly as it ended.
    expect(await ended(s)).toEqual(before);
    expect(await s.replies()).toHaveLength(1);
    expect(await s.otherRuns()).toEqual([]);
    // ONCE: a second restart changes nothing.
    const line = (await s.run()).resultJson?.presentationDecision;
    await b.restartWithTheSaveCallPassing();
    expect(await ended(s)).toEqual(before);
    expect((await s.run()).resultJson?.presentationDecision).toEqual(line);
    expect(await s.replies()).toHaveLength(1);
  }, 240_000);

  it("NOFLIP K15b, SERVER RESTART: the line already reads LOST -> the late save writes nothing into the task's workspace, R stays FAILED, the line stays LOST, the bytes are kept aside", async () => {
    vi.stubEnv("DATABASE_URL", database.connectionString); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
    const s = await scenario({ realSync: true }), b = await realBox(s);
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    // PLANTED (as row R2 of the withheld file): the platform reports the box's lease expired before the reply is published.
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "lost" });
    expect(await s.line()).toBe(FILE_LINE_LOST);
    const before = await ended(s);
    expect(before.status).toBe("failed");
    // PLANTED: the box was only stopped after all; its stop receipt arrives.
    await b.plantStopReceipt();
    await b.restartWithTheSaveCallPassing();
    expect(readSystemRecovery((await b.action()).evidence)?.state).toBe("complete");
    // K15b: nothing landed in the task's workspace, nothing is published as R's.
    expect(await b.hostFile()).toBeNull();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "lost" });
    expect(await ended(s)).toEqual(before);
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_retry_exhausted" });
    expect(await s.replies()).toHaveLength(1);
    // NEVER-OK: the late bytes are kept aside, not discarded.
    expect(await b.keptAside()).toEqual({ operations: 1, files: [CONTENT_OF_R] });
    expect(await fs.readFile(path.join(b.remote, "report.txt"), "utf8")).toBe(CONTENT_OF_R);
    vi.unstubAllEnvs();
  }, 240_000);

  it("NOFLIP K15c: a newer run exists on the task (PLANTED) -> the late save writes nothing into the workspace; R and its KEPT line are unchanged; the bytes are kept aside", async () => {
    vi.stubEnv("DATABASE_URL", database.connectionString); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
    const s = await scenario({ realSync: true }), b = await realBox(s);
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    const before = await ended(s);
    // PLANTED newer run: at this base no real route starts a run behind a retry-exhausted R
    // (ADMIT-CAUSE F1; the admit lane makes that route). The same shape a real later run has.
    const r = await s.run();
    await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.agentId, nativeIssueId: s.issueId, runtimeMode: "native",
      status: "succeeded", startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(r.createdAt.getTime() + 1000),
      contextSnapshot: { issueId: s.issueId } });
    await b.plantStopReceipt();
    await b.restartWithTheSaveCallPassing();
    expect(readSystemRecovery((await b.action()).evidence)?.state).toBe("complete");
    expect(await b.hostFile()).toBeNull();
    expect(await ended(s)).toEqual(before);
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    expect(await s.replies()).toHaveLength(1);
    expect(await b.keptAside()).toEqual({ operations: 1, files: [CONTENT_OF_R] });
    vi.unstubAllEnvs();
  }, 240_000);

  it("NOFLIP K12 + K15a, Retry export (a person's action): R is never `running` again; the save commits, the line moves once to saved, R stays FAILED", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    const before = await ended(s);
    expect(before.status).toBe("failed");
    const statuses: string[] = [];
    // REAL: Retry export, then the finalizer's copy-back; R's served status is read at each step.
    box.resume.mockReset().mockImplementation(async () => { statuses.push((await s.servedRun()).status); return true; });
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, s.issueId),
      eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted")));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId));
    // PLANTED: the box's stop receipt (as boardRetrySucceeds of the withheld file).
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } })
      .where(eq(environmentLeases.id, s.leaseId));
    await expect(retryNativeWorkspaceExport({ db, companyId: s.companyId, issueId: s.issueId, actionId: action.id, runId: s.runId, actorId: PERSON,
      repairNote: "The sandbox provider is reachable again; the saved work is preserved.",
      environmentRuntime: { resumeRunLease: vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/work" } })),
        retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" })) } as never }))
      .resolves.toMatchObject({ status: "queued" });
    statuses.push((await s.servedRun()).status);
    expect(await ended(s)).toEqual(before);
    await s.copyBack(); await s.presentationWorker();
    statuses.push((await s.servedRun()).status);
    expect(box.resume).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["failed", "failed", "failed"]);
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "saved" });
    expect(await ended(s)).toEqual(before);
    expect(await s.replies()).toHaveLength(1);
    await s.copyBack(); await s.presentationWorker();
    expect(await ended(s)).toEqual(before);
    expect(await s.replies()).toHaveLength(1);
  }, 240_000);

  it("NOFLIP K15b, Retry export: the line already reads LOST -> Retry export is refused, no save is tried, R and the line are unchanged, the box keeps the bytes", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    // PLANTED (as row R2 of the withheld file): the lease reads expired before the reply is published.
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "lost" });
    const before = await ended(s);
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, s.issueId),
      eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted")));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId));
    // PLANTED: the box was only stopped; its stop receipt.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...lease.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } })
      .where(eq(environmentLeases.id, s.leaseId));
    box.resume.mockReset().mockResolvedValue(true);
    const resumeRunLease = vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/work" } }));
    await expect(retryNativeWorkspaceExport({ db, companyId: s.companyId, issueId: s.issueId, actionId: action.id, runId: s.runId, actorId: PERSON,
      repairNote: "The sandbox provider is reachable again; the saved work is preserved.",
      environmentRuntime: { resumeRunLease, retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" })) } as never }))
      .rejects.toMatchObject({ status: 409, details: { code: "workspace_export_retry_line_lost" } });
    await s.copyBack(); await s.presentationWorker();
    expect(box.resume).not.toHaveBeenCalled();
    expect(resumeRunLease).not.toHaveBeenCalled();
    expect(await ended(s)).toEqual(before);
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "lost" });
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure" });
    // The retained box is untouched: still the stopped lease of R.
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId)))[0])
      .toMatchObject({ status: "released", heartbeatRunId: s.runId });
    expect(await s.replies()).toHaveLength(1);
  }, 240_000);

});
