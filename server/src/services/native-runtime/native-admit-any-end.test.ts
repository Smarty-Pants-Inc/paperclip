import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// The stuck-save bound on a CLASSIC nativeWorkspaceSync run (the minimum cut, CHALLENGE-r1 sections 2 and 7).
// Rows K1, K2r, K4-K9 (RF5-ROWS.md) and RFL's list, with the majors C5-C12, C16.
//
// REAL in every row (the route or producer is named at its call):
//   the person's messages ....... POST /api/issues/:id/comments (routes/issues.ts)
//   the task's saved directory .. materializeIsolatedTaskDirectory (the repository-free task directory)
//   R's classic sync ............ prepareNativeWorkspaceSync: the startup seed S0, the descriptor and the
//                                 prepared reference; the "sandbox" is a local directory and every sandbox
//                                 command really runs
//   acceptance .................. NativeRunCoordinatorStore.completeRun
//   every copy-back attempt ..... nativeWorkspaceFinalizationWork(...).load + .check (the worker's own functions)
//                                 -> attemptNativeWorkspaceFinalization -> resumeNativeWorkspaceSync (the
//                                 finalizer entry), under withNativeWorkspaceFinalizationOwnership
//   the bound ................... the same .check -> recordNativeWorkspaceFinalizationFailure
//                                 -> recordNativeFinalizationFailure (the finalizer's one terminal write)
//   R's reply and its line ...... the reply-presentation worker; GET /api/issues/:id/comments and
//                                 GET /api/issues/:id/runs; the ONE renderer replyFileLineText
//   the parked message's start .. heartbeat.registerDeferredReceiptWork + resumeQueuedRuns: real release,
//                                 claimQueuedRun, fenceUnverifiedPredecessorsAtAdmission, workspace
//                                 preparation, environment acquisition and P's own prepareNativeWorkspaceSync
// NAMED INJECTIONS:
//   CLASSIC-STALL-1 ............. the box's sandbox commands block for R's box until the test releases them
//                                 (no apply started: the copy-back hangs in its first command)
//   CLASSIC-STALL-AFTER-APPLY ... the same seam, armed on the stamp command only: the host apply has FINISHED
//                                 and its success is not recorded (RFL "applied but uncommitted", K8)
// PLANTED (named), rows K1, K4, K8, C5, C6 and the Git row: the native run row R, its lease, its workspace row and
//   its claim of M's wake. Beside them, the SAME shape by the real route: the live row (last in this file) has no
//   planted row at all. There turn 0, R and P are real runs of the real executor, R's lease and workspace row are
//   the ones real preparation wrote, and R hangs in its own teardown copy-back. Only the provider turn is scripted.
// C11, the Stop base: these rows ride cut 2a (62fcab5b) as it is. No row presses Stop; nothing here changes Stop.
const box = vi.hoisted(() => ({ targets: new Map<string, unknown>(), inputs: [] as unknown[],
  nextBox: null as null | ((leaseId: string, real: () => Promise<any>, lease: any) => Promise<unknown>),
  /** The scripted provider turn of one run (the live-executor rows): returns after it accepted its own result. */
  session: null as null | ((input: { execution: any; runnerInstanceId: string; db: unknown }) => Promise<unknown>) }));
