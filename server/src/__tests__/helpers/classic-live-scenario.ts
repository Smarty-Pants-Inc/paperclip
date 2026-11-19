import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issues,
  projects, projectWorkspaces, type Db } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

// The LIVE-TEARDOWN harness of the classic stuck-save cut, moved here UNCHANGED from
// services/native-runtime/native-classic-bound.test.ts so that any test file (a judge's included) can import it.
// Importing this module installs the three module mocks below for the importing test file: import it FIRST,
// before anything that loads the heartbeat service.
//   REAL ........ every run (turn 0, R, P and later) is a real run of the real executor: the real queue, claim,
//                 workspace preparation, environment acquisition, prepareNativeWorkspaceSync and teardown copy-back.
//   SCRIPTED .... the provider turn only (box.session); what it is given is the product's own input (box.inputs).
//   NAMED INJECTION, CLASSIC-STALL-1: every sandbox command of R's box blocks from R's accepted result until
//                 releaseStall().
const box = vi.hoisted(() => ({ targets: new Map<string, unknown>(), inputs: [] as unknown[],
  nextBox: null as null | ((leaseId: string, real: () => Promise<any>, lease: any) => Promise<unknown>),
  /** The scripted provider turn of one run (the live-executor rows): returns after it accepted its own result. */
  session: null as null | ((input: { execution: any; runnerInstanceId: string; db: unknown }) => Promise<unknown>),
  /** HELD-PUBLICATION-1: the first sync publication after arming waits here (one shot). */
  publication: null as null | { armed: boolean; entered: () => void; release: Promise<void> } }));
// NAMED INJECTION HELD-PUBLICATION-1 (FU-c): the run-reference publication of a finalized sync (persistRunReference,
// native-workspace-sync.ts, the statement after the copy-back's LAST ownership check) waits until the test releases it.
// Everything it then does is the product's own code.
vi.mock("../../services/transaction-retry.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../services/transaction-retry.js")>();
  return { ...actual, retryUnlessTransactionBound: ((...args: Parameters<typeof actual.retryUnlessTransactionBound>) => {
    const gate = box.publication;
    if (!gate?.armed || !/persistRunReference/.test(new Error().stack ?? "")) return actual.retryUnlessTransactionBound(...args);
    gate.armed = false; gate.entered();
    return gate.release.then(() => actual.retryUnlessTransactionBound(...args));
  }) as typeof actual.retryUnlessTransactionBound };
});
vi.mock("../../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async (input: { leaseId?: string | null }) =>
    box.targets.get(String(input.leaseId)) ?? await box.nextBox?.(String(input.leaseId),
      () => actual.resolveEnvironmentExecutionTarget(input as never), (input as { lease?: unknown }).lease)
      ?? actual.resolveEnvironmentExecutionTarget(input as never)) as unknown as typeof actual.resolveEnvironmentExecutionTarget };
});
vi.mock("../../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../services/heartbeat/runtime-selection.js")>();
  return { ...actual, prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db,
    { ...input, onProviderResourceDisposition: () => input.onProviderResourceDisposition("keep_running") }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime };
});
// The provider turn of the NEXT run is scripted; what it is given is the product's own input.
vi.mock("../../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    box.inputs.push(input.execution);
    const scripted = await box.session?.(input as never);
    if (scripted) return scripted as never;
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "next turn answered" };
  }) as typeof actual.executePaperclipNativeSession };
});
import { readReplyFileLine, replyFileLineText } from "@paperclipai/shared";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { activityRoutes } from "../../routes/activity.js";
import { errorHandler } from "../../middleware/index.js";
import { PaperclipControlPlanePort } from "../../services/native-runtime/paperclip-control-plane-port.js";

export { box };
export const PERSON = "classic-bound-person";
export const ANSWER = "Done. I rewrote the report and added the notes file.";
export const SAVED = { "report.md": "report, saved v1\n", "data/keep.txt": "kept since the first turn\n" };

export type ClassicLiveContext = { db: Db; root: string };

/** The setup the harness needs (the describe's beforeAll): an embedded database, a scratch root, the stubbed
 * environment and the person's user row. `close` is its afterAll. */
