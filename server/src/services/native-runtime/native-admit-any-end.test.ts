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

// A person's message parked behind a run R whose answer is already shown, when R ends by ANY path; a terminal run
// that never flips; a wake a Pause cancelled that is never silent. (RFL 04:56Z + 05:00Z, gate 5; cause.md.)
//
// REAL in every row (the route or producer is named at its call):
//   the person's messages ....... POST /api/issues/:id/comments (routes/issues.ts)
//   turn 0, R and the next run .. real runs of the real executor: the queue's claim, workspace preparation,
//                                 environment acquisition, prepareNativeWorkspaceSync, R's own teardown copy-back
//   every later copy-back ....... nativeWorkspaceFinalizationWork(...).load + .check (the worker's own functions)
//   R's end ..................... the finalizer's one terminal write (recordNativeFinalizationFailure), reached by
//                                 the worker's third failed attempt, or by its person-wait cap; Stop is
//                                 POST /api/heartbeat-runs/:id/cancel; Pause and Resume are
//                                 POST /api/issues/:id/tree-holds and .../tree-holds/:holdId/release
//   the parked message's start .. heartbeat.registerDeferredReceiptWork + resumeQueuedRuns
//   what the person reads ....... GET /api/agents/:id, GET /api/issues/:id/comments, GET /api/issues/:id/runs
//   the one line ................ settleUnansweredPersonMessagesForTask (recovery/unanswered-person-message.ts)
// SCRIPTED (named): the provider turn (it accepts its own result through PaperclipControlPlanePort).
// NAMED INJECTIONS:
//   CLASSIC-STALL-1 ... R's box calls hang until the test releases them
//   SAVE-FAILS ........ the held call comes back as a failure (the provider gave up on it)
//   CLOCK-SKIP ........ the 30 s retry delay is moved to now; where said, the sweep's clock is 10 minutes on
//   TURN-GATE ......... the next run's provider turn is held open (the control row)
// PLANTED: nothing.
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
import { attemptNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";
import { cleanupNativeWorkspaceSync, prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { retryNativeWorkspaceExport } from "./native-workspace-export-retry.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

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
describe.skipIf(!support.supported)("a parked person's message after R ends by any path (retry exhausted, Stop, cap); a terminal run never flips", () => {
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
    const fault = { stall: null as null | { entered: () => void; release: Promise<void> }, fail: false, calls: 0,
      /** EXECUTOR-FAILS (named injection): R's provider turn reports a failure AFTER it accepted its own result. */
      executorFails: null as null | { errorCode: string; errorMessage: string } };
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
    const turnGate = { hold: null as null | Promise<void>, entered: null as null | (() => void) };
    const faultedBox = { index: -1 };
    box.session = async input => {
      const turn = ++turns;
      // P's turn: the default scripted answer. TURN-GATE (named): the control row holds P's provider turn open.
      if (turn > 2) { if (turn === 3 && turnGate.hold) { turnGate.entered?.(); await turnGate.hold; } return null; }
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
      if (fault.executorFails) return { exitCode: 1, signal: null, timedOut: false, ...fault.executorFails };
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
    return { companyId, agentId, issueId, app, boxes, runs, issue, say, agentComments, servedLine, faultedBox, fault, turnGate,
      stallReached, releaseStall: () => { release(); fault.stall = null; } };
  }

  /** REAL up to here: turn 0 saved; M woke R through the queue; R (a real run of the real executor) accepted its result
   * and hangs in its own teardown copy-back (CLASSIC-STALL-1); the person's next message is parked behind it. */
  async function hungRWithParkedMessage(capMs: number, park = true, executorFails: null | { errorCode: string; errorMessage: string } = null) {
    const s = await liveScenario();
    s.fault.executorFails = executorFails;
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
    // `park: false` (the Retry-export row): nobody is parked behind R when its save fails for the last time.
    let next = park ? await s.say("Also add a summary section to the report.") : "";
    const wakesOf = async (commentId: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => JSON.stringify(wake.payload).includes(commentId)).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
    if (park) await vi.waitFor(async () => expect((await wakesOf(next)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]), { timeout: 10_000, interval: 50 });
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
    return { s, heartbeat, errors, settled, sweep, r0, r, m, get next() { return next; }, sayNext: async (body: string) => (next = await s.say(body)),
      agentComments: s.agentComments,
      hostDir, wakesOf, run, coordinator, agentRead, admitParked, sweepUnanswered, thread, stop, present };
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

  it("RE (retry exhausted) + F2: the save fails for the last time with a message parked -> R ends FAILED once, the parked message runs once within a minute in its own root on the saved files, the agent does not read error, 0 'no run started'; then the save call is let through -> R stays FAILED, its line stays as shown, its late bytes are published nowhere", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    try {
      const ended = await exhaustRetries(h);
      const endedAt = Date.now();
      expect(ended).toMatchObject({ status: "failed", errorCode: STALLED, finishedAt: expect.any(Date) });
      expect(ended.error).toMatch(/^Saving the workspace failed, so this run was ended\./);
      expect(await h.coordinator(h.r.id)).toMatchObject({ phase: "terminal_failure", failureCode: STALLED,
        failureDetail: { originalFailureCode: "native_workspace_sync_out_failed", workspaceFinalizeAttempt: 3 } });
      // R's own holds only: its owner is a tombstone and the marker names R.
      expect(record(record(ended.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      expect(record(record(ended.resultJson).workspaceSyncOutStall).workspace).toMatchObject({ kind: "classic_isolated", sourceRunId: h.r.id });
      expect(ended.error).not.toMatch(/kept for recovery|set aside|recover|repair/i);
      await h.present();
      const shown = await h.s.servedLine(h.r.id);
      expect(shown).toMatchObject({ status: "failed", state: "lost", shown: THE_LINE });
      // The agent is not left in error by the save failure of a run whose answer the person already has (real GET).
      const agentAtEnd = await h.agentRead();
      expect(agentAtEnd).toMatchObject({ lifecycleState: "ready" });
      expect(agentAtEnd.status).not.toBe("error");
      // The parked message is admitted at once and runs ONCE.
      const admitted = await h.admitParked(60_000);
      expect(admitted.runs.map(run => run.status), "the parked message never started").toHaveLength(1);
      expect(admitted.turns).toBe(1);
      expect(Date.now() - endedAt).toBeLessThan(60_000);
      await h.heartbeat.drainActiveRunExecutions();
      const [p] = (await h.s.runs()).filter(run => run.id === admitted.runs[0].id);
      expect(p).toMatchObject({ status: "succeeded" });
      expect((await h.wakesOf(h.next)).map(wake => wake.status)).not.toContain("deferred_issue_execution");
      const pRoot = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await h.s.issue()).executionWorkspaceId!)))[0].cwd!;
      expect(pRoot).not.toBe(h.hostDir);
      const pFiles = await listing(pRoot);
      expect(pFiles).toMatchObject(SAVED);
      expect(JSON.stringify(pFiles)).not.toContain("REWRITTEN BY R");
      const agentAfter = await h.agentRead();
      expect(agentAfter).toMatchObject({ status: "idle", lifecycleState: "ready" });
      // 0 'no run started': the sweep, with its clock 10 minutes on, has nothing to say about the message.
      await h.present();
      await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      const thread = await h.thread();
      expect(thread.filter(comment => /no run started|wasn't answered/i.test(comment.body))).toEqual([]);
      expect(thread.filter(comment => comment.createdByRunId === p.id && comment.authorType === "agent")).toHaveLength(1);
      expect(thread.filter(comment => comment.createdByRunId === h.r.id && comment.authorType === "agent").map(comment => comment.body)).toEqual([ANSWER]);

      // F2: the stand-in lets the save call through. Every producer that could still copy R's files back runs.
      const frozen = brief(await h.run(h.r.id));
      const hostBefore = await listing(h.hostDir), pRootBefore = await treeSha256(pRoot);
      h.s.fault.fail = false;
      await h.sweep(h.r.id);
      await reconcileNativeFinalizations(db, [h.r.id], { environmentRuntime: {} as never }).catch(() => undefined);
      const direct = await attemptNativeWorkspaceFinalization({ db, runId: h.r.id, environmentRuntime: {} as never });
      // The claim CAS refuses: R's owner is the tombstone (native-workspace-finalization-ownership.ts).
      expect(direct).toEqual({ kind: "waiting", reason: "binding_changed" });
      await h.heartbeat.drainActiveRunExecutions();
      await h.present();
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      expect(await h.coordinator(h.r.id)).toMatchObject({ phase: "terminal_failure", failureCode: STALLED });
      expect(await h.s.servedLine(h.r.id)).toEqual(shown);
      expect(await listing(h.hostDir)).toEqual(hostBefore);
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      // The late bytes are kept aside: still in R's own box, published nowhere.
      expect(await listing(h.s.boxes[h.s.faultedBox.index].cwd)).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n" });
      expect((await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, h.r.id),
        eq(workspaceOperations.phase, "workspace_finalize")))).map(operation => operation.status)).not.toContain("succeeded");
      expect(h.errors).toEqual([]);
      evidence.RE = { R: frozen, line: shown, agentAtEnd, agentAfter, P: brief(p), admittedAfterMs: admitted.afterMs, pRoot, pFiles,
        thread: thread.map(comment => ({ by: comment.authorType, body: comment.body.slice(0, 120) })) };
    } finally { await h.stop(); }
  }, 300_000);

  it("CAP (the snap's deadline): the save hangs with a message parked -> at the cap R ends, the agent does not read error, the parked message runs once within a minute, 0 'no run started'; the save then returns -> R stays as it ended", async () => {
    const CAP = 2_000;
    const h = await hungRWithParkedMessage(CAP);
    try {
      const startAt = Date.now();
      while ((await h.run(h.r.id)).status === "running" && Date.now() - startAt < CAP + 15_000) { await h.sweep(h.r.id); await sleep(200); }
      const ended = await h.run(h.r.id);
      expect(ended).toMatchObject({ status: "failed", errorCode: STALLED });
      const agentAtEnd = await h.agentRead();
      expect(agentAtEnd).toMatchObject({ lifecycleState: "ready" });
      expect(agentAtEnd.status).not.toBe("error");
      const admitted = await h.admitParked(60_000);
      expect(admitted.runs, "the parked message never started").toHaveLength(1);
      expect(admitted.turns).toBe(1);
      const frozen = brief(await h.run(h.r.id));
      h.s.releaseStall();
      await h.heartbeat.drainActiveRunExecutions();
      await h.sweep(h.r.id);
      await h.present();
      expect(await h.agentRead()).toMatchObject({ status: "idle", lifecycleState: "ready" });
      await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      const thread = await h.thread();
      expect(thread.filter(comment => /no run started|wasn't answered/i.test(comment.body))).toEqual([]);
      expect(thread.filter(comment => comment.createdByRunId === admitted.runs[0].id && comment.authorType === "agent")).toHaveLength(1);
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      expect(await h.s.servedLine(h.r.id)).toMatchObject({ status: "failed", state: "lost", shown: THE_LINE });
      evidence.CAP = { R: frozen, agentAtEnd, admittedAfterMs: admitted.afterMs };
    } finally { await h.stop(); }
  }, 300_000);

  it("STOP, as the product is today (cause.md DESIGN CHOICE 1 is open): Stop during the hung save -> R is cancelled and never flips when the save returns; the agent does not read error; the parked message is held with one line and is answered once, with the person's next message", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    try {
      const stopped = await request(h.s.app).post(`/api/heartbeat-runs/${h.r.id}/cancel`).send({ cancellationRequestId: randomUUID() });
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      const frozen = brief(await h.run(h.r.id));
      expect(frozen).toMatchObject({ status: "cancelled" });
      expect((await h.agentRead()).status).not.toBe("error");
      // Held by the Stop rule (modules/wake-queue/adapters/postgres.ts, "An operator stop never promotes old queued work").
      const held = await h.admitParked(5_000);
      expect(held.runs).toEqual([]);
      expect((await h.wakesOf(h.next)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]);
      // The save returns late: R never flips.
      h.s.releaseStall();
      await h.heartbeat.drainActiveRunExecutions();
      await h.sweep(h.r.id);
      await h.present();
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      // Never silence for the held message (the sweep's clock 10 and 20 minutes on). COMPOSED ON I-A'' (bb-2d-onIA):
      // on 2d's own base this row read ONE sweep line here ("the product as it is today", DESIGN CHOICE 1 open).
      // I-A'' ruled that choice (Known #4 / ruling (b), recovery/unanswered-person-message.ts "Stop means stop"): a
      // message held by its own sender's Stop is the sender's to send again, so the sweep posts NO card on it, and it
      // is not silent because the queue panel lists it (the real GET below). Same reading as I-A'''s own row
      // "Known #4 task: held by the person's Stop with no typed message gets no card and the queue panel lists them".
      await h.sweepUnanswered(new Date(Date.now() + 10 * 60_000));
      await h.sweepUnanswered(new Date(Date.now() + 20 * 60_000));
      const lines = (await h.thread()).filter(comment => comment.authorType === "system" && /your message/i.test(comment.body));
      expect(lines.map(comment => comment.body)).toEqual([]);
      const panel = await request(h.s.app).get(`/api/issues/${h.s.issueId}/queued-comments`);
      expect(panel.status, JSON.stringify(panel.body)).toBe(200);
      expect((panel.body.entries as Array<{ comment: { id: string } }>).map(entry => entry.comment.id), JSON.stringify(panel.body)).toEqual([h.next]);
      process.stdout.write(`ADMIT-STOP-PANEL ${JSON.stringify({ sweepLines: lines.length, executionWait: panel.body.executionWait ?? null, entries: panel.body.entries.length })}\n`);
      // The person's next message starts ONE run that carries both.
      const again = await h.s.say("Please continue: add the summary section.");
      const before = box.inputs.length;
      for (const startAt = Date.now(); Date.now() - startAt < 30_000 && box.inputs.length === before;) { await h.heartbeat.resumeQueuedRuns(); await sleep(250); }
      await h.heartbeat.drainActiveRunExecutions();
      const later = (await h.s.runs()).slice(2);
      expect(later.map(run => run.status)).toEqual(["succeeded"]);
      expect(JSON.stringify(later[0].contextSnapshot)).toContain(again);
      expect((await h.wakesOf(h.next)).map(wake => wake.status)).not.toContain("deferred_issue_execution");
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      evidence.STOP = { R: frozen, sweepLines: lines.map(comment => comment.body),
        panel: { executionWait: panel.body.executionWait ?? null, entries: (panel.body.entries as Array<{ comment: { id: string } }>).map(entry => entry.comment.id) },
        laterRuns: later.map(brief) };
    } finally { await h.stop(); }
  }, 300_000);

  // PAUSE (F3) is NOT in this compose. Under RFL's ruling 3B (05:33Z) a tree Pause leaves a deferred wake that
  // carries a PERSON's message deferred, and release drains it once: adopt-lead's hold compose owns that change and
  // its row K16 (issue-tree-control.ts :1338-1349). The "one true line at once" fix and its PAUSE row live at
  // bb/admit fdefdda2 (+ the row in 217557c96) as the FALLBACK if K16 ever goes red.

  // RETRY-EXPORT WINDOW (noflip limit 3 / rf-5 06:48Z (3)). Nobody is parked when R's save fails for the last time, so R
  // keeps its files (KEPT) and its export recovery. The person presses Retry export: R's copy-back is reopened and, since
  // K12, R is NOT `running` while it copies. A message sent in that window must not start a run on R's root.
  // REAL: turn 0, R (the real executor), the retries, Retry export (retryNativeWorkspaceExport, the function behind
  //   POST /api/issues/:id/recovery-actions/retry-workspace-export), the reopened copy-back (the finalization worker's
  //   own load + check), the person's message (POST /comments), the queue's release and claim (resumeQueuedRuns).
  // NAMED INJECTIONS: CLASSIC-STALL-1 re-armed on R's box for the reopened copy-back; SAVE-FAILS; CLOCK-SKIP.
  // PLANTED (named): the box's stop receipt on R's lease (the provider's own receipt shape; no provider here), as
  //   native-noflip.test.ts plants it. SCRIPTED: the provider console of Retry export (resumeRunLease).
  it("RETRY-EXPORT WINDOW: a message sent while Retry export's reopened copy-back is in flight starts no run on R's root; after the save commits it is answered once, on the saved files; R stays FAILED", async () => {
    const h = await hungRWithParkedMessage(NO_CAP, false);
    let releaseReopened = () => {};
    try {
      // PLANTED (named): the lease's plugin pin. A provider lease always records its acquiring plugin; this harness's
      // box has no provider plugin, and without the pin the retained-export marker cannot name its owner (line LOST).
      await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"pluginId":"plugin-test"}'::jsonb` })
        .where(eq(environmentLeases.heartbeatRunId, h.r.id));
      const ended = await exhaustRetries(h);
      expect(ended).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_retry_exhausted", finishedAt: expect.any(Date) });
      await h.present();
      expect(await h.s.servedLine(h.r.id)).toMatchObject({ status: "failed", state: "kept" });
      const frozen = brief(await h.run(h.r.id));
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, h.s.issueId),
        eq(issueRecoveryActions.cause, "native_workspace_sync_out_retry_exhausted")));
      expect(action).toMatchObject({ status: expect.stringMatching(/^(active|escalated)$/) });
      const reference = record(record((await h.run(h.r.id)).runnerProfileJson).nativeWorkspaceSync);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, reference.leaseId));
      // PLANTED: the box's stop receipt.
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: { ...lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(lease as never, { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } })
        .where(eq(environmentLeases.id, lease.id));
      // The reopened copy-back will hang on R's box (CLASSIC-STALL-1 re-armed), after Retry export's own probe passed.
      h.s.fault.fail = false;
      // REAL: Retry export.
      const retried = await retryNativeWorkspaceExport({ db, companyId: h.s.companyId, issueId: h.s.issueId, actionId: action.id, runId: h.r.id,
        actorId: PERSON, repairNote: "The sandbox provider is reachable again; the saved work is preserved.",
        environmentRuntime: { resumeRunLease: vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: reference.remoteCwd } })),
          retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" })) } as never });
      expect(retried).toMatchObject({ status: "queued" });
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      let reopenedReached!: () => void;
      const reopened = new Promise<void>(resolve => { reopenedReached = resolve; });
      h.s.fault.stall = { entered: reopenedReached, release: new Promise<void>(resolve => { releaseReopened = resolve; }) };
      const copying = h.sweep(h.r.id).catch(error => error);
      expect(await Promise.race([reopened.then(() => "window open"), sleep(30_000).then(() => "the reopened copy-back never reached R's box")])).toBe("window open");
      // THE WINDOW. REAL: the person's message, then the queue's own release and claim for 6 s.
      const turnsBefore = box.inputs.length;
      const sent = await h.sayNext("Also add a summary section to the report.");
      for (const startAt = Date.now(); Date.now() - startAt < 6_000;) { await h.heartbeat.resumeQueuedRuns(); await sleep(250); }
      const inWindow = (await h.s.runs()).filter(run => JSON.stringify(run.contextSnapshot).includes(sent));
      const windowWakes = (await h.wakesOf(sent)).map(wake => ({ status: wake.status, runId: wake.runId }));
      // It is parked, with the product's own wait (explicit-native-continuation.ts: workspace_repair_required).
      expect(windowWakes).toEqual([{ status: "deferred_issue_execution", runId: null }]);
      expect(box.inputs.length - turnsBefore, "a provider turn started during the reopened window").toBe(0);
      expect(inWindow.filter(run => run.startedAt), "a run started during the reopened window").toEqual([]);
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      // The save returns: the files are saved, the line moves once, R stays as it ended (K12, K15a).
      releaseReopened(); h.s.fault.stall = null;
      await copying;
      await reconcileNativeFinalizations(db, [h.r.id], { environmentRuntime: {} as never }).catch(() => undefined);
      await h.heartbeat.drainActiveRunExecutions();
      await h.present();
      expect(await h.coordinator(h.r.id)).toMatchObject({ phase: "committed" });
      expect(await h.s.servedLine(h.r.id)).toMatchObject({ status: "failed", state: "saved" });
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      expect(await listing(h.hostDir)).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
      // PLANTED (named): the box's stop after the commit (the environment settlement worker's stop-and-retain receipt;
      // no provider here). Until it is recorded R's box is still R's, and the message stays parked behind its cleanup.
      const stillParked = await h.admitParked(3_000);
      expect(stillParked.runs).toEqual([]);
      const [leaseAtCommit] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", failureReason: null,
        metadata: { ...leaseAtCommit.metadata, remoteExecutionTermination: remoteTerminationReceipt(leaseAtCommit as never,
          { providerLeaseId: lease.providerLeaseId!, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
      // The message is then answered ONCE, on the saved files (the task's own root, now holding R's saved edits).
      const admitted = await h.admitParked(60_000);
      expect(admitted.runs.map(run => run.status), "the message never started after the save committed").toHaveLength(1);
      expect(admitted.turns).toBe(1);
      await h.heartbeat.drainActiveRunExecutions();
      const [p] = (await h.s.runs()).filter(run => run.id === admitted.runs[0].id);
      expect(p).toMatchObject({ status: "succeeded" });
      const pRoot = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await h.s.issue()).executionWorkspaceId!)))[0].cwd!;
      expect(await listing(pRoot)).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
      expect(brief(await h.run(h.r.id))).toEqual(frozen);
      expect(pRoot).toBe(h.hostDir);
      expect((await h.agentComments()).filter(comment => comment.createdByRunId === p.id)).toHaveLength(1);
      evidence.RETRY_EXPORT_WINDOW = { R: frozen, windowWakes, inWindow: inWindow.map(brief), P: brief(p), pRoot, rRoot: h.hostDir };
    } finally { releaseReopened(); await h.stop(); }
  }, 300_000);

  // K12, THE EXECUTOR-FAILED RUN (noflip limit 1; rf-5 06:48Z (1)). R accepted its result; then its own executor ended it
  // FAILED while its finalization was still pending. The real reconciler later commits the accepted result (the files
  // are saved, the task settles): R's row is not rewritten.
  // REAL: turn 0 and R (the real executor: the queue's claim, preparation, R's own teardown copy-back, and the
  //   executor's own failure write), reconcileNativeFinalizations (the call the finalization worker and the startup
  //   reconcile make) -> the finalizer's commit; outcomes from GET /api/issues/:id/runs and /comments.
  // NAMED INJECTIONS: EXECUTOR-FAILS (R's scripted provider turn reports provider_transport_failed after it accepted its
  //   own result through PaperclipControlPlanePort); CLASSIC-STALL-1 (held, then released, so the failure lands first).
  // PLANTED: nothing.
  it("K12 EXECUTOR-FAILED: R's executor ends it FAILED after its result was accepted, its finalization still pending -> the reconciler commits the result and saves the files; R stays FAILED with the error, code and end time it ended with; its reply stays once", async () => {
    const FAILURE = { errorCode: "provider_transport_failed", errorMessage: "provider_transport_failed: runner did not durably suspend before checkpoint" };
    const h = await hungRWithParkedMessage(NO_CAP, false, FAILURE);
    try {
      expect(await h.coordinator(h.r.id)).toMatchObject({ phase: "workspace_finalizing", resultId: expect.any(String) });
      // The held box call returns; R's own executor then ends R as failed (its provider turn failed).
      h.s.releaseStall();
      await h.heartbeat.drainActiveRunExecutions();
      const ended = await h.run(h.r.id);
      expect(ended).toMatchObject({ status: "failed", errorCode: FAILURE.errorCode, error: FAILURE.errorMessage, finishedAt: expect.any(Date) });
      expect((await h.coordinator(h.r.id)).phase).not.toBe("committed");
      const frozen = brief(ended);
      expect((await h.s.servedLine(h.r.id)).status).toBe("failed");
      // REAL: the reconciler (twice: the second pass is the replay / the committed-projection repair's chance).
      await reconcileNativeFinalizations(db, [h.r.id], { environmentRuntime: {} as never });
      await h.present();
      expect(await h.coordinator(h.r.id)).toMatchObject({ phase: "committed" });
      await reconcileNativeFinalizations(db, [h.r.id], { environmentRuntime: {} as never });
      await h.heartbeat.resumeQueuedRuns();
      await h.present();
      // R is as it ended: status, error, code, end time. The commit left its receipt.
      const after = await h.run(h.r.id);
      expect(brief(after)).toEqual(frozen);
      expect(record(after.resultJson).endedRunKept).toMatchObject({ schema: "paperclip.ended-run-kept.v1", status: "failed" });
      expect(record(after.resultJson).recoveredExecutionFailure).toBeUndefined();
      // What the person reads (real GETs): the run Failed, no unsaved-files line, the reply once, the files saved.
      const served = await h.s.servedLine(h.r.id);
      expect(served.status).toBe("failed");
      expect(served.shown).toBeNull();
      expect(["saved", null]).toContain(served.state);
      expect(await listing(h.hostDir)).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
      const thread = await h.thread();
      expect(thread.filter(comment => comment.createdByRunId === h.r.id && comment.authorType === "agent").map(comment => comment.body)).toEqual([ANSWER]);
      expect((await h.s.issue()).executionRunId).toBeNull();
      expect(h.errors).toEqual([]);
      evidence.K12_EXECUTOR_FAILED = { R: frozen, receipt: record(after.resultJson).endedRunKept, served, agent: await h.agentRead(), task: (await h.s.issue()).status,
        thread: thread.map(comment => ({ by: comment.authorType, body: comment.body.slice(0, 120) })) };
    } finally { await h.stop(); }
  }, 300_000);

  it("CONTROL: an unrelated LIVE predecessor still blocks. After R ended and the parked message's run P started, a third message stays parked behind the live P and starts only when P ends", async () => {
    const h = await hungRWithParkedMessage(NO_CAP);
    let openGate!: () => void;
    try {
      const gateEntered = new Promise<void>(resolve => { h.s.turnGate.entered = resolve; });
      h.s.turnGate.hold = new Promise<void>(resolve => { openGate = resolve; });
      await exhaustRetries(h);
      // P starts and stays live in its provider turn (TURN-GATE).
      const admitting = h.admitParked(60_000);
      await Promise.race([gateEntered, sleep(60_000)]);
      const [p] = (await h.s.runs()).filter(run => run.id !== h.r.id && JSON.stringify(run.contextSnapshot).includes(h.next));
      expect(p, "P never started").toMatchObject({ status: "running" });
      // REAL: a third message while P is live.
      const third = await h.s.say("And number the sections.");
      await vi.waitFor(async () => expect((await h.wakesOf(third)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]), { timeout: 10_000, interval: 50 });
      const turnsWhileLive = box.inputs.length;
      for (const startAt = Date.now(); Date.now() - startAt < 6_000;) { await h.heartbeat.resumeQueuedRuns(); await sleep(250); }
      // Still parked: R's ended state released nothing of P's.
      expect((await h.wakesOf(third)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]);
      expect(box.inputs.length).toBe(turnsWhileLive);
      expect((await h.s.runs()).filter(run => JSON.stringify(run.contextSnapshot).includes(third))).toEqual([]);
      expect((await h.run(p.id)).status).toBe("running");
      // P ends: the third message starts once.
      openGate();
      await admitting;
      await h.heartbeat.drainActiveRunExecutions();
      for (const startAt = Date.now(); Date.now() - startAt < 30_000 && box.inputs.length === turnsWhileLive;) { await h.heartbeat.resumeQueuedRuns(); await sleep(250); }
      await h.heartbeat.drainActiveRunExecutions();
      const carrying = (await h.s.runs()).filter(run => JSON.stringify(run.contextSnapshot).includes(third));
      expect(carrying.map(run => run.status)).toEqual(["succeeded"]);
      evidence.CONTROL = { P: brief(await h.run(p.id)), third: carrying.map(brief) };
    } finally { openGate?.(); await h.stop(); }
  }, 300_000);
});