vi.mock("../environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async (input: { leaseId?: string | null }) =>
    box.targets.get(String(input.leaseId)) ?? await box.nextBox?.(String(input.leaseId),
      () => actual.resolveEnvironmentExecutionTarget(input as never), (input as { lease?: unknown }).lease)
      ?? actual.resolveEnvironmentExecutionTarget(input as never)) as unknown as typeof actual.resolveEnvironmentExecutionTarget };
});
vi.mock("../heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../heartbeat/runtime-selection.js")>();
  return { ...actual, prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db,
    { ...input, onProviderResourceDisposition: () => input.onProviderResourceDisposition("keep_running") }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime };
});
// The provider turn of the NEXT run is scripted; what it is given is the product's own input.
vi.mock("./native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    box.inputs.push(input.execution);
    const scripted = await box.session?.(input as never);
    if (scripted) return scripted as never;
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "next turn answered" };
  }) as typeof actual.executePaperclipNativeSession };
});
import { FILE_LINE_LOST, readReplyFileLine, replyFileLineText } from "@paperclipai/shared";
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { activityRoutes } from "../../routes/activity.js";
import { issueTreeControlRoutes } from "../../routes/issue-tree-control.js";
import { settleUnansweredPersonMessagesForTask } from "../recovery/unanswered-person-message.js";
import { errorHandler } from "../../middleware/index.js";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";
import { cleanupNativeWorkspaceSync, prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";

const STALLED = "native_workspace_sync_out_stalled";
const PERSON = "admit-any-person";
const THE_LINE = "The file changes from this reply couldn't be saved.";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const record = (value: unknown) => (value && typeof value === "object" ? value : {}) as Record<string, any>;
const evidence: Record<string, unknown> = {};

/** sha256 over every file's path, mode-independent content and symlink target under a directory. */
async function treeSha256(root: string) {
  const hash = createHash("sha256");
  const walk = async (dir: string) => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (relative === ".paperclip-runtime" || relative.startsWith(`.paperclip-runtime${path.sep}`)) continue;
      if (entry.isDirectory()) { hash.update(`d:${relative}\0`); await walk(full); }
      else if (entry.isSymbolicLink()) hash.update(`l:${relative}\0${await fs.readlink(full)}\0`);
      else hash.update(`f:${relative}\0`).update(await fs.readFile(full)).update("\0");
    }
  };
  await walk(root);
  return hash.digest("hex");
}
async function listing(root: string) {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (relative.startsWith(".paperclip-runtime") || relative === ".git" || relative.startsWith(`.git${path.sep}`)) continue;
      if (entry.isDirectory()) await walk(full); else out[relative] = await fs.readFile(full, "utf8");
    }
  };
  await walk(root);
  return out;
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("a parked person's message after R ends by any path (retry exhausted, Stop, cap); a terminal run never flips; a Pause-cancelled wake is never silent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-admit-any-end-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "admit-any-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "classic@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.useRealTimers(); box.inputs.length = 0; box.session = null; box.nextBox = null; });
  afterAll(async () => {
    if (process.env.ADMIT_ANY_EVIDENCE) await fs.writeFile(process.env.ADMIT_ANY_EVIDENCE, JSON.stringify(evidence, null, 2));
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const ANSWER = "Done. I rewrote the report and added the notes file.";
  const SAVED = { "report.md": "report, saved v1\n", "data/keep.txt": "kept since the first turn\n" };
  async function liveScenario() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Classic bound live", issuePrefix: `L${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the report", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `L${companyId.slice(0, 6)}-1` });
    const [environment] = await db.insert(environments).values({ name: `Box ${issueId}`, driver: "sandbox", status: "active",
      config: { provider: "fake", image: "fixture:test", reuseLease: true } }).returning();
    await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, agentId));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {}));
    app.use("/api", activityRoutes(db)); app.use("/api", issueTreeControlRoutes(db)); app.use(errorHandler);
    // Every box is a local directory. Only R's box carries the fault, armed after R accepted.
    const fault = { stall: null as null | { entered: () => void; release: Promise<void> }, fail: false, calls: 0 };
    const boxes: Array<{ providerLeaseId: string; cwd: string; leaseIds: string[] }> = [];
    type Execute = NonNullable<AdapterSandboxExecutionTarget["runner"]>["execute"];
    box.nextBox = async (leaseId, real, lease) => {
      // The REAL target (its acquisition outcome and provider box id), with only the directory and the command
      // execution replaced. One directory per PROVIDER box, so a warm box that is resumed is the same directory.
      const actualTarget = await real();
      const providerLeaseId: string = actualTarget?.sandboxLeaseAcquisition?.providerLeaseId ?? lease?.providerLeaseId ?? leaseId;
      let index = boxes.findIndex(entry => entry.providerLeaseId === providerLeaseId);
      if (index < 0) {
        index = boxes.length;
        const cwd = path.join(root, issueId, `box-${index}`);
        await fs.mkdir(cwd, { recursive: true });
        boxes.push({ providerLeaseId, cwd, leaseIds: [] });
      }
      boxes[index].leaseIds.push(leaseId);
      const cwd = boxes[index].cwd;
      const target: AdapterSandboxExecutionTarget = { ...actualTarget, kind: "remote", transport: "sandbox", leaseId, remoteCwd: cwd, timeoutMs: 30_000,
        runner: { execute: (async input => {
          if (index === faultedBox.index) fault.calls += 1;
          if (index === faultedBox.index && fault.stall) { fault.stall.entered(); await fault.stall.release; }
          // SAVE-FAILS: the held call comes back as a failure (the provider gave up on it), until the test lets calls through.
          if (index === faultedBox.index && fault.fail) return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "save call failed (stand-in)", pid: null, startedAt: new Date().toISOString() };
          return new Promise(resolve => {
            const child = execFile(input.command, input.args ?? [], { cwd: input.cwd ?? cwd, env: { ...process.env, ...input.env },
              timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
                exitCode: error ? 1 : 0, signal: error?.signal ?? null, timedOut: error?.killed ?? false,
                stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() }));
            child.stdin?.on("error", () => undefined); child.stdin?.end(input.stdin ?? "");
          });
        }) as Execute } };
      box.targets.set(leaseId, target);
      return target;
    };
    let reached!: () => void, release!: () => void;
    const stallReached = new Promise<void>(resolve => { reached = resolve; });
    const stallRelease = new Promise<void>(resolve => { release = resolve; });
    let turns = 0;
    const faultedBox = { index: -1 };
    box.session = async input => {
      const turn = ++turns;
      if (turn > 2) return null; // P's turn: the default scripted answer.
      const execution = input.execution, runId: string = execution.binding.runId;
      const sessionId: string = execution.session.normalizedSessionId ?? `session-${runId}`;
      const runnerId = input.runnerInstanceId, controlPlaneId = `${runnerId}:control`;
      const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId,
        completionContractId: execution.completionContract.id, completionContractSha256: execution.completionContract.sha256,
        sourceInstanceId: runnerId, controlPlaneSourceInstanceId: controlPlaneId });
      const contract = execution.completionContract.contract;
      const RESULT = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "done" as const, summary: "Rewrote the report.",
        completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
          criteria: (contract.criteria ?? []).map((criterion: { id: string }) => ({ criterionId: criterion.id, status: "satisfied",
            evidenceRefs: ["session-goal:complete"], explanation: "The report was rewritten." })), remainingWork: [] },
        evidence: [{ kind: "session_goal_status", ref: "session-goal:complete" }], verification: [], attentionRequests: [], artifacts: [] };
      const TERMINAL = { schema: "paperclip.prp.terminal.v1" as const, runTerminalState: "succeeded" as const,
        turnTerminalState: "completed" as const, reportedWorkDisposition: "done" as const };
      let seq = 0;
      const event = (eventType: string, payload: Record<string, unknown>): PrpEvent => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, runId,
        normalizedSessionId: sessionId, turnId: "answer-turn", itemId: "answer-item", sourceInstanceId: runnerId, sourceEventId: `answer-${++seq}`,
        sourceSeq: seq, sourceKind: "runner", eventType, priority: 0, emittedAt: new Date().toISOString(), payload } as PrpEvent);
      const control = (sourceSeq: number, eventType: string, payload: Record<string, unknown>): PrpEvent => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1,
        runId, normalizedSessionId: sessionId, turnId: "answer-turn", sourceInstanceId: controlPlaneId, sourceEventId: `${controlPlaneId}:${runId}:${sourceSeq}`,
        sourceSeq, sourceKind: "control_plane", eventType, priority: 0, emittedAt: new Date().toISOString(), payload } as PrpEvent);
      await port.openRun({ identity: { companyId, issueId, runId, agentId, sessionId }, backendKind: "runner", sourceInstanceId: runnerId });
      const answer = turn === 1 ? "Done. I wrote the report." : ANSWER;
      await port.appendEvent(event("item.delta", { kind: "agentMessage", channel: "final", text: answer }));
      await port.appendEvent(event("item.completed", { kind: "agentMessage", channel: "final", providerPhase: "final", text: answer }));
      await port.appendEvent(control(1, "run.result.accepted", { result: RESULT }));
      await port.appendEvent(control(2, "run.terminal", TERMINAL));
      await port.completeRun({ result: RESULT, terminal: TERMINAL, turnId: "answer-turn",
        callerResultId: `${runnerId}:${runId}:result`, callerDedupeKey: `${runId}:${execution.completionContract.sha256}` });
      // This run's own box: the directory behind the lease the real acquisition gave it.
      const runLeases = (await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId))).map(lease => lease.id);
      const boxIndex = boxes.findIndex(entry => entry.leaseIds.some(leaseId => runLeases.includes(leaseId)));
      const boxCwd = boxes[boxIndex].cwd;
      if (turn === 1) {
        // Turn 0 writes the files the task then has SAVED: its own real copy-back brings them to the host.
        for (const [name, body] of Object.entries(SAVED)) {
          await fs.mkdir(path.dirname(path.join(boxCwd, name)), { recursive: true });
          await fs.writeFile(path.join(boxCwd, name), body);
        }
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Wrote the report." };
      }
      // R's edits, in its box only; then CLASSIC-STALL-1 for everything R's box is asked from here on.
      await fs.writeFile(path.join(boxCwd, "report.md"), "report, REWRITTEN BY R (unsaved)\n");
      await fs.writeFile(path.join(boxCwd, "notes.md"), "R's new notes (unsaved)\n");
      faultedBox.index = boxIndex;
      fault.stall = { entered: reached, release: stallRelease };
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Rewrote the report." };
    };
    const runs = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const say = async (body: string) => {
      const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      return sent.body.id as string;
    };
    const agentComments = async () => {
      const got = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return (got.body as Array<{ id: string; body: string; authorType: string; createdByRunId: string | null }>).filter(comment => comment.authorType === "agent");
    };
    const servedLine = async (runId: string) => {
      const got = await request(app).get(`/api/issues/${issueId}/runs`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      const served = (got.body as Array<{ runId: string; status: string; resultJson: Record<string, any> | null }>).find(row => row.runId === runId);
      const state = readReplyFileLine(served?.resultJson?.replyFileLine);
      return { status: served?.status ?? null, state: state?.state ?? null, shown: replyFileLineText(state, { nowMs: Date.now(), recoverSavedFilesShown: false }) };
    };
    return { companyId, agentId, issueId, app, boxes, runs, issue, say, agentComments, servedLine, faultedBox, fault,
      stallReached, releaseStall: () => { release(); fault.stall = null; } };
  }

  /** REAL up to here: turn 0 saved; M woke R through the queue; R (a real run of the real executor) accepted its result
   * and hangs in its own teardown copy-back (CLASSIC-STALL-1); the person's next message is parked behind it. */
  async function hungRWithParkedMessage(capMs: number) {
    const s = await liveScenario();
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const settled: unknown[] = [];
    const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: capMs },
      onWorkspaceSettled: async input => { settled.push(input); } });
    const sweep = async (runId: string) => { for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry); };
    await receipts.ready;
    await s.say("Please write the report.");
    for (let waited = 0; waited < 60_000; waited += 250) {
      await heartbeat.resumeQueuedRuns();
      await reconcileNativeFinalizations(db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never }).catch(() => undefined);
      const [first] = await s.runs();
      if (first && first.status !== "running" && first.status !== "queued") break;
      await sleep(250);
    }
    await heartbeat.drainActiveRunExecutions();
    const [r0] = await s.runs();
    expect(r0).toMatchObject({ status: "succeeded" });
    const hostDir = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!)))[0].cwd!;
    const m = await s.say("Please rewrite the report.");
    const hung = Promise.race([s.stallReached.then(() => "hung" as const), sleep(60_000).then(() => "R never reached its copy-back" as const)]);
    for (let waited = 0; waited < 60_000 && !(await Promise.race([hung, sleep(250).then(() => null)])); waited += 250) await heartbeat.resumeQueuedRuns();
    expect(await hung).toBe("hung");
    const [, r] = await s.runs();
    expect(r).toMatchObject({ status: "running", runtimeMode: "native" });
    expect(JSON.stringify(r.contextSnapshot)).toContain(m);
    const next = await s.say("Also add a summary section to the report.");
    const wakesOf = async (commentId: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => JSON.stringify(wake.payload).includes(commentId)).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
    await vi.waitFor(async () => expect((await wakesOf(next)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]), { timeout: 10_000, interval: 50 });
    const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
    const coordinator = async (id: string) => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, id)))[0];
    /** REAL GET: how the agent reads to a person. */
    const agentRead = async () => {
      const got = await request(s.app).get(`/api/agents/${s.agentId}`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return { status: got.body.status as string, lifecycleState: got.body.lifecycleState ?? null, pauseReason: got.body.pauseReason ?? null,
        lifecycleError: got.body.lifecycleError ?? null };
    };
    /** REAL: the queue's own release and admission, until the parked message's run reached its provider turn. */
    const admitParked = async (withinMs: number) => {
      const startAt = Date.now();
      const successors = async () => (await s.runs()).filter(candidate => candidate.id !== r.id && JSON.stringify(candidate.contextSnapshot).includes(next));
      const turnsBefore = box.inputs.length;
      while (Date.now() - startAt < withinMs) {
        await heartbeat.resumeQueuedRuns();
        const started = await successors();
        if (box.inputs.length > turnsBefore && started.length) break;
        if (started.some(candidate => ["failed", "cancelled", "timed_out"].includes(candidate.status))) break;
        await sleep(250);
      }
      await sleep(500);
      const started = await successors();
      return { afterMs: Date.now() - startAt, runs: started, turns: box.inputs.length - turnsBefore };
    };
    /** REAL: the unanswered-message sweep for this task (recovery/unanswered-person-message.ts), then the thread GET. */
    const sweepUnanswered = async (now?: Date) => settleUnansweredPersonMessagesForTask(db, { companyId: s.companyId, issueId: s.issueId, ...(now ? { now } : {}) });
    const thread = async () => {
      const got = await request(s.app).get(`/api/issues/${s.issueId}/comments`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return (got.body as Array<{ id: string; body: string; authorType: string | null; createdByRunId: string | null; createdAt: string }>)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    };
    const present = async () => { const worker = nativeResponsePresentationWork(db);
      for (const entry of await worker.load({ companyId: s.companyId, issueId: s.issueId })) await worker.check(entry); };
    const stop = async () => { s.releaseStall(); receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions(); };
    return { s, heartbeat, errors, settled, sweep, r0, r, m, next, hostDir, wakesOf, run, coordinator, agentRead, admitParked, sweepUnanswered, thread, stop, present };
  }
  type Hung = Awaited<ReturnType<typeof hungRWithParkedMessage>>;
  const NO_CAP = 3_600_000;
  /** REAL: the copy-back fails three times (the executor's own, then the worker's retries) -> retry exhausted.
   * NAMED INJECTIONS: SAVE-FAILS (the box's held call returns a failure); CLOCK-SKIP (the 30 s retry delay is moved to now). */
  async function exhaustRetries(h: Hung) {
    h.s.fault.fail = true;
    h.s.releaseStall();
    const startAt = Date.now();
    while ((await h.run(h.r.id)).status === "running" && Date.now() - startAt < 60_000) {
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date() }).where(and(eq(nativeRunFinalizations.runId, h.r.id),
        eq(nativeRunFinalizations.phase, "retryable_failure")));
      await h.sweep(h.r.id);
      await sleep(250);
    }
    await h.heartbeat.drainActiveRunExecutions();
    return h.run(h.r.id);
  }
  const brief = (run: typeof heartbeatRuns.$inferSelect) => ({ id: run.id, status: run.status, errorCode: run.errorCode, error: run.error,
    finishedAt: run.finishedAt?.toISOString() ?? null });

  it("PROBE retry exhausted", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    try {
      const ended = await exhaustRetries(h);
      await h.present();
      const out: Record<string, unknown> = { R: brief(ended), coordinator: await h.coordinator(h.r.id), line: await h.s.servedLine(h.r.id), hostAtEnd: await listing(h.hostDir),
        wakesAtEnd: (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId })),
        agentAtEnd: await h.agentRead(), issueAtEnd: await h.s.issue(),
        recovery: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, h.s.issueId))).map(a => ({ cause: a.cause, status: a.status, ownerType: a.ownerType, kind: a.kind })),
        leases: (await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, h.r.id))).map(l => ({ status: l.status, releasedAt: l.releasedAt, cleanupStatus: l.cleanupStatus, policy: l.leasePolicy })),
        owner: record(record((await h.run(h.r.id)).runnerProfileJson).nativeWorkspaceFinalizationOwner) };
      const admitted = await h.admitParked(20_000);
      out.admitted = { afterMs: admitted.afterMs, turns: admitted.turns, runs: admitted.runs.map(brief) };
      out.wakesAfter = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      out.agentAfter = await h.agentRead();
      out.sweep = await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      out.thread = (await h.thread()).map(c => ({ by: c.authorType, run: c.createdByRunId, body: c.body.slice(0, 200) }));
      // F2: the stand-in lets the call through.
      h.s.fault.fail = false;
      await h.sweep(h.r.id);
      await reconcileNativeFinalizations(db, [h.r.id], { environmentRuntime: {} as never }).catch(error => { out.reconcileError = String(error); });
      await h.heartbeat.drainActiveRunExecutions();
      out.Rlate = brief(await h.run(h.r.id)); out.lineLate = await h.s.servedLine(h.r.id); out.coordinatorLate = (await h.coordinator(h.r.id)).phase;
      // The system's retained-workspace recovery (workspace-recovery.ts reconcileRetainedWorkspaces), with a runtime that records what it is asked.
      const asked: string[] = [];
      const runtime = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { asked.push(String(name)); throw new Error(`runtime.${String(name)} not available in this probe`); } });
      const { reconcileRetainedWorkspaces } = await import("../workspace-recovery.js");
      for (let pass = 0; pass < 3; pass += 1) {
        const work = await reconcileRetainedWorkspaces(db, runtime as never, async () => { asked.push("onRecovered"); }).catch(error => { asked.push(`error:${String(error)}`); return []; });
        await Promise.all(work ?? []);
      }
      out.retained = { asked, actions: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, h.s.issueId))).map(a => ({ cause: a.cause, status: a.status, ownerType: a.ownerType,
        systemRecovery: record(a.evidence).systemRecovery, workspaceRecovery: record(a.evidence).workspaceRecovery })) };
      out.Rretained = brief(await h.run(h.r.id)); out.hostLate = await listing(h.hostDir);
      out.errors = h.errors.map(String);
      evidence.probeRetryExhausted = out;
    } finally { await h.stop(); }
  }, 300_000);

  it("PROBE stop", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    try {
      const stopped = await request(h.s.app).post(`/api/heartbeat-runs/${h.r.id}/cancel`).send({ cancellationRequestId: randomUUID() });
      const out: Record<string, unknown> = { stopStatus: stopped.status, stopBody: { status: stopped.body?.status, errorCode: stopped.body?.errorCode } };
      await sleep(2_000);
      out.Rhung = brief(await h.run(h.r.id));
      out.wakesHung = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      const admitted = await h.admitParked(20_000);
      out.admittedWhileHung = { afterMs: admitted.afterMs, turns: admitted.turns, runs: admitted.runs.map(brief) };
      await h.present();
      out.R = brief(await h.run(h.r.id)); out.coordinator = (await h.coordinator(h.r.id))?.phase; out.line = await h.s.servedLine(h.r.id);
      out.agent = await h.agentRead(); out.issue = { status: (await h.s.issue()).status, executionRunId: (await h.s.issue()).executionRunId };
      out.wakes = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      out.sweep = await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      out.thread = (await h.thread()).map(c => ({ by: c.authorType, run: c.createdByRunId, body: c.body.slice(0, 200) }));
      h.s.releaseStall();
      await h.heartbeat.drainActiveRunExecutions();
      await h.sweep(h.r.id);
      const late = await h.admitParked(10_000);
      out.admittedAfterRelease = { afterMs: late.afterMs, turns: late.turns, runs: late.runs.map(brief) };
      out.Rlate = brief(await h.run(h.r.id)); out.lineLate = await h.s.servedLine(h.r.id); out.coordinatorLate = (await h.coordinator(h.r.id))?.phase;
      out.wakesLate = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      out.agentLate = await h.agentRead(); out.hostLate = await listing(h.hostDir); await h.present(); out.lineLatePresented = await h.s.servedLine(h.r.id);
      out.ownerLate = record(record((await h.run(h.r.id)).runnerProfileJson).nativeWorkspaceFinalizationOwner);
      out.opsLate = (await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, h.r.id), eq(workspaceOperations.phase, "workspace_finalize")))).map(o => o.status);
      // The person's next explicit message after the Stop.
      const again = await h.s.say("Please continue: add the summary section.");
      const startAt = Date.now(); const before = box.inputs.length;
      while (Date.now() - startAt < 20_000 && box.inputs.length === before) { await h.heartbeat.resumeQueuedRuns(); await sleep(250); }
      await sleep(500);
      out.afterNextMessage = { turns: box.inputs.length - before, runs: (await h.s.runs()).slice(2).map(run => ({ ...brief(run), carries: [h.next, again].filter(id => JSON.stringify(run.contextSnapshot).includes(id)).length })),
        wakes: [...await h.wakesOf(h.next), ...await h.wakesOf(again)].map(w => ({ status: w.status, error: w.error, runId: w.runId })), agent: await h.agentRead() };
      out.errors = h.errors.map(String);
      evidence.probeStop = out;
    } finally { await h.stop(); }
  }, 300_000);

  it("PROBE pause", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    try {
      const ended = await exhaustRetries(h);
      const out: Record<string, unknown> = { R: brief(ended) };
      out.wakesBefore = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      const paused = await request(h.s.app).post(`/api/issues/${h.s.issueId}/tree-holds`).send({ mode: "pause", reason: "cleanup" });
      out.pause = { status: paused.status, holdId: paused.body?.hold?.id, body: paused.status === 201 ? undefined : paused.body };
      out.wakesPaused = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      out.sweepPaused = await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      out.threadPaused = (await h.thread()).map(c => ({ by: c.authorType, run: c.createdByRunId, body: c.body.slice(0, 200) }));
      const released = await request(h.s.app).post(`/api/issues/${h.s.issueId}/tree-holds/${paused.body?.hold?.id}/release`).send({});
      out.release = { status: released.status, body: released.status < 300 ? undefined : released.body };
      const admitted = await h.admitParked(15_000);
      out.admittedAfterResume = { afterMs: admitted.afterMs, turns: admitted.turns, runs: admitted.runs.map(brief) };
      out.wakesResumed = (await h.wakesOf(h.next)).map(w => ({ id: w.id, status: w.status, error: w.error, runId: w.runId }));
      out.sweepResumed = await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      out.threadResumed = (await h.thread()).map(c => ({ by: c.authorType, run: c.createdByRunId, body: c.body.slice(0, 200) }));
      out.agent = await h.agentRead();
      evidence.probePause = out;
    } finally { await h.stop(); }
  }, 300_000);
});