/** `retainUnder` (an evidence directory): the box trees, including late-copy bytes, are made there and never removed. */
export async function openClassicLiveContext(prefix = "native-classic-bound-", retainUnder: string | null = null) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  const db = createDb(database.connectionString);
  const root = await fs.realpath(await fs.mkdtemp(path.join(retainUnder ?? os.tmpdir(), "classic-bound-")));
  if (retainUnder) vi.stubEnv("PAPERCLIP_HOME", path.join(root, "retained-home"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
  vi.stubEnv("DATABASE_URL", database.connectionString);
  await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "classic@example.invalid", emailVerified: true,
    createdAt: new Date(), updatedAt: new Date() });
  return { database, db, root, close: async () => {
    await db.$client.end({ timeout: 1 }); await database.cleanup();
    // Evidence runs retain the box trees, including late-copy bytes, rather than cleaning them up.
    if (!retainUnder) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  } };
}
/** The describe's afterEach. */
export function resetClassicLiveBox() { vi.useRealTimers(); box.inputs.length = 0; box.session = null; box.nextBox = null; box.publication = null; }

// SCRIPTED (named): the provider turn. It accepts its own result through PaperclipControlPlanePort, bound as
//   native-session-executor.ts binds it (openRun, the stream, run.result.accepted, run.terminal, completeRun).
// PLANTED (named): the task's workspace row for its saved directory, in the shape row K1's real P leaves behind.
export async function liveScenario({ db, root }: ClassicLiveContext, options: { holdPublication?: boolean;
  /** The task belongs to a project whose primary workspace is a local checkout: the REAL workspace preparation then
   * gives every run that shared checkout as its root (a root the task does not own). The project and its workspace
   * row are the configuration a person makes; they are inserted here. */
  sharedProjectRoot?: boolean } = {}) {
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
  let projectCheckout: string | null = null;
  if (options.sharedProjectRoot) {
    projectCheckout = path.join(root, issueId, "project-checkout");
    await fs.mkdir(projectCheckout, { recursive: true });
    const [project] = await db.insert(projects).values({ companyId, name: "Shared project", status: "in_progress" }).returning();
    const [checkout] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "Primary checkout",
      sourceType: "local_path", cwd: projectCheckout, isPrimary: true }).returning();
    await db.update(issues).set({ projectId: project.id, projectWorkspaceId: checkout.id }).where(eq(issues.id, issueId));
  }
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
  app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {}));
  app.use("/api", activityRoutes(db)); app.use(errorHandler);
  // Every box is a local directory. Only R's box carries the fault, armed after R accepted.
  // SAVE-FAILS (named injection): while `fail` is set, every command of R's box comes back as a failure.
  const fault = { stall: null as null | { entered: () => void; release: Promise<void> }, fail: false };
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
        if (index === faultedBox.index && fault.stall) { fault.stall.entered(); await fault.stall.release; }
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
    // HELD-PUBLICATION-1 instead of CLASSIC-STALL-1: R's copy-back runs to its last ownership check and is held there.
    if (options.holdPublication) box.publication = { armed: true, entered: reached, release: stallRelease };
    else fault.stall = { entered: reached, release: stallRelease };
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
  /** REAL: the run inspector's Workspace tab (GET /api/heartbeat-runs/:runId/workspace-operations), this run's save only. */
  const inspectorSaves = async (runId: string) => {
    const got = await request(app).get(`/api/heartbeat-runs/${runId}/workspace-operations`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return (got.body as Array<{ heartbeatRunId: string | null; phase: string; status: string; stderrExcerpt: string | null }>)
      .filter(operation => operation.heartbeatRunId === runId && operation.phase === "workspace_finalize")
      .map(operation => ({ status: operation.status, stderr: operation.stderrExcerpt }));
  };
  return { companyId, agentId, issueId, app, boxes, runs, issue, say, agentComments, servedLine, inspectorSaves, faultedBox, fault, projectCheckout,
    stallReached, releaseStall: () => { release(); fault.stall = null; } };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The cut's real chain on one liveScenario, as row "K1 live" walks it (ADDED beside the moved harness; that row keeps
 * its own inline walk). Every step is the real route or producer:
 *   turn 0 .. POST /api/issues/:id/comments -> the real queue and executor; its own copy-back saves SAVED
 *   R ....... the next POST wakes it; the real executor runs it into its teardown copy-back, which hangs (CLASSIC-STALL-1)
 *   the cut . a third POST parks behind R; the copy-back worker's own load + check ends R at the person-wait cap
 *   P ....... heartbeat.resumeQueuedRuns starts the parked message in its own root, seeded from R's startup seed
 * `afterCut` runs after R ended and before P is started (the task is bound to no root then).
 * The caller owns `finish()` (its finally): it releases the stall and stops the delivery work.
 */
