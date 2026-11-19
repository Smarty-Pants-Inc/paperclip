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
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
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
    // The body is the answer alone; the file line is the stored state, written directly as kept (never saving).
    expect(reply).toMatchObject({ body: ANSWER, authorAgentId: s.agentId, createdByRunId: s.runId });
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    expect(await s.line({ recoverSavedFilesShown: true })).toBe(FILE_LINE_KEPT);
    expect(await s.line({ recoverSavedFilesShown: false })).toBe(FILE_LINE_KEPT_NO_BUTTON);
    // The box is retained for the board's "Recover saved files": the terminal write tagged its lease.
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId)))[0])
      .toMatchObject({ status: "pending_cleanup", metadata: { nativeWorkspaceExportResume: { runId: s.runId } } });
    expect((await s.run()).resultJson).toMatchObject({
      presentationDecision: { commentAction: "create", commentId: reply.id, fileLine: { state: "kept", deadlineAt: null } },
      nativeWithheldReply: { state: "published", trigger: "terminal", fileLine: "kept", commentId: reply.id,
        resultId: (await s.coordinator()).resultId, canonicalSha256: expect.any(String),
        failureCode: "native_workspace_sync_out_retry_exhausted" } });
    // The board's open recovery for this run names the retained files, and their recorded source verifies.
    expect(await s.savedFilesSource("native_workspace_sync_out_retry_exhausted"))
      .toEqual({ active: "native_workspace_sync_out_retry_exhausted", inspection: "verified" });
    await s.expectAnsweredOnceAndNoNotice();
    // A restarted worker finds nothing left to publish.
    await s.presentationWorker(); await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await s.replies()).toHaveLength(1);
    // REAL: the request behind the board's "Recover saved files" button is accepted for this state
    // (POST /api/issues/:id/recovery-actions/recover-workspace, routes/issues.ts).
    expect(await s.recoverSavedFiles("native_workspace_sync_out_retry_exhausted")).toEqual({ status: 202, state: "queued" });
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
    // Which check ended it: the lease-state check of the copy-back itself
    // (native-workspace-finalizer.ts, `lease.status === "expired"`), before any export was tried.
    expect(box.resume).not.toHaveBeenCalled();
    expect((await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
      eq(workspaceOperations.phase, "workspace_finalize")))).map(operation => [operation.status, operation.stderrExcerpt]))
      .toEqual([["failed", "workspace_sync_out_unrecoverable\n"]]);
    // Until the worker publishes, the one answered rule says M is unanswered.
    expect(await s.answered()).toEqual([false]);
    expect(await s.fileLine()).toBeNull();
    await s.presentationWorker();
    timing("R2 start of the first copy-back -> published reply (one worker pass)", startedAt);
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    // R2s: byte for byte the streamed text, then the one file line.
    expect(Buffer.from(replies[0].body).equals(Buffer.from(STREAM.join("")))).toBe(true);
    expect(await s.fileLine()).toEqual({ commentId: replies[0].id, state: "lost" });
    expect(await s.line()).toBe(FILE_LINE_LOST);
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", fileLine: "lost",
      failureCode: "native_workspace_sync_out_unrecoverable" } });
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("R2c: the same pause cancel in an Agent Chat conversation: the person's chat gets exactly 1 reply + the LOST line", async () => {
    const s = await scenario({ chat: true });
    await s.streamAndAccept();
    const paused = await request(s.app).post(`/api/agents/${s.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(await s.run()).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_unrecoverable" });
    // Four workers discover the same pending reply at once: the row lock lets one publish.
    await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(ANSWER);
    expect(await s.line()).toBe(FILE_LINE_LOST);
    expect((await db.select().from(agents).where(eq(agents.id, s.agentId)))[0].status).toBe("paused");
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("R3: the healthy committed control is unchanged: nothing before the commit, then exactly 1 reply with no file line", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    expect(await s.replies()).toEqual([]);
    expect((await s.run()).resultJson ?? {}).not.toHaveProperty("nativeWithheldReply");
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
    expect(await s.fileLine()).toBeNull();
    expect(await s.line()).toBeNull();
    expect(await s.task()).toEqual(HEALTHY_TASK_AFTER_COMMIT(s.runId));
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("L4: an acceptance entry also discovered by the ordinary producer is listed once, then publishes 1 reply", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    // REAL runner acceptance and finalization producers; no planted marker/commit.
    await s.streamAndAcceptThroughPort();
    box.resume.mockResolvedValue(true);
    // Use the reconciler's real split-worker option: commit now, present in the worker below.
    await s.copyBack({ skipNativeResponsePresentation: true });
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect(await s.replies()).toEqual([]);
    const scope = { companyId: s.companyId, issueId: s.issueId };
    const ordinary = await db.select().from(nativeResponsePresentationCandidates(scope).as("ordinary"));
    const withheld = await db.select().from(nativeWithheldReplyCandidates(scope).as("withheld"));
    expect(ordinary.map(row => row.id)).toEqual([s.runId]);
    expect(withheld.map(row => row.id)).toEqual([s.runId]);
    const work = nativeResponsePresentationWork(db);
    const entries = await work.load(scope);
    expect(entries.map(entry => entry.id)).toEqual([s.runId]);
    const due = (row: typeof ordinary[number]) => Math.max(row.nextAttemptAt?.getTime() ?? 0,
      row.publicationNextAttemptAt ? Date.parse(row.publicationNextAttemptAt) : 0);
    expect(entries[0].dueAt).toBe(Math.min(due(ordinary[0]), due(withheld[0])));
    // PLANTED scheduling-only twin, beside the real-producer overlap above:
    // ordinary discovery is later, but the acceptance entry is already due.
    const savedNextAttemptAt = (await s.coordinator()).nextAttemptAt;
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(nativeRunFinalizations.runId, s.runId));
    const planted = await work.load(scope);
    expect(planted.map(entry => entry.id)).toEqual([s.runId]);
    expect(planted[0].dueAt).toBe(due(withheld[0]));
    await db.update(nativeRunFinalizations).set({ nextAttemptAt: savedNextAttemptAt })
      .where(eq(nativeRunFinalizations.runId, s.runId));
    for (const entry of entries) await work.check(entry);
    await s.presentationWorker();
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
    await s.expectAnsweredOnceAndNoNotice();
    await l3Evidence("L4 overlap real producers", { ordinary: ordinary.map(row => row.id), withheld: withheld.map(row => row.id),
      discovered: entries, plantedLaterOrdinary: planted, replies: replies.map(row => ({ id: row.id, body: row.body })) });
  }, 120_000);

  it("R4: after the withheld reply is published, a board Retry that succeeds commits the run and posts nothing more", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    await s.presentationWorker();
    const before = await s.replies();
    expect(before).toHaveLength(1);
    expect(await s.line({ recoverSavedFilesShown: true })).toBe(FILE_LINE_KEPT);
    await s.boardRetrySucceeds();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    const after = await s.replies();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, body: ANSWER });
    // The copy-back succeeded: the files are saved now, so the kept line clears.
    expect(await s.fileLine()).toEqual({ commentId: before[0].id, state: "saved" });
    expect(await s.line()).toBeNull();
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
    expect(await s.fileLine()).toEqual({ commentId: replies[0].id, state: "saved" });
    expect(await s.line()).toBeNull();
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", fileLine: "saved", failureCode: null } });
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("RENDERED source, LOST (terminal): the real GETs after a LOST publish are the fixture the ui rows render", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.copyBack();
    await s.presentationWorker();
    const fixture = await s.expectRenderFixture("withheld-reply-thread.json");
    expect(fixture.recoveryAction).toMatchObject({ cause: "native_workspace_sync_out_unrecoverable", ownerType: "board" });
    expect(fixture.comments.filter(comment => comment.authorType === "agent")).toEqual([
      { authorType: "agent", body: ANSWER, byRun: true, isMessage: false }]);
    expect(fixture.run.replyFileLine).toEqual({ onTheReply: true, state: "lost", deadlineAfterAcceptanceMs: null });
  }, 120_000);

  it("RENDERED source, KEPT (terminal): the real GETs after a KEPT publish are the fixture the ui rows render", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    await s.failCopyBackThreeTimes();
    await s.presentationWorker();
    const fixture = await s.expectRenderFixture("withheld-reply-kept-thread.json");
    expect(fixture.recoveryAction).toMatchObject({ cause: "native_workspace_sync_out_retry_exhausted" });
    expect(fixture.run.replyFileLine).toEqual({ onTheReply: true, state: "kept", deadlineAfterAcceptanceMs: null });
  }, 120_000);

  it("RENDERED source, SAVING (acceptance): the real GETs after publishing at acceptance are the fixture the ui rows render", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    const fixture = await s.expectRenderFixture("withheld-reply-saving-thread.json");
    expect(fixture.run).toEqual({ status: "running", replyFileLine: { onTheReply: true, state: "saving", deadlineAfterAcceptanceMs: SAVING_DEADLINE_MS } });
    expect(fixture.recoveryAction).toBeNull();
  }, 120_000);

  it("T0: the switch ships as 'acceptance' (Ruling P); with 'terminal' passed instead, nothing is published or marked at acceptance", async () => {
    const shipped = await vi.importActual<typeof import("./native-withheld-reply-trigger.js")>("./native-withheld-reply-trigger.js");
    expect(shipped.WITHHELD_REPLY_TRIGGER).toBe("acceptance");
    expect(shipped.WITHHELD_REPLY_SAVING_DEADLINE_MS).toBe(SAVING_DEADLINE_MS);
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await s.replies()).toEqual([]);
    expect(await s.fileLine()).toBeNull();
    expect((await s.run()).resultJson ?? {}).not.toHaveProperty("nativeWithheldReply");
  }, 120_000);

  it("A1 (acceptance, healthy): the registered worker posts the reply at acceptance with 'Saving…'; the commit clears the line and posts nothing more", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    const errors: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(delivery, () => true);
    let replyId = "";
    try {
      await worker.ready;
      await s.streamAndAccept();
      const acceptedAt = performance.now();
      // No copy-back has run and no test-side call into the worker: the acceptance write alone makes it publish.
      await vi.waitFor(async () => expect(await s.replies()).toHaveLength(1), { timeout: 15_000, interval: 25 });
      timing("A1 acceptance -> published reply (registered worker)", acceptedAt);
      const [reply] = await s.replies();
      replyId = reply.id;
      expect(reply).toMatchObject({ body: ANSWER, authorAgentId: s.agentId, createdByRunId: s.runId });
      // Earlier than today: the copy-back has not ended, and the run is still running.
      expect(await s.coordinator()).toMatchObject({ phase: "workspace_finalizing" });
      expect((await s.run()).status).toBe("running");
      expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "saving",
        deadlineAt: new Date(await s.acceptedAt() + SAVING_DEADLINE_MS).toISOString() });
      expect(await s.line()).toBe(FILE_LINE_SAVING);
      expect(await s.answered()).toEqual([true]);
      expect(await s.publishAgain()).toEqual([false, false]);
      // The healthy copy-back, then the committed path with the worker still registered.
      box.resume.mockResolvedValue(true);
      await s.copyBack();
      expect(await s.coordinator()).toMatchObject({ phase: "committed" });
      await vi.waitFor(async () => expect((await s.run()).status).toBe("succeeded"), { timeout: 15_000, interval: 25 });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await delivery.stop(); }
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: replyId, body: ANSWER });
    // The commit's other effects on the task are the healthy control's (R3), unchanged by the earlier reply.
    expect(await s.task()).toEqual(HEALTHY_TASK_AFTER_COMMIT(s.runId));
    // The line showed, then cleared.
    expect(await s.fileLine()).toEqual({ commentId: replyId, state: "saved" });
    expect(await s.line()).toBeNull();
    expect((await s.run()).resultJson).toMatchObject({ presentationDecision: { commentId: replyId, fileLine: { state: "saved", deadlineAt: null } },
      nativeWithheldReply: { state: "published", trigger: "acceptance", commentId: replyId } });
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("A2 (acceptance -> terminal failure, box retained): still exactly 1 reply; 'Saving…' settles to the KEPT line", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(reply.body).toBe(ANSWER);
    expect(await s.line()).toBe(FILE_LINE_SAVING);
    await s.failCopyBackThreeTimes();
    // The terminal write queued the same outbox entry again; until the worker serves it the line is still bounded.
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "pending", trigger: "terminal" } });
    await s.presentationWorker();
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: reply.id, body: ANSWER });
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "kept" });
    expect(await s.line({ recoverSavedFilesShown: true })).toBe(FILE_LINE_KEPT);
    expect(await s.line({ recoverSavedFilesShown: false })).toBe(FILE_LINE_KEPT_NO_BUTTON);
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", trigger: "terminal", fileLine: "kept",
      commentId: reply.id, failureCode: "native_workspace_sync_out_retry_exhausted" } });
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await s.replies()).toHaveLength(1);
    // A board Retry that then succeeds clears the line; still 1 reply.
    await s.boardRetrySucceeds();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
    expect(await s.line()).toBeNull();
  }, 120_000);

  it("A3 (acceptance -> pause -> the box is gone): still exactly 1 reply; 'Saving…' settles to the LOST line", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    const [reply] = await s.replies();
    expect(await s.replies()).toHaveLength(1);
    expect(await s.line()).toBe(FILE_LINE_SAVING);
    const paused = await request(s.app).post(`/api/agents/${s.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    await db.update(environmentLeases).set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, s.leaseId));
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: "native_workspace_sync_out_unrecoverable" });
    await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: reply.id, body: ANSWER });
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "lost" });
    expect(await s.line()).toBe(FILE_LINE_LOST);
    await s.expectAnsweredOnceAndNoNotice();
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
  }, 120_000);

  it("A4 (acceptance -> pause before the worker -> the retried copy-back succeeds): exactly 1 reply, no line", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    const paused = await request(s.app).post(`/api/agents/${s.agentId}/pause`).send({});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(await s.run()).toMatchObject({ status: "cancelled" });
    box.resume.mockResolvedValue(true);
    // The commit and four workers at once: whichever publisher takes the row lock first posts, the others post nothing.
    await Promise.all([s.copyBack(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(ANSWER);
    expect(await s.line()).toBeNull();
    expect((await s.fileLine())?.state ?? "saved").toBe("saved");
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("A5 (acceptance, healthy, the commit races the workers): exactly 1 reply and no line left", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    box.resume.mockResolvedValue(true);
    await Promise.all([s.copyBack(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect((await s.run()).status).toBe("succeeded");
    const replies = await s.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe(ANSWER);
    expect(await s.line()).toBeNull();
    expect(["published", "skipped"]).toContain(((await s.run()).resultJson as any).nativeWithheldReply.state);
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("A6 (acceptance, the deadline; FAKE CLOCK, for the deadline only): past acceptance + 10 min the line is never 'Saving…'", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    const [reply] = await s.replies();
    const deadline = await s.acceptedAt() + SAVING_DEADLINE_MS;
    expect(await s.fileLine()).toEqual({ commentId: reply.id, state: "saving", deadlineAt: new Date(deadline).toISOString() });
    expect(await s.line()).toBe(FILE_LINE_SAVING);
    // FAKE CLOCK (named): only Date moves, to the deadline. No copy-back ran and no saved state was edited.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(deadline - 1_000);
    expect(await s.line()).toBe(FILE_LINE_SAVING);
    vi.setSystemTime(deadline);
    expect(await s.line()).toBe(FILE_LINE_NOT_SAVED_YET);
    vi.setSystemTime(deadline + 24 * 3_600_000);
    await s.presentationWorker();
    expect(await s.line()).toBe(FILE_LINE_NOT_SAVED_YET);
    expect(await s.replies()).toHaveLength(1);
    // A copy-back that succeeds after the deadline still clears the line; still 1 reply.
    box.resume.mockResolvedValue(true);
    await s.copyBack();
    await s.presentationWorker();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect(await s.line()).toBeNull();
    expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
  }, 120_000);

  // ---- Ruling P: the accepted answer is published at acceptance, by default (the SHIPPED switch). ----
  // Never twice (d), on the shipped switch: acceptance + commit = A1, A5, A6; acceptance + terminal
  // failure = A2, A3; four workers racing = A3, A4, A5 and P-b below.

  it("L3 never-twice: two real publishers, replay, then real commit retain one canonical reply", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    await s.streamAndAccept();
    const published = await Promise.all([
      publishWithheldAcceptedReply(db, s, "acceptance"),
      publishWithheldAcceptedReply(db, s, "acceptance"),
    ]);
    const first = await s.replies();
    await l3Evidence("L3 never-twice two real publishers", { mutation: process.env.L3_MUTATION ?? "none",
      runId: s.runId, published, replyCount: first.length, replies: first.map(({ id, body }) => ({ id, body })) });
    expect(first).toHaveLength(1);
    await s.presentationWorker();
    await s.publishAgain();
    box.resume.mockResolvedValue(true);
    await s.copyBack();
    await s.presentationWorker();
    await s.copyBack();
    expect((await s.coordinator()).phase).toBe("committed");
    expect((await s.replies()).map(comment => comment.id)).toEqual([first[0].id]);
    await l3Evidence("L3 never-twice after replay and real commit", { mutation: process.env.L3_MUTATION ?? "none",
      replyCount: (await s.replies()).length, canonicalCommentId: first[0].id });
  }, 120_000);

  it("P-a (shipped default): acceptance -> exactly 1 reply within seconds, the turn is no longer 'Working', 'Saving…' then cleared by the commit; publishing touches nothing else", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    const errors: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(delivery, () => true);
    try {
      await worker.ready;
      // Condition (vi): everything but the comment and the run's resultJson, read just before acceptance completes...
      await s.streamAndAccept();
      const before = await s.untouchedByPublish();
      const acceptedAt = performance.now();
      await vi.waitFor(async () => expect(await s.replies()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      const tookMs = performance.now() - acceptedAt;
      timing("P-a acceptance -> published reply (registered worker)", acceptedAt);
      expect(tookMs).toBeLessThan(5_000);
      const [reply] = await s.replies();
      expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
      // ...and just after the publish: the same. No run status, no task status, no executionRunId,
      // no execution lock, no finalizer phase or lease, no agent status, no wake, no new run.
      expect(await s.untouchedByPublish()).toEqual(before);
      expect(before).toMatchObject({ issue: { status: "in_progress", executionRunId: s.runId }, run: { status: "running", nativePhase: "workspace_finalizing" },
        finalization: { phase: "workspace_finalizing" }, runs: 1 });
      // 'Working' gone: the thread's live-turn reader skips a run whose presented reply is in the thread
      // (TaskChatThread presentedReplyRunIds reads this served state). The real GETs here ARE the fixture
      // whose rendered row asserts no 'Working' (TaskChatThread.withheld-reply.test.tsx, SAVING).
      expect(await s.fileLine()).toMatchObject({ commentId: reply.id, state: "saving" });
      expect(await s.line()).toBe(FILE_LINE_SAVING);
      const fixture = await s.expectRenderFixture("withheld-reply-saving-thread.json");
      expect(fixture.run).toMatchObject({ status: "running", replyFileLine: { onTheReply: true, state: "saving" } });
      box.resume.mockResolvedValue(true);
      await s.copyBack();
      await vi.waitFor(async () => expect((await s.run()).status).toBe("succeeded"), { timeout: 15_000, interval: 25 });
      expect(errors).toEqual([]);
    } finally { worker.stop(); await delivery.stop(); }
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await s.replies()).toHaveLength(1);
    expect(await s.line()).toBeNull();
    expect((await s.fileLine())?.state).toBe("saved");
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("P-b (shipped default; NAMED INJECTION 'hanging copy-out'): while the copy-out hangs, the answer still shows within seconds and the turn is no longer 'Working', exactly once", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    // NAMED INJECTION 'hanging copy-out': the box's export (resumeNativeWorkspaceSync, the faked box) is
    // entered and never returns until `release` is called. Everything around it is the real finalizer.
    let release!: (ok: boolean) => void;
    const hung = new Promise<boolean>(resolve => { release = resolve; });
    box.resume.mockImplementation(() => hung);
    await s.streamAndAccept();
    let copyBackEnded = false;
    const copying = s.copyBack().finally(() => { copyBackEnded = true; });
    await vi.waitFor(() => expect(box.resume).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 20 });
    // The finalizer is inside the copy-out now.
    expect(await s.coordinator()).toMatchObject({ phase: "workspace_finalizing" });
    const hangingSince = performance.now();
    // Four workers at once, while it hangs.
    await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    const tookMs = performance.now() - hangingSince;
    timing("P-b copy-out hanging -> published reply (four worker passes)", hangingSince);
    expect(tookMs).toBeLessThan(5_000);
    const [reply] = await s.replies();
    expect(await s.replies()).toHaveLength(1);
    expect(reply.body).toBe(ANSWER);
    expect(copyBackEnded).toBe(false);
    expect(await s.coordinator()).toMatchObject({ phase: "workspace_finalizing" });
    expect(await s.task()).toEqual({ status: "in_progress", executionRunId: s.runId });
    expect((await s.run()).status).toBe("running");
    // 'Working' ended: the served state the thread's live-turn reader skips on.
    expect(await s.fileLine()).toMatchObject({ commentId: reply.id, state: "saving" });
    expect(await s.answered()).toEqual([true]);
    // A copy-out that stays hung past the deadline never says 'Saving…' for ever (bounded state).
    expect(await s.line({ nowMs: await s.acceptedAt() + SAVING_DEADLINE_MS })).toBe(FILE_LINE_NOT_SAVED_YET);
    await s.presentationWorker();
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await s.replies()).toHaveLength(1);
    // The hang ends; the copy-out succeeds; the commit posts nothing more.
    release(true);
    await copying;
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
    expect(await s.line()).toBeNull();
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  // ---- RFL F1: the runner's own acceptance (PaperclipControlPlanePort.completeRun) writes the publish entry too. ----

  it("L1 (shipped default; the PORT's real openRun/appendEvent/completeRun; NAMED INJECTION 'hanging copy-out'): the reply is published within 5 s, exactly once, by the registered worker", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    // NAMED INJECTION 'hanging copy-out': the box's export (resumeNativeWorkspaceSync, the faked box) is
    // entered and never returns until `release` is called. Everything around it is the real finalizer.
    let release!: (ok: boolean) => void;
    const hung = new Promise<boolean>(resolve => { release = resolve; });
    box.resume.mockImplementation(() => hung);
    const errors: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    // REAL: the registered reply-presentation worker; nothing in this row calls the publisher by hand before the reply shows.
    const worker = nativeResponsePresentationWork(db).register(delivery, () => true);
    let copying: Promise<unknown> = Promise.resolve();
    try {
      await worker.ready;
      await s.streamAndAcceptThroughPort();
      const acceptedAt = performance.now();
      // The port's own accepting transaction left the entry: pending, trigger 'acceptance', naming the accepted result.
      const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId));
      expect(accepted).toMatchObject({ schemaStatus: "accepted" });
      expect((await s.coordinator())).toMatchObject({ phase: "workspace_finalizing", resultId: accepted.id });
      let copyBackEnded = false;
      copying = s.copyBack().finally(() => { copyBackEnded = true; });
      await vi.waitFor(async () => expect(await s.replies()).toHaveLength(1), { timeout: 5_000, interval: 20 });
      const tookMs = performance.now() - acceptedAt;
      timing("L1 port acceptance, copy-out hanging -> published reply (registered worker)", acceptedAt);
      expect(tookMs).toBeLessThan(5_000);
      await vi.waitFor(() => expect(box.resume).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 20 });
      const [reply] = await s.replies();
      expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
      // The copy-out is still hanging: nothing but the reply moved.
      expect(copyBackEnded).toBe(false);
      expect(await s.coordinator()).toMatchObject({ phase: "workspace_finalizing" });
      expect(await s.task()).toEqual({ status: "in_progress", executionRunId: s.runId });
      expect(await s.run()).toMatchObject({ status: "running", nativePhase: "workspace_finalizing" });
      // The port's own run fields are kept beside the entry (one row, both writes).
      expect((await s.run()).resultJson).toMatchObject({ nativeTerminal: { runTerminalState: "succeeded" }, prpRunTerminalState: "succeeded",
        nativeWithheldReply: { state: "published", trigger: "acceptance", resultId: accepted.id, commentId: reply.id } });
      expect(await s.fileLine()).toMatchObject({ commentId: reply.id, state: "saving" });
      expect(await s.answered()).toEqual([true]);
      // Exactly once: four more worker passes and the publisher called again post nothing.
      await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
      expect(await s.publishAgain()).toEqual([false, false]);
      expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
      expect(errors).toEqual([]);
      // The hang ends; the copy-out succeeds; the commit posts nothing more.
      release(true);
      await copying;
      expect(await s.coordinator()).toMatchObject({ phase: "committed" });
      await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
      expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
      expect(await s.line()).toBeNull();
    } finally { release(true); await copying.catch(() => {}); worker.stop(); await delivery.stop(); }
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it("L2 (shipped default): a coordinator replay after the PORT accepted is refused without changing accepted state or posting again", async () => {
    setting.trigger = "shipped";
    const s = await scenario();
    let release!: (ok: boolean) => void;
    const hung = new Promise<boolean>(resolve => { release = resolve; });
    box.resume.mockImplementation(() => hung);
    await s.streamAndAcceptThroughPort();
    const entry = async () => ((await s.run()).resultJson as Record<string, any>).nativeWithheldReply;
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId));
    const pending = { state: "pending", trigger: "acceptance", resultId: accepted.id };
    expect(await entry()).toMatchObject(pending);
    async function expectReplayRefusedAndUnchanged(answered: boolean) {
      const run = await s.run();
      const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId));
      const finalizations = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, s.runId));
      const comments = await s.thread();
      const answeredBefore = await s.answered();
      expect(answeredBefore).toEqual([answered]);
      // REAL: NativeRunCoordinatorStore.completeRun replays PaperclipControlPlanePort.completeRun's
      // accepted result. The port hashes its binding too (paperclip-control-plane-port.ts:591);
      // the store does not, so its digest check refuses this replay (native-run-coordinator-store.ts:392).
      expect(await s.coordinatorReplay()).toBe("refused:native_result_replay_conflict");
      // Full rows include status, resultJson (entry + presentationDecision), and all finalization fields.
      expect(await s.run()).toEqual(run);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId))).toEqual(results);
      expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, s.runId))).toEqual(finalizations);
      // Nothing new is posted, and any published reply (body, metadata and identity) stays untouched.
      const afterComments = await s.thread();
      expect(afterComments).toHaveLength(comments.length);
      expect(afterComments).toEqual(comments);
      expect((await s.run()).resultJson?.presentationDecision).toEqual(run.resultJson?.presentationDecision);
      expect(await s.answered()).toEqual(answeredBefore);
    }
    // Before any worker ran, M remains unanswered and the port's pending entry stays intact.
    expect(await s.replies()).toEqual([]);
    await expectReplayRefusedAndUnchanged(false);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId))).toHaveLength(1);
    // The entry still publishes: the worker's own discovery and check, as after a restart.
    await s.presentationWorker();
    const [reply] = await s.replies();
    expect(await s.replies()).toHaveLength(1);
    expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
    const published = await entry();
    expect(published).toMatchObject({ state: "published", trigger: "acceptance", resultId: accepted.id, commentId: reply.id });
    // After publication, the same refusal leaves M answered (true), the reply and its decision intact.
    expect((await s.run()).resultJson).toMatchObject({ presentationDecision: { commentId: reply.id } });
    await expectReplayRefusedAndUnchanged(true);
    // Four more workers still leave exactly 1 reply, without resetting the entry to pending.
    await Promise.all([s.presentationWorker(), s.presentationWorker(), s.presentationWorker(), s.presentationWorker()]);
    expect(await s.publishAgain()).toEqual([false, false]);
    expect(await entry()).toEqual(published);
    expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
    // The copy-out succeeds; the commit posts nothing more.
    box.resume.mockReset().mockResolvedValue(true);
    release(true);
    await s.copyBack();
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    await s.presentationWorker(); await s.copyBack(); await s.presentationWorker();
    expect((await s.replies()).map(comment => comment.id)).toEqual([reply.id]);
    expect(await s.line()).toBeNull();
    await s.expectAnsweredOnceAndNoNotice();
  }, 120_000);

  it.each(["store", "port"] as const)("F3 P-c (%s acceptance, shipped default): a person's message during workspace_finalizing is PARKED behind R; the task is freed only after R committed, with the file R wrote on disk", async acceptance => {
    setting.trigger = "shipped";
    const s = await scenario({ wakeOnDemand: true, realSync: true });
    // FAKED BOX transport only: commands run in a separate local directory.
    // REAL prepareNativeWorkspaceSync + resumeNativeWorkspaceSync copy R's file,
    // persist the finalized reference, and unblock the real lease cleanup owner.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "withheld-reply-host-"));
    const hostWorkspace = path.join(root, "host"), remoteWorkspace = path.join(root, "box");
    await fs.mkdir(hostWorkspace);
    const fileOfR = path.join(hostWorkspace, "src-util.ts"), contentOfR = `// renamed by run ${s.runId}\nexport const helper2 = 1;\n`;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, s.leaseId));
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test",
      leaseId: s.leaseId, remoteCwd: remoteWorkspace, timeoutMs: 30_000,
      runner: { execute: input => new Promise(resolve => {
        const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
          timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
            exitCode: error ? 1 : 0, signal: error?.signal ?? null, timedOut: error?.killed ?? false,
            stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString(),
          }));
        child.stdin?.on("error", () => undefined); child.stdin?.end(input.stdin ?? "");
      }) },
    };
    box.targets.set(s.leaseId, target);
    const realSync = await vi.importActual<typeof import("./native-workspace-sync.js")>("./native-workspace-sync.js");
    await realSync.prepareNativeWorkspaceSync({ db, companyId: s.companyId, workspaceId: s.issueId,
      workspaceLocalDir: hostWorkspace, runId: s.runId, lease: lease as EnvironmentLease, target, resourceDisposition: "destroy" });
    await fs.writeFile(path.join(remoteWorkspace, "src-util.ts"), contentOfR);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    box.resume.mockImplementation(async input => { await gate; return realSync.resumeNativeWorkspaceSync(input); });
    // Both real acceptance producers share this publication/dispatch barrier row.
    if (acceptance === "port") await s.streamAndAcceptThroughPort();
    else await s.streamAndAccept();
    const copying = s.copyBack();
    let heartbeatForCleanup: ReturnType<typeof heartbeatService> | null = null;
    try {
    await vi.waitFor(() => expect(box.resume).toHaveBeenCalledTimes(1), { timeout: 15_000, interval: 20 });
    expect(await s.replies()).toHaveLength(0);
    expect(await s.coordinator()).toMatchObject({ phase: "workspace_finalizing" });
    // F3: the REAL person's POST arrives BEFORE early publication, while R copies.
    const followUp = await s.personSays("Thanks. Now also update the README.");
    // The route queues the message's wake after it answers the request.
    await vi.waitFor(async () => expect(await s.wakesFor(followUp)).toHaveLength(1), { timeout: 15_000, interval: 25 });
    // REAL: the stale-lock sweep that frees a task whose run has ended. R has not ended: nothing is freed.
    // FAKED BOX ONLY: the driver reports its sandbox stopped. The real runtime
    // releaseRunLeases + environmentService.releaseLease persist cleanup and receipt.
    const teardown = environmentRuntimeService(db, { drivers: [{
      driver: "sandbox",
      releaseRunLease: async ({ lease, status }) => environmentService(db).releaseLease(lease.id, status, {
        cleanupStatus: "success",
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
      }),
    } as EnvironmentRuntimeDriver] });
    const heartbeat = heartbeatForCleanup = heartbeatService(db, { environmentRuntime: teardown });
    await heartbeat.sweepStaleIssueLocks({ companyId: s.companyId, issueId: s.issueId });
    // PARKED: the message's wake is deferred behind R; no second run exists; R still owns the task.
    expect((await s.wakesFor(followUp)).map(wake => [wake.status, wake.runId])).toEqual([["deferred_issue_execution", null]]);
    expect(await s.otherRuns()).toEqual([]);
    expect(await s.task()).toEqual({ status: "in_progress", executionRunId: s.runId });
    await expect(fs.readFile(fileOfR, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // REAL F3 fanout consumer: dispatch-work.ts's queuedRunDispatch handler calls
    // the real heartbeat.resumeQueuedRunsAfterDrain, not a mock dispatch counter.
    const errors: unknown[] = [], dispatches: unknown[] = [];
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const dispatch = registerRunDispatchWork(delivery, {
      promoteDueScheduledRetries: async () => undefined,
      nextScheduledRetryAt: async () => null,
      schedulingSuppressed: async () => false,
      resumeQueuedRunsAfterDrain: async scope => {
        await heartbeat.resumeQueuedRunsAfterDrain(scope);
        dispatches.push({ scope, task: await s.task(), wakes: await s.wakesFor(followUp), runs: await s.otherRuns() });
      },
    }, () => true);
    try {
      await dispatch.ready;
      const before = dispatches.length;
      await l3Evidence("L3 F3 before publish", { acceptance, messageId: followUp, task: await s.task(), wakes: await s.wakesFor(followUp), runs: await s.otherRuns() });
      await s.presentationWorker();
      await vi.waitFor(() => expect(dispatches.length).toBeGreaterThan(before), { timeout: 10_000 });
      await l3Evidence("L3 F3 after publish real queuedRunDispatch", { acceptance, dispatches: dispatches.slice(before),
        task: await s.task(), wakes: await s.wakesFor(followUp), runs: await s.otherRuns(),
        finalizationPhase: (await s.coordinator()).phase,
        filePresent: await fs.stat(fileOfR).then(() => true, () => false) });
      expect(await s.replies()).toHaveLength(1);
      expect((await s.wakesFor(followUp)).map(wake => [wake.status, wake.runId])).toEqual([["deferred_issue_execution", null]]);
      expect(await s.otherRuns()).toEqual([]);
      expect(await s.task()).toEqual({ status: "in_progress", executionRunId: s.runId });
      expect(errors).toEqual([]);
    } finally { await dispatch.stop(); await delivery.stop(); }
    // R's copy-out ends and R commits.
    release();
    await copying;
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect((await s.run()).status).toBe("succeeded");
    const committedAt = (await s.coordinator()).updatedAt.getTime();
    // REAL: the same sweep now finds R ended, releases the task and promotes the parked message.
    // PARKED until the commit, never earlier: the file R wrote is on disk before anything frees the task.
    expect(await fs.readFile(fileOfR, "utf8")).toBe(contentOfR);
    expect(await s.task()).toEqual({ status: "in_progress", executionRunId: s.runId });
    expect((await s.wakesFor(followUp)).map(wake => [wake.status, wake.runId])).toEqual([["deferred_issue_execution", null]]);
    // REAL terminal-lock + stranded-queue recovery substitutes for the PLANTED
    // executor's missing finally; no hand edit to the task or parked wake.
    // REAL lease cleanup producer, after copy-out committed. Provider is the
    // faked box above; there is no hand edit to the lease/execution/message state.
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: s.runId, companyId: s.companyId, agentId: s.agentId, status: "succeeded" });
    // REAL terminal-lock service used by issue admission/recovery, followed by
    // the REAL stranded-queue recovery. The reaper's unrelated status-intent
    // dispatcher is not a stand-in for the missing planted executor's finally.
    await issueService(db).clearExecutionRunIfTerminal(s.issueId);
    expect((await s.task()).executionRunId).toBeNull();
    // REAL restart/stranded-queue recovery: queue.ts resumeDeferredExecutionReceipts
    // (called by resumeQueuedRuns) releases/promotes through the production wake queue.
    await heartbeat.resumeQueuedRuns();
    const promoted = await s.otherRuns();
    await l3Evidence("L3 F3 after commit promotion", { acceptance, messageId: followUp, committedAt, task: await s.task(), wakes: await s.wakesFor(followUp), promoted,
      fileReadByHarness: { path: fileOfR, body: await fs.readFile(fileOfR, "utf8") },
      limitation: "promoted run row + dispatch input contextSnapshot; no live provider/model file read" });
    expect(promoted).toHaveLength(1);
    // LIMIT NAMED: no live provider/Runner is attached. This is the promoted RUN ROW
    // plus its durable dispatch INPUT (contextSnapshot), not a claimed model/file read.
    expect(JSON.stringify(promoted[0].contextSnapshot)).toContain(followUp);
    expect(promoted[0].createdAt.getTime()).toBeGreaterThanOrEqual(committedAt);
    expect(await fs.readFile(fileOfR, "utf8")).toBe(contentOfR);
    if (process.env.L3_EVIDENCE) await fs.copyFile(fileOfR, path.join(path.dirname(process.env.L3_EVIDENCE), `f3-${acceptance}-exported-file.txt`));
    expect(committedAt).toBeGreaterThan(0);
    expect(await s.replies()).toHaveLength(1);
    } finally {
      release();
      await copying;
      await heartbeatForCleanup?.drainActiveRunExecutions();
      await realSync.cleanupNativeWorkspaceSync(s.runId);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