export async function driveClassicCut(context: ClassicLiveContext, s: Awaited<ReturnType<typeof liveScenario>>,
  options: { capMs?: number; afterCut?: (state: { rRootWorkspaceId: string; rRoot: string; rRunId: string }) => Promise<void> } = {}) {
  const { db } = context;
  const { heartbeatService } = await import("../../services/heartbeat.js");
  const { createDeliveryWorkCoordinator } = await import("../../services/delivery-work-coordinator.js");
  const { nativeWorkspaceFinalizationWork } = await import("../../services/native-runtime/native-workspace-finalization-work.js");
  const { reconcileNativeFinalizations } = await import("../../services/native-runtime/native-finalization-reconciler.js");
  const { agentWakeupRequests, executionWorkspaces } = await import("@paperclipai/db");
  const errors: unknown[] = [];
  const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
  const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
  const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
  const CAP = options.capMs ?? 2_000;
  const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: CAP },
    onWorkspaceSettled: async () => undefined });
  const sweep = async (runId: string) => { for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry); };
  const finish = async () => { s.releaseStall(); receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions(); };
  try {
    await receipts.ready;
    // REAL turn 0.
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
    expect(r0, "turn 0 never ran").toMatchObject({ status: "succeeded" });
    const [rRootWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!));
    const rRoot = rRootWorkspace.cwd!;
    // REAL: M wakes R, which hangs in its own teardown copy-back.
    await s.say("Please rewrite the report.");
    const hung = Promise.race([s.stallReached.then(() => "hung" as const), sleep(60_000).then(() => "R never reached its copy-back" as const)]);
    for (let waited = 0; waited < 60_000 && !(await Promise.race([hung, sleep(250).then(() => null)])); waited += 250) await heartbeat.resumeQueuedRuns();
    expect(await hung).toBe("hung");
    const [, r] = await s.runs();
    expect(r).toMatchObject({ status: "running", runtimeMode: "native" });
    // REAL: the person's next message parks behind the live R; the bound's own sweep ends R at the cap.
    const next = await s.say("Also add a summary section to the report.");
    const parked = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => wake.status === "deferred_issue_execution" && JSON.stringify(wake.payload).includes(next));
    await vi.waitFor(async () => expect(await parked()).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const parkedAt = (await parked())[0].requestedAt.getTime();
    while ((await s.runs())[1].status === "running" && Date.now() - parkedAt < CAP + 15_000) { await sweep(r.id); await sleep(200); }
    expect((await s.runs())[1]).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_stalled" });
    expect(await s.issue()).toMatchObject({ executionRunId: null, executionWorkspaceId: null });
    await options.afterCut?.({ rRootWorkspaceId: rRootWorkspace.id, rRoot, rRunId: r.id });
    // REAL: P starts once beside R's still-hung executor.
    const startAt = Date.now();
    while (Date.now() - startAt < 30_000 && box.inputs.length < 3) { await heartbeat.resumeQueuedRuns(); await sleep(250); }
    const [, , p] = await s.runs();
    expect(p, "P never started beside R's still-live executor").toBeTruthy();
    const pRootWorkspaceId = (await s.issue()).executionWorkspaceId!;
    const [pRootWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, pRootWorkspaceId));
    return { heartbeat, sweep, errors, finish, capMs: CAP, r0, r, p: p!, nextMessageId: next,
      rRootWorkspaceId: rRootWorkspace.id, rRoot, pRootWorkspaceId, pRoot: pRootWorkspace.cwd! };
  } catch (error) { await finish(); throw error; }
}
