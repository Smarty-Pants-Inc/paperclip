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
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations,
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
// The live-teardown harness (liveScenario, the box and the three module mocks it needs) lives in an exported helper,
// so another test file can import it unchanged. Importing it installs the mocks for this file.
import { box, liveScenario as liveScenarioIn, openClassicLiveContext, resetClassicLiveBox } from "../../__tests__/helpers/classic-live-scenario.js";
import { FILE_LINE_LOST, readReplyFileLine, replyFileLineText } from "@paperclipai/shared";
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { activityRoutes } from "../../routes/activity.js";
import { errorHandler } from "../../middleware/index.js";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { nativeCleanupAdmissionBlock } from "./native-cleanup-admission-hold.js";
import { nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { WITHHELD_REPLY_SAVING_DEADLINE_MS } from "./native-withheld-reply-trigger.js";
import { attemptNativeWorkspaceFinalization, recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";
import { cleanupNativeWorkspaceSync, prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { readPreviousTurnWorkspaceNotice } from "../heartbeat/predecessor-admission.js";

const STALLED = "native_workspace_sync_out_stalled";
const PERSON = "classic-bound-person";
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
describe.skipIf(!support.supported)("classic copy-back bound: the run ends, the next message starts on the saved files in its own root", () => {
  let context: Awaited<ReturnType<typeof openClassicLiveContext>>;
  let db: Db, root: string;
  beforeAll(async () => {
    // Compose (clock2 x oldroot): an evidence run keeps its box trees (late-copy bytes) under the evidence directory.
    context = await openClassicLiveContext("native-classic-bound-",
      process.env.CLASSIC_BOUND_EVIDENCE ? path.dirname(process.env.CLASSIC_BOUND_EVIDENCE) : null);
    ({ db, root } = context);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => resetClassicLiveBox());
  afterAll(async () => {
    if (process.env.CLASSIC_BOUND_EVIDENCE) await fs.writeFile(process.env.CLASSIC_BOUND_EVIDENCE, JSON.stringify(evidence, null, 2));
    await context?.close();
  });

  const ANSWER = "Done. I rewrote the report and added the notes file.";
  const SAVED = { "report.md": "report, saved v1\n", "data/keep.txt": "kept since the first turn\n" };

  /** REAL: the task as the person's page loads it (GET /api/issues/:id), read every 100 ms until stopped. */
  function sampleTask(app: express.Express, issueId: string) {
    const samples: Array<{ at: number; status: string }> = [];
    let stopped = false;
    const loop = (async () => {
      while (!stopped) {
        const at = Date.now();
        const got = await request(app).get(`/api/issues/${issueId}`);
        if (got.status === 200) samples.push({ at, status: String(got.body.status) });
        await sleep(Math.max(0, 100 - (Date.now() - at)));
      }
    })();
    return { samples, stop: async () => { stopped = true; await loop; } };
  }

  async function scenario(options: { sharedProjectRoot?: boolean; gitRepository?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Classic bound", issuePrefix: `C${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write the report", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `C${companyId.slice(0, 6)}-1` });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {}));
    app.use("/api", activityRoutes(db)); app.use(errorHandler);

    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Write the report", criteria: [] },
      canonicalSha256: `classic-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    // PLANTED: the native run that carries M, already executing in its box.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", responsibleUserId: PERSON, startedAt: new Date(),
      contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented" } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    // REAL: the person's message M.
    const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Please rewrite the report.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const messageId: string = sent.body.id;

    // (R is planted before M is sent, so M's wake is deterministically saved behind it; R then carries M.)
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented",
      wakeCommentId: messageId, commentId: messageId } }).where(eq(heartbeatRuns.id, runId));
    const [environment] = await db.insert(environments).values({ name: `Box ${runId}`, driver: "sandbox", status: "active",
      config: { provider: "fake", image: "fixture:test", reuseLease: true } }).returning();
    await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, agentId));

    // REAL: the task's own saved directory (the repository-free task directory), holding what earlier turns saved.
    // C6 control: a root the task does not own (a project's shared primary checkout) instead.
    const hostDir = options.sharedProjectRoot ? path.join(root, runId, "project-primary")
      : await materializeIsolatedTaskDirectory({ companyId, issueId });
    await fs.mkdir(hostDir, { recursive: true });
    for (const [name, body] of Object.entries(SAVED)) {
      await fs.mkdir(path.dirname(path.join(hostDir, name)), { recursive: true });
      await fs.writeFile(path.join(hostDir, name), body);
    }
    if (options.gitRepository) {
      // The task directory is itself a Git repository with saved, UNCOMMITTED state: a modified tracked file, an
      // untracked file and a deleted tracked file. (An agent ran `git init` there in an earlier turn.)
      const git = (...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", ["-C", hostDir, ...args],
        { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      await fs.writeFile(path.join(hostDir, "old.txt"), "tracked, later deleted\n");
      await git("init", "-q", "-b", "main"); await git("add", "-A"); await git("commit", "-q", "-m", "first saved state");
      await fs.writeFile(path.join(hostDir, "report.md"), "report, saved v2 (uncommitted)\n");
      await fs.writeFile(path.join(hostDir, "draft.md"), "untracked draft\n");
      await fs.rm(path.join(hostDir, "old.txt"));
    }
    // PLANTED: R's workspace row, in the shape the real workspace preparation records for that directory (the live
    // row below produces it by the real path: mode shared_workspace, project_primary, local_fs, the task as its source).
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Task directory", status: "active", cwd: hostDir, providerType: "local_fs" }).returning();
    const [leaseRow] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, executionWorkspaceId: workspace.id,
      environmentId: environment.id, provider: "daytona", providerLeaseId: `sandbox-${randomUUID()}`, status: "active", leasePolicy: "ephemeral" }).returning();

    // The box: a local directory; every sandbox command really runs.
    const remoteCwd = path.join(root, runId, "box");
    await fs.mkdir(remoteCwd, { recursive: true });
    type Execute = NonNullable<AdapterSandboxExecutionTarget["runner"]>["execute"];
    const fault = { stall: null as null | { when: (text: string) => boolean; entered: () => void; release: Promise<void> }, commands: 0 };
    const boxTarget = (leaseId: string, cwd: string, faulted: boolean): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox", providerKey: "test", leaseId, remoteCwd: cwd, timeoutMs: 30_000,
      runner: { execute: (async input => {
        if (faulted) {
          fault.commands += 1;
          const text = `${input.command} ${(input.args ?? []).join(" ")} ${input.stdin ?? ""}`;
          if (fault.stall?.when(text)) { fault.stall.entered(); await fault.stall.release; }
        }
        return new Promise(resolve => {
          const child = execFile(input.command, input.args ?? [], { cwd: input.cwd ?? cwd, env: { ...process.env, ...input.env },
            timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
              exitCode: error ? 1 : 0, signal: error?.signal ?? null, timedOut: error?.killed ?? false,
              stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() }));
          child.stdin?.on("error", () => undefined); child.stdin?.end(input.stdin ?? "");
        });
      }) as Execute },
    });
    const target = boxTarget(leaseRow.id, remoteCwd, true);
    box.targets.set(leaseRow.id, target);
    // The next run's box: another local directory, never R's.
    const nextBoxes: string[] = [];
    box.nextBox = async leaseId => {
      const cwd = path.join(root, runId, `next-${leaseId}`);
      await fs.mkdir(cwd, { recursive: true });
      nextBoxes.push(cwd);
      const next = boxTarget(leaseId, cwd, false);
      box.targets.set(leaseId, next);
      return next;
    };
    // REAL: R's classic sync. It seeds the box from the saved directory and keeps the startup seed S0.
    const prepared = await prepareNativeWorkspaceSync({ db, companyId, workspaceId: workspace.id, workspaceLocalDir: hostDir, runId,
      lease: leaseRow as EnvironmentLease, target, resourceDisposition: "keep_running" });
    expect(prepared?.reference).toMatchObject({ state: "prepared", leaseId: leaseRow.id });
    await db.update(issues).set({ executionRunId: runId, executionWorkspaceId: workspace.id, status: "in_progress" }).where(eq(issues.id, issueId));
    // PLANTED with R: M's wake is the one R was started from (the real claim sets both).
    const ownWake = and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`);
    await vi.waitFor(async () => expect(await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(ownWake))
      .toEqual([{ status: "deferred_issue_execution" }]), { timeout: 10_000, interval: 25 });
    const [carried] = await db.update(agentWakeupRequests).set({ status: "claimed", runId, claimedAt: new Date(), updatedAt: new Date() })
      .where(ownWake).returning({ id: agentWakeupRequests.id });
    await db.update(heartbeatRuns).set({ wakeupRequestId: carried.id }).where(eq(heartbeatRuns.id, runId));
    // R's edits, in the box only: a changed saved file and a new file.
    await fs.writeFile(path.join(remoteCwd, "report.md"), "report, REWRITTEN BY R (unsaved)\n");
    await fs.writeFile(path.join(remoteCwd, "notes.md"), "R's new notes (unsaved)\n");

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
      await store.appendEvent(event("item.delta", { kind: "agentMessage", channel: "final", text: ANSWER }));
      await store.appendEvent(event("item.completed", { kind: "agentMessage", channel: "final", providerPhase: "final", text: ANSWER }));
      await store.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
        summary: "Rewrote the report.", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
        terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
        turnId: "answer-turn" });
    }
    const settled: unknown[] = [];
    /** REAL: the copy-back worker's own discovery and check. */
    function worker(copyOutBound?: { noAttemptMs?: number; attemptTimeoutMs?: number; personWaitCapMs?: number; now?: () => number }) {
      const options = { environmentRuntime: {} as never, onWorkspaceSettled: async (input: unknown) => { settled.push(input); },
        ...(copyOutBound ? { copyOutBound } : {}) };
      const work = nativeWorkspaceFinalizationWork(db, options as never);
      return { check: async () => {
        const entries = await work.load({ companyId, runId });
        const results = [];
        for (const entry of entries) results.push(await work.check(entry));
        return { entries: entries.length, results };
      } };
    }
    const coordinator = async () => (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0];
    const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseRow.id)))[0];
    const attempts = async () => (await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize")))).map(operation => operation.status);
    const recovery = async () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    async function presentationWorker() {
      const work = nativeResponsePresentationWork(db);
      for (const entry of await work.load({ companyId, issueId })) await work.check(entry);
    }
    /** REAL: what the person's thread loads. */
    async function thread() {
      const got = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return got.body as Array<{ id: string; body: string; authorType: string; createdByRunId: string | null }>;
    }
    const replies = async () => (await thread()).filter(comment => comment.authorType === "agent");
    /** REAL: R's file line as the thread is served it (GET /api/issues/:id/runs), through the ONE renderer. */
    async function servedLine() {
      const got = await request(app).get(`/api/issues/${issueId}/runs`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      const served = (got.body as Array<{ runId: string; resultJson: Record<string, any> | null }>).find(row => row.runId === runId);
      const state = readReplyFileLine(served?.resultJson?.replyFileLine);
      return { state: state?.state ?? null, served: served?.resultJson ?? null,
        shown: replyFileLineText(state, { nowMs: Date.now(), recoverSavedFilesShown: false }),
        shownWithRecoverButton: replyFileLineText(state, { nowMs: Date.now(), recoverSavedFilesShown: true }) };
    }
    function armStall(when: (text: string) => boolean = () => true) {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      fault.stall = { when, entered, release: new Promise<void>(resolve => { release = resolve; }) };
      return { reached, release: () => { release(); fault.stall = null; } };
    }
    /** REAL: the person's next message, parked behind R. */
    async function personSaysWhileSaving(body: string) {
      const next = await request(app).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      const parked = async () => (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(wake => JSON.stringify(wake.payload).includes(next.body.id));
      await vi.waitFor(async () => expect(await parked()).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const [wake] = await parked();
      expect(wake).toMatchObject({ requestedByActorType: "user", requestedByActorId: PERSON, runId: null });
      return { id: next.body.id as string, wake };
    }
    return { app, companyId, agentId, issueId, runId, messageId, leaseId: leaseRow.id, providerLeaseId: leaseRow.providerLeaseId!, target, fault,
      hostDir, remoteCwd, workspaceId: workspace.id, environmentId: environment.id, prepared: prepared!, nextBoxes,
      streamAndAccept, worker, coordinator, run, issue, lease, attempts, recovery, presentationWorker, thread, replies, servedLine,
      armStall, personSaysWhileSaving, settled };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** The parked message `nextId` starts once R ended: the product's own release, admission, preparation and input. */
  async function parkedMessageStarts(s: Scenario, nextId: string) {
    const wakes = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => JSON.stringify(wake.payload).includes(nextId));
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const successors = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, s.companyId),
      sql`${heartbeatRuns.id} <> ${s.runId}`))).filter(run => JSON.stringify(run.contextSnapshot).includes(nextId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const boundAt = Date.now();
    let startedAfterMs = -1;
    // Read at every admission pass: the Runner's task-wide cleanup gate (T11 probe), as queue.ts:1223 reads it.
    const cleanupGate: Array<string | null> = [];
    try {
      await receipts.ready;
      do {
        cleanupGate.push(nativeCleanupAdmissionBlock({ companyId: s.companyId, issueId: s.issueId }));
        await heartbeat.resumeQueuedRuns();
        const [started] = await successors();
        if (started?.startedAt && startedAfterMs < 0) startedAfterMs = Date.now() - boundAt;
        // Far enough: the next run prepared its workspace and reached its provider turn.
        if (box.inputs.length) break;
        if (started && ["failed", "cancelled", "timed_out"].includes(started.status)) break;
        await sleep(250);
      } while (Date.now() - boundAt < 60_000);
    } finally { receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions(); }
    const all = await successors();
    return { successor: all[0], successors: all, startedAfterMs, wakes: await wakes(), errors: errors.map(String), cleanupGate: [...new Set(cleanupGate)],
      providerInputs: [...box.inputs] as Array<Record<string, any>> };
  }

  it("K1 + K2r + K5 + K6 + K9, the person's shape: the copy-back hangs before any apply, a message is parked -> at the cap R ends, P starts once on the saved files in its own root and box, R's reply stays once with the LOST line; R's late apply never touches P's root", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const stall = s.armStall();
    const CAP = 2_000;
    // The production attempt timeout (40 min) and no-attempt bound (60 s). Only the cap is shortened: 5 min -> 2 s.
    const checking = s.worker({ personWaitCapMs: CAP }).check();
    try {
      await stall.reached;
      expect(await s.attempts()).toEqual(["running"]);
      const next = await s.personSaysWhileSaving("Also add a summary section to the report.");
      expect((await s.issue()).executionRunId).toBe(s.runId);
      // K1: R ends by the cap, counted from the parking.
      const checked = await Promise.race([checking, sleep(CAP + 15_000).then(() => "not ended by the cap" as const)]);
      const endedAfterParkingMs = Date.now() - next.wake.requestedAt.getTime();
      expect(checked).toEqual({ entries: 1, results: [null] });
      expect(endedAfterParkingMs).toBeGreaterThanOrEqual(CAP);
      const ended = await s.run();
      expect(ended).toMatchObject({ status: "failed", errorCode: STALLED, finishedAt: expect.any(Date) });
      expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: STALLED });
      // The hung attempt is still running: nothing waited for it.
      expect(await s.attempts()).toEqual(["running"]);
      // C8: the run's own error and next action never say "kept for recovery" beside the LOST line.
      expect(ended.error).not.toMatch(/kept for recovery|set aside|recover/i);
      expect(ended.error).toMatch(/file changes were not saved/);
      const actions = (await s.recovery()).filter(action => action.cause === STALLED);
      expect(actions).toHaveLength(1);
      expect(actions[0].nextAction).not.toMatch(/kept|set aside|recover/i);
      expect(record((await s.coordinator()).failureDetail).nextAction).toBe(actions[0].nextAction);
      // C16: the marker on the run names the fence and carries no owner identity.
      const marker = record(record(ended.resultJson).workspaceSyncOutStall);
      expect(marker.workspace).toMatchObject({ kind: "classic_isolated", sourceRunId: s.runId, quarantine: { state: "retained", leaseId: s.leaseId } });
      expect(JSON.stringify(ended.resultJson)).not.toMatch(/"token"|processGroupId|controllerBootId|processStartedAt/);
      // The owner receipt is a tombstone: the hung attempt holds nothing any more.
      expect(record(record(ended.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      // R's own reference is untouched and still `prepared` (K5 rests on it).
      expect(readNativeWorkspaceSyncReference(record(ended.runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared", leaseId: s.leaseId });
      // The task is detached from R's root.
      // C12 (rf-5 06:58Z): a person is waiting, so the task is NOT set Blocked: it stays In progress for P.
      expect(await s.issue()).toMatchObject({ executionRunId: null, executionWorkspaceId: null, status: "in_progress" });

      // R's reply: once, with the LOST line, read from the real GETs.
      await s.presentationWorker();
      const [reply, ...more] = await s.replies();
      expect(more).toEqual([]);
      expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
      const line = await s.servedLine();
      expect(line).toMatchObject({ state: "lost", shown: THE_LINE, shownWithRecoverButton: THE_LINE });
      expect(THE_LINE).toBe(FILE_LINE_LOST);

      // K1 / K6: P starts once, through the real release and admission, not parked by R's pending cleanup.
      const hostBefore = await treeSha256(s.hostDir);
      const started = await parkedMessageStarts(s, next.id);
      expect(started.errors).toEqual([]);
      expect(started.successors).toHaveLength(1);
      const p = started.successor;
      expect(started.wakes.map(wake => wake.status)).not.toContain("deferred_issue_execution");
      expect(started.providerInputs).toHaveLength(1);
      // T11 probe: the Runner's task-wide cleanup gate never held P.
      expect(started.cleanupGate).toEqual([null]);
      // P's input says the previous turn's file changes weren't saved, once (no "kept for recovery").
      const notice = readPreviousTurnWorkspaceNotice(p.contextSnapshot);
      expect(notice).toMatch(/were not saved/);
      expect(notice).not.toMatch(/kept for recovery|set aside/);
      expect(JSON.stringify(started.providerInputs[0]).split("were not saved")).toHaveLength(2);
      expect(p.contextSnapshot).toMatchObject({ previousRunId: s.runId, previousTurnWorkspaceNotice: { runId: s.runId } });
      // C9: the thread is kept (no forced fresh session), as on the prepared-epoch branch.
      expect(record(p.contextSnapshot).forceFreshSession).toBeUndefined();
      // P's root: its own directory, a sibling of R's, holding exactly the saved files (S0), not R's edits.
      const reference = readNativeWorkspaceSyncReference(record(p.runnerProfileJson).nativeWorkspaceSync)!;
      // (P's scripted turn returned, so P's own copy-back may already have finished: its sync is its own.)
      expect(["prepared", "finalized"]).toContain(reference.state);
      const pWorkspaceId = (await s.issue()).executionWorkspaceId!;
      expect(pWorkspaceId).not.toBe(s.workspaceId);
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, pWorkspaceId));
      const pRoot = pWorkspace.cwd!;
      expect(pRoot).not.toBe(s.hostDir);
      expect(pRoot.startsWith(`${s.hostDir}${path.sep}`)).toBe(false);
      expect(pRoot).toContain(`${path.sep}isolated-workspace-attempts${path.sep}`);
      expect(await listing(pRoot)).toEqual(SAVED);
      // ... and P's box was seeded with the same saved files.
      expect(await listing(reference.remoteCwd)).toEqual(SAVED);
      // K5: P did not adopt R's warm box. Lease and box ids differ, read back.
      expect(reference.leaseId).not.toBe(s.leaseId);
      expect(reference.providerLeaseId).not.toBe(s.providerLeaseId);
      expect(reference.remoteCwd).not.toBe(s.remoteCwd);
      expect(s.nextBoxes).toContain(reference.remoteCwd);
      // ... and the acquisition's own exclusion (environment-runtime.ts:2233 / :2673) keeps R's box out for P, on R's lease.
      expect(await nativeWorkspaceExportPendingForResource(db, await s.lease(), p.id)).toBe(true);
      // The saved directory R was seeded from is byte-unchanged so far.
      expect(await treeSha256(s.hostDir)).toBe(hostBefore);

      // K2r / K9: R's quarantined copy-back finishes later. Its apply lands in R's OLD root only.
      const pRootBefore = await treeSha256(pRoot), pBoxBefore = await treeSha256(reference.remoteCwd);
      stall.release();
      await vi.waitFor(async () => expect(await s.attempts()).toEqual(["failed"]), { timeout: 30_000, interval: 50 });
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      expect(await treeSha256(reference.remoteCwd)).toBe(pBoxBefore);
      expect(await listing(pRoot)).toEqual(SAVED);
      // R's authority is refused, by name; nothing of R's is recorded as saved.
      const [late] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
        eq(workspaceOperations.phase, "workspace_finalize")));
      expect(late.status).toBe("failed");
      const lateRun = await s.run();
      expect(readNativeWorkspaceSyncReference(record(lateRun.runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared" });
      expect(lateRun).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: STALLED });
      // A later sweep and a later direct attempt find nothing to do and claim nothing.
      expect(await s.worker().check()).toEqual({ entries: 0, results: [] });
      await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never });
      expect(await s.attempts()).toEqual(["failed"]);
      expect(record(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      // T4: a check that was already past discovery when R ended (attemptNativeWorkspaceFinalization, the worker's
      // own attempt) claims nothing and raises no "owner unverified" action on a task that has moved on.
      expect(await attemptNativeWorkspaceFinalization({ db, runId: s.runId, environmentRuntime: {} as never }))
        .toEqual({ kind: "waiting", reason: "binding_changed" });
      expect((await s.recovery()).map(action => action.cause).filter(cause => /owner_unverified/.test(String(cause)))).toEqual([]);
      // ONE true line for R's turn, never two; ONE reply.
      await s.presentationWorker();
      const after = await s.replies();
      const agentComments = after.map(comment => ({ by: comment.createdByRunId === s.runId ? "R" : comment.createdByRunId === p.id ? "P" : comment.createdByRunId, body: comment.body }));
      expect(after.filter(comment => comment.createdByRunId === s.runId)).toHaveLength(1);
      expect(await s.servedLine()).toMatchObject({ state: "lost", shown: THE_LINE });
      // No "no run started" and no second notice: the thread is M, R's reply, the next message and P's reply.
      const thread = (await s.thread()).map(comment => ({ authorType: comment.authorType, by: comment.createdByRunId === s.runId ? "R"
        : comment.createdByRunId === p.id ? "P" : comment.createdByRunId, body: comment.body }));
      expect(thread.filter(comment => comment.authorType !== "user" && comment.by !== "R" && comment.by !== "P")).toEqual([]);
      expect(thread.filter(comment => comment.by === "P")).toHaveLength(1);
      expect(JSON.stringify(thread)).not.toMatch(/no run started/i);
      // REAL: the board presses its stale controls for R (Recover saved files, Retry workspace export). Recorded as
      // answered; whatever they answer, R regains nothing and P's root and binding stay as they are.
      const recover = await request(s.app).post(`/api/issues/${s.issueId}/recovery-actions/recover-workspace`)
        .send({ actionId: actions[0].id, runId: s.runId, idempotencyKey: randomUUID() });
      const retry = await request(s.app).post(`/api/issues/${s.issueId}/recovery-actions/retry-workspace-export`)
        .send({ actionId: actions[0].id, runId: s.runId, repairNote: "The copy-back was stuck; retry the export of this run's files." });
      await s.worker().check().catch(() => undefined);
      await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never }).catch(() => undefined);
      await s.presentationWorker();
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      expect((await s.run()).status).toBe("failed");
      expect(readNativeWorkspaceSyncReference(record((await s.run()).runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared" });
      expect(record(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      expect((await s.replies()).filter(comment => comment.createdByRunId === s.runId)).toHaveLength(1);
      expect(await s.servedLine()).toMatchObject({ state: "lost", shown: THE_LINE });
      // C12: R's accepted result said `done`. It was never applied: the task is not Done.
      expect((await s.issue()).status).not.toBe("done");
      // P's task binding still names P's root.
      expect((await s.issue()).executionWorkspaceId).toBe(pWorkspaceId);
      evidence.K1 = { capMs: CAP, endedAfterParkingMs, startedAfterMs: started.startedAfterMs, run: { status: lateRun.status, errorCode: lateRun.errorCode,
        error: lateRun.error, marker }, nextAction: actions[0].nextAction, line, notice, cleanupGate: started.cleanupGate,
        R: { leaseId: s.leaseId, providerLeaseId: s.providerLeaseId, box: s.remoteCwd, root: s.hostDir, rootAfterLateApply: await listing(s.hostDir) },
        P: { runId: p.id, leaseId: reference.leaseId, providerLeaseId: reference.providerLeaseId, box: reference.remoteCwd, root: pRoot,
          files: await listing(pRoot), rootSha256Before: pRootBefore, rootSha256After: await treeSha256(pRoot) },
        agentComments, thread, staleBoardPresses: { recover: { status: recover.status, body: recover.body }, retry: { status: retry.status, body: retry.body } },
        task: { status: (await s.issue()).status }, lateAttempt: { status: late.status, stderr: late.stderrExcerpt, metadata: late.metadata } };
    } finally { stall.release(); await checking.catch(() => undefined); await cleanupNativeWorkspaceSync(s.runId); }
  }, 240_000);
  it("K4 (control): a slow copy-back with NOBODY parked is not cut at the cap; it finishes, the files are saved and the line is SAVED", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const stall = s.armStall();
    // The cap (400 ms) is far shorter than this copy-back. Nobody is parked.
    const checking = s.worker({ personWaitCapMs: 400 }).check();
    try {
      await stall.reached;
      await sleep(2_500);
      // Six caps later the run is untouched.
      expect(await s.attempts()).toEqual(["running"]);
      expect(await s.run()).toMatchObject({ status: "running", errorCode: null });
      expect(await s.coordinator()).toMatchObject({ failureCode: null });
      expect(record((await s.run()).resultJson).workspaceSyncOutStall).toBeUndefined();
      stall.release();
      expect(await checking).toEqual({ entries: 1, results: [null] });
      expect(await s.attempts()).toEqual(["succeeded"]);
      // REAL: the reconciler commits the saved result.
      await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never });
      expect(await s.coordinator()).toMatchObject({ phase: "committed" });
      expect((await s.run()).status).toBe("succeeded");
      expect(await listing(s.hostDir)).toEqual({ ...SAVED, "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
      await s.presentationWorker();
      expect(await s.replies()).toHaveLength(1);
      expect((await s.servedLine()).shown).toBeNull();
      expect(await s.issue()).toMatchObject({ executionWorkspaceId: s.workspaceId });
      evidence.K4 = { capMs: 400, waitedMs: 2_500, run: (await s.run()).status, line: await s.servedLine(), files: await listing(s.hostDir) };
    } finally { stall.release(); await checking.catch(() => undefined); await cleanupNativeWorkspaceSync(s.runId); }
  }, 120_000);

  it.each([6, 9])("K10b / K4: a healthy %i-minute classic copy with nobody parked SAVES before the file-line deadline", async minutes => {
    // PLANTED run/claim as named in scenario; real preparation, acceptance, copy-back and GET.
    const s = await scenario();
    await s.streamAndAccept();
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId));
    expect(WITHHELD_REPLY_SAVING_DEADLINE_MS).toBe(10 * 60_000);
    const stall = s.armStall();
    let clock = accepted.createdAt.getTime();
    const checking = s.worker({ now: () => clock, personWaitCapMs: 100 }).check();
    try {
      await stall.reached;
      clock += minutes * 60_000;
      await sleep(350); // Let the real worker re-read its clock, without moving DB timestamps.
      expect(await s.run()).toMatchObject({ status: "running", errorCode: null });
      stall.release();
      expect(await checking).toEqual({ entries: 1, results: [null] });
      await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never });
      await s.presentationWorker();
      expect(await s.run()).toMatchObject({ status: "succeeded" });
      expect(await s.attempts()).toEqual(["succeeded"]);
      expect(await s.replies()).toHaveLength(1);
      expect((await s.servedLine()).state).not.toBe("lost");
      expect((await s.servedLine()).shown).toBeNull();
      expect(await fs.readFile(path.join(s.hostDir, "notes.md"), "utf8")).toBe("R's new notes (unsaved)\n");
      evidence[`K${minutes === 6 ? "4-clock2" : "10b"}`] = { minutes, line: await s.servedLine(), run: (await s.run()).status };
    } finally { stall.release(); await checking.catch(() => undefined); }
  }, 120_000);

  it("K10 + K10c: nobody parked, classic copy hangs -> the file deadline ends R once; retries stop; late bytes stay quarantined and cannot publish", async () => {
    // PLANTED run/claim (scenario), beside the real-executor K10 row below. All producers and GETs are real.
    const s = await scenario();
    await s.streamAndAccept();
    await s.presentationWorker();
    expect(await s.servedLine()).toMatchObject({ state: "saving" });
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, s.runId));
    const stall = s.armStall();
    let clock = accepted.createdAt.getTime() + WITHHELD_REPLY_SAVING_DEADLINE_MS - 1_000;
    const checking = s.worker({ now: () => clock, personWaitCapMs: 100 }).check();
    try {
      await stall.reached;
      expect(await s.attempts()).toEqual(["running"]);
      clock += 1_000;
      expect(await Promise.race([checking, sleep(3_000).then(() => "deadline not enforced")]))
        .toEqual({ entries: 1, results: [null] });
      expect(await s.run()).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null });
      await s.presentationWorker();
      const line = await s.servedLine();
      expect(line).toMatchObject({ state: "lost", shown: THE_LINE });
      expect(await s.replies()).toHaveLength(1);
      const commandsAtDeadline = s.fault.commands;
      for (let retry = 0; retry < 3; retry++) expect(await s.worker({ now: () => clock }).check()).toEqual({ entries: 0, results: [] });
      const retryCallsAfterDeadline = s.fault.commands - commandsAtDeadline;
      expect(retryCallsAfterDeadline).toBe(0);
      const taskAtCut = await s.issue();
      // C12 control: NOBODY was parked at the cut, so the task is Blocked as before (GET /api/issues/:id).
      expect(taskAtCut).toMatchObject({ executionRunId: null, executionWorkspaceId: null, status: "blocked" });
      expect((await request(s.app).get(`/api/issues/${s.issueId}`)).body).toMatchObject({ status: "blocked" });
      const frozen = { status: (await s.run()).status, errorCode: (await s.run()).errorCode };
      // REAL: after the cut (nobody was parked at it), the person starts P on the saved state.
      const sent = await request(s.app).post(`/api/issues/${s.issueId}/comments`)
        .send({ body: "Read the saved report and summarize it.", clientRequestId: randomUUID() });
      expect(sent.status).toBe(201);
      const started = await parkedMessageStarts(s, sent.body.id);
      expect(started.successors).toHaveLength(1);
      expect(started.providerInputs).toHaveLength(1);
      const pWorkspaceId = (await s.issue()).executionWorkspaceId!;
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, pWorkspaceId));
      const pRoot = pWorkspace.cwd!;
      expect(pRoot).not.toBe(s.hostDir);
      expect(await listing(pRoot)).toEqual(SAVED);
      const pRootBefore = await treeSha256(pRoot);
      // The old root is now quarantine, not the task's saved workspace. The late apply may only land there.
      stall.release();
      await vi.waitFor(async () => expect(await s.attempts()).toEqual(["failed"]), { timeout: 30_000, interval: 50 });
      const [late] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
        eq(workspaceOperations.phase, "workspace_finalize")));
      expect(late.stderrExcerpt).toContain("native_workspace_finalization_ownership_lost");
      await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never });
      await s.presentationWorker();
      expect({ status: (await s.run()).status, errorCode: (await s.run()).errorCode }).toEqual(frozen);
      expect((await s.issue()).executionWorkspaceId).toBe(pWorkspaceId);
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      expect(await listing(pRoot)).toEqual(SAVED);
      expect(await s.servedLine()).toEqual(line);
      expect((await s.replies()).filter(reply => reply.createdByRunId === s.runId)).toHaveLength(1);
      // NEVER-OK: bytes are kept in the retained old root AND box, not deleted on refusal.
      expect(await fs.readFile(path.join(s.hostDir, "notes.md"), "utf8")).toBe("R's new notes (unsaved)\n");
      expect(await fs.readFile(path.join(s.remoteCwd, "notes.md"), "utf8")).toBe("R's new notes (unsaved)\n");
      const kept = await listing(s.hostDir);
      if (process.env.CLASSIC_BOUND_EVIDENCE) await fs.cp(s.hostDir, `${process.env.CLASSIC_BOUND_EVIDENCE}.K10c-retained`, { recursive: true });
      evidence.K10 = { acceptedAt: accepted.createdAt, deadlineAt: new Date(clock), line, run: frozen,
        downloadOrCaptureCallsAfterDeadlineBeforeLateRelease: retryCallsAfterDeadline,
        retryCallsAfterDeadline, nextRun: { id: started.successor.id, root: pRoot, beforeSha256: pRootBefore, afterSha256: await treeSha256(pRoot) },
        late: { stderr: late.stderrExcerpt, status: late.status, kept, root: s.hostDir, box: s.remoteCwd } };
    } finally { stall.release(); await checking.catch(() => undefined);
      await vi.waitFor(async () => expect(await s.attempts()).not.toContain("running"), { timeout: 30_000, interval: 50 }); }
  }, 120_000);

  it("K8 (applied, not recorded): the host apply FINISHED and the copy-back then hangs before its success is recorded -> the cap still ends R; P starts on the saved files in its own root; the line is LOST; R's later finish records nothing", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    // CLASSIC-STALL-AFTER-APPLY: only the stamp command blocks. It runs after the whole host apply and final scan.
    const stall = s.armStall(text => text.includes("workspace-sync-v1.json"));
    const CAP = 2_000;
    const checking = s.worker({ personWaitCapMs: CAP }).check();
    try {
      await stall.reached;
      // R's files are fully written into R's root; nothing records them as saved.
      const applied = await listing(s.hostDir);
      expect(applied).toEqual({ ...SAVED, "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
      expect(await s.attempts()).toEqual(["running"]);
      const next = await s.personSaysWhileSaving("Also add a summary section to the report.");
      const checked = await Promise.race([checking, sleep(CAP + 15_000).then(() => "not ended by the cap" as const)]);
      expect(checked).toEqual({ entries: 1, results: [null] });
      expect(await s.run()).toMatchObject({ status: "failed", errorCode: STALLED });
      await s.presentationWorker();
      expect(await s.servedLine()).toMatchObject({ state: "lost", shown: THE_LINE });
      const started = await parkedMessageStarts(s, next.id);
      expect(started.successors).toHaveLength(1);
      expect(started.providerInputs).toHaveLength(1);
      const pWorkspaceId = (await s.issue()).executionWorkspaceId!;
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, pWorkspaceId));
      const pRoot = pWorkspace.cwd!;
      // P is on what is committed: the saved files, never R's applied-but-unrecorded tree.
      expect(pRoot).not.toBe(s.hostDir);
      expect(await listing(pRoot)).toEqual(SAVED);
      const pRootBefore = await treeSha256(pRoot);
      // R's copy-back finishes: its publication is refused, by name, and nothing is recorded as saved.
      stall.release();
      await vi.waitFor(async () => expect(await s.attempts()).toEqual(["failed"]), { timeout: 30_000, interval: 50 });
      const [late] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
        eq(workspaceOperations.phase, "workspace_finalize")));
      expect(late.stderrExcerpt).toContain("native_workspace_finalization_ownership_lost");
      const lateRun = await s.run();
      expect(readNativeWorkspaceSyncReference(record(lateRun.runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared", finalHostSha256: null });
      // (persistLeaseStamp's key: no finalized stamp reached R's lease.)
      expect(record((await s.lease()).metadata).nativeWorkspaceSync ?? null).toBeNull();
      expect(lateRun).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      await s.presentationWorker();
      expect((await s.replies()).filter(comment => comment.createdByRunId === s.runId)).toHaveLength(1);
      expect(await s.servedLine()).toMatchObject({ state: "lost", shown: THE_LINE });
      evidence.K8 = { capMs: CAP, rRootAtTheCap: applied, pRoot, pFiles: await listing(pRoot), lateAttempt: { status: late.status, stderr: late.stderrExcerpt },
        leaseMetadataKeys: Object.keys(record((await s.lease()).metadata)) };
    } finally { stall.release(); await checking.catch(() => undefined); await cleanupNativeWorkspaceSync(s.runId); }
  }, 240_000);

  it("C5, V1 vs V2: a copy-back that already SUCCEEDED (V1) is never ended as lost, even past the cap with a message parked: it commits, the line is SAVED and the files are on disk", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    // REAL: the copy-back runs and succeeds; nothing has committed the result yet (V1).
    expect(await s.worker().check()).toEqual({ entries: 1, results: [null] });
    expect(await s.attempts()).toEqual(["succeeded"]);
    expect(await s.run()).toMatchObject({ status: "running" });
    expect((await s.coordinator()).phase).not.toBe("committed");
    const next = await s.personSaysWhileSaving("Also add a summary section to the report.");
    const CAP = 500;
    await sleep(CAP + 700);
    // The bound's sweep does not even list it, and the bound's own terminal write is refused.
    expect(await s.worker({ personWaitCapMs: CAP }).check()).toEqual({ entries: 0, results: [] });
    const refused = await recordNativeWorkspaceFinalizationFailure(db, s.runId, { stderrExcerpt: "workspace_sync_out_stalled" });
    expect(refused.phase).not.toBe("terminal_failure");
    expect(await s.run()).toMatchObject({ status: "running", errorCode: null });
    expect(record((await s.run()).resultJson).workspaceSyncOutStall).toBeUndefined();
    expect(await s.issue()).toMatchObject({ executionWorkspaceId: s.workspaceId });
    // REAL: the reconciler commits it. SAVED, not LOST.
    await reconcileNativeFinalizations(db, [s.runId], { environmentRuntime: {} as never });
    expect(await s.coordinator()).toMatchObject({ phase: "committed" });
    expect((await s.run()).status).toBe("succeeded");
    await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);
    const line = await s.servedLine();
    expect(line.shown).toBeNull();
    expect(line.state).not.toBe("lost");
    expect(await listing(s.hostDir)).toEqual({ ...SAVED, "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
    evidence.C5 = { parked: next.id, capMs: CAP, sweepListed: 0, refusedPhase: refused.phase, coordinator: (await s.coordinator()).phase, line };
    await cleanupNativeWorkspaceSync(s.runId);
  }, 120_000);

  it("C6: a root the task does not own (a project's shared checkout) is NOT eligible: the bound never ends that run, the check re-arms instead of waiting on the hung copy-back, and nothing is detached", async () => {
    const s = await scenario({ sharedProjectRoot: true });
    await s.streamAndAccept();
    const stall = s.armStall();
    const CAP = 1_000;
    const checking = s.worker({ personWaitCapMs: CAP }).check();
    try {
      await stall.reached;
      await s.personSaysWhileSaving("Also add a summary section to the report.");
      // The check returns (it never waits on the hung copy-back) with the SAME deadline armed again.
      const checked = await Promise.race([checking, sleep(CAP + 15_000).then(() => "the check waited on the hung copy-back" as const)]);
      expect(checked).toMatchObject({ entries: 1, results: [{ id: s.runId, dueAt: expect.any(Number) }] });
      const rearmedInMs = (checked as { results: Array<{ dueAt: number }> }).results[0].dueAt - Date.now();
      expect(rearmedInMs).toBeGreaterThan(0);
      expect(rearmedInMs).toBeLessThanOrEqual(30_000);
      // Not ended, not marked, not detached, no tombstone: exactly as it was.
      expect(await s.run()).toMatchObject({ status: "running", errorCode: null });
      expect(record((await s.run()).resultJson).workspaceSyncOutStall).toBeUndefined();
      expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toMatchObject({ token: expect.any(String) });
      expect(await s.coordinator()).toMatchObject({ failureCode: null });
      expect(await s.issue()).toMatchObject({ executionRunId: s.runId, executionWorkspaceId: s.workspaceId });
      expect((await s.recovery()).filter(action => action.cause === STALLED)).toEqual([]);
      evidence.C6 = { rearmedInMs, run: (await s.run()).status, root: s.hostDir };
    } finally { stall.release(); await checking.catch(() => undefined); await sleep(500); await cleanupNativeWorkspaceSync(s.runId); }
  }, 120_000);

  it("RFL saved-file identity (a Git repository in the task directory): P's root holds the actual saved state, the commit AND the uncommitted, untracked and deleted files, not a bare checkout and not R's edits", async () => {
    const s = await scenario({ gitRepository: true });
    const git = (dir: string, ...args: string[]) => new Promise<string>((resolve, reject) => execFile("git", ["-C", dir, ...args],
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    const saved = { files: await listing(s.hostDir), head: (await git(s.hostDir, "rev-parse", "HEAD")).trim(),
      status: await git(s.hostDir, "status", "--porcelain=v1", "--untracked-files=all") };
    expect(saved.files).toEqual({ "report.md": "report, saved v2 (uncommitted)\n", "data/keep.txt": SAVED["data/keep.txt"], "draft.md": "untracked draft\n" });
    await s.streamAndAccept();
    const stall = s.armStall();
    const CAP = 1_500;
    const checking = s.worker({ personWaitCapMs: CAP }).check();
    try {
      await stall.reached;
      const next = await s.personSaysWhileSaving("Also add a summary section to the report.");
      expect(await Promise.race([checking, sleep(CAP + 15_000).then(() => "not ended by the cap" as const)])).toEqual({ entries: 1, results: [null] });
      expect(await s.run()).toMatchObject({ status: "failed", errorCode: STALLED });
      const started = await parkedMessageStarts(s, next.id);
      expect(started.providerInputs).toHaveLength(1);
      expect(started.successors.map(run => run.status)).not.toContain("failed");
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!));
      const pRoot = pWorkspace.cwd!;
      expect(pRoot).not.toBe(s.hostDir);
      const replayed = { files: await listing(pRoot), head: (await git(pRoot, "rev-parse", "HEAD")).trim(),
        status: await git(pRoot, "status", "--porcelain=v1", "--untracked-files=all") };
      expect(replayed).toEqual(saved);
      // A standalone repository: no worktree link or alternates back into R's root.
      expect((await fs.lstat(path.join(pRoot, ".git"))).isDirectory()).toBe(true);
      await expect(fs.access(path.join(pRoot, ".git", "objects", "info", "alternates"))).rejects.toThrow();
      evidence.savedGit = { saved, replayed, pRoot };
    } finally { stall.release(); await checking.catch(() => undefined); await sleep(1_000); await cleanupNativeWorkspaceSync(s.runId); }
  }, 240_000);

  // ---- The LIVE-EXECUTOR entry (C7's axis): R is a real run, hung in its own teardown. ----
  // REAL on top of the rows above: R itself. The person's message M wakes it through the real queue; the real
  // executor claims it, prepares its workspace and box (prepareNativeWorkspaceSync), and after the scripted provider
  // turn reaches the live copy-back (runtime-execution.ts completeWorkspace -> restoreWorkspace), where it hangs.
  // SCRIPTED (named): the provider turn. It accepts its own result through PaperclipControlPlanePort, bound as
  //   native-session-executor.ts binds it (openRun, the stream, run.result.accepted, run.terminal, completeRun).
  // PLANTED (named): the task's workspace row for its saved directory, in the shape row K1's real P leaves behind.
  // liveScenario: __tests__/helpers/classic-live-scenario.ts (moved there unchanged; the SCRIPTED and PLANTED notes with it).
  const liveScenario = (options: { holdPublication?: boolean } = {}) => liveScenarioIn({ db, root }, options);

  it("K10 live executor: real person POST -> real R hangs in its own copy-back, nobody parked -> the acceptance deadline ends it; GET stores one LOST line", async () => {
    const s = await liveScenario();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const sweep = async (runId: string, clock: number) => {
      const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { now: () => clock },
        onWorkspaceSettled: async () => undefined });
      for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry);
    };
    try {
      // REAL turn 0 saves the initial report through the real executor and copy-back.
      await s.say("Please write the report.");
      for (let waited = 0; waited < 60_000; waited += 250) {
        await heartbeat.resumeQueuedRuns();
        await reconcileNativeFinalizations(db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never });
        const [first] = await s.runs();
        if (first && !["running", "queued"].includes(first.status)) break;
        await sleep(250);
      }
      await heartbeat.drainActiveRunExecutions();
      expect((await s.runs())[0]).toMatchObject({ status: "succeeded" });
      // REAL person's message creates R; real preparation, lease/claim, acceptance and teardown, no planted run.
      await s.say("Please rewrite the report.");
      for (let waited = 0; waited < 60_000; waited += 250) {
        await heartbeat.resumeQueuedRuns();
        if (await Promise.race([s.stallReached.then(() => true), sleep(250).then(() => false)])) break;
      }
      const [, r] = await s.runs();
      expect(r).toMatchObject({ status: "running" });
      const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, r.id));
      expect(accepted).toBeTruthy();
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, s.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
      const deadline = accepted.createdAt.getTime() + WITHHELD_REPLY_SAVING_DEADLINE_MS;
      await sweep(r.id, deadline - 1);
      expect((await s.runs())[1].status).toBe("running");
      await sweep(r.id, deadline);
      const presentation = nativeResponsePresentationWork(db);
      for (const item of await presentation.load({ companyId: s.companyId, issueId: s.issueId })) await presentation.check(item);
      const line = await s.servedLine(r.id);
      expect(line).toMatchObject({ status: "failed", state: "lost", shown: THE_LINE });
      expect((await s.agentComments()).filter(c => c.createdByRunId === r.id)).toHaveLength(1);
      await sweep(r.id, deadline + 60_000);
      s.releaseStall();
      await heartbeat.drainActiveRunExecutions();
      expect(await s.servedLine(r.id)).toEqual(line);
      expect((await s.runs()).map(run => run.status)).toEqual(["succeeded", "failed"]);
      evidence.K10live = { runId: r.id, producer: "POST /api/issues/:id/comments -> heartbeat real executor -> PaperclipControlPlanePort.completeRun -> live teardown",
        acceptedAt: accepted.createdAt, deadlineAt: new Date(deadline), line, noParkedMessage: true };
    } finally { s.releaseStall(); await heartbeat.drainActiveRunExecutions(); }
  }, 240_000);

  it("K1 live + C7 (NEVER-OK) + C12: R is a real run hung in its OWN teardown copy-back -> at the cap it ends, P starts once beside the still-live executor; R's late throw never retries R, never overwrites its status, gives no second answer", async () => {
    const s = await liveScenario();
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const settled: unknown[] = [];
    const CAP = 2_000;
    const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: CAP },
      onWorkspaceSettled: async input => { settled.push(input); } });
    const sweep = async (runId: string) => { for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry); };
    try {
      await receipts.ready;
      // REAL turn 0: the person asks for the report; its run saves it through its own real copy-back.
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
      const r0Workspace = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!)))[0];
      evidence.liveTurn0 = { run: { status: r0.status, errorCode: r0.errorCode, error: r0.error }, workspace: r0Workspace, task: await s.issue(),
        files: r0Workspace?.cwd ? await listing(r0Workspace.cwd) : null };
      expect(r0).toMatchObject({ status: "succeeded" });
      const hostDir = r0Workspace.cwd!;
      expect(await listing(hostDir)).toEqual(SAVED);
      // REAL: M wakes R; the real executor runs it up to the live copy-back, which hangs (CLASSIC-STALL-1).
      const m = await s.say("Please rewrite the report.");
      const hung = Promise.race([s.stallReached.then(() => "hung" as const), sleep(60_000).then(() => "R never reached its copy-back" as const)]);
      for (let waited = 0; waited < 60_000 && !(await Promise.race([hung, sleep(250).then(() => null)])); waited += 250) await heartbeat.resumeQueuedRuns();
      expect(await hung).toBe("hung");
      const [, r] = await s.runs();
      expect(r).toMatchObject({ status: "running", runtimeMode: "native" });
      expect(JSON.stringify(r.contextSnapshot)).toContain(m);
      const rReference = readNativeWorkspaceSyncReference(record(r.runnerProfileJson).nativeWorkspaceSync)!;
      expect(rReference).toMatchObject({ state: "prepared", workspaceId: r0Workspace.id, remoteCwd: s.boxes[s.faultedBox.index].cwd });
      expect(record(r.runnerProfileJson).nativeWorkspaceFinalizationOwner).toMatchObject({ token: expect.any(String) });
      // C12: R's accepted result says `done`. Nothing has applied it: the task is still in progress.
      expect(await s.issue()).toMatchObject({ status: "in_progress", executionRunId: r.id });
      // The person's next message parks behind the live R.
      const next = await s.say("Also add a summary section to the report.");
      const parked = async () => (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, s.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(wake => JSON.stringify(wake.payload).includes(next));
      await vi.waitFor(async () => expect(await parked()).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const parkedAt = (await parked())[0].requestedAt.getTime();
      // C12 (rf-5 06:58Z): the task as the person's page reads it, every 100 ms from here until P is running.
      const sampler = sampleTask(s.app, s.issueId);
      // REAL: the bound's own sweep, beside the live executor that still holds the copy-back's lock.
      const ended = async () => (await s.runs())[1].status !== "running";
      while (!(await ended()) && Date.now() - parkedAt < CAP + 15_000) { await sweep(r.id); await sleep(200); }
      const endedAfterParkingMs = Date.now() - parkedAt;
      const [, rEnded] = await s.runs();
      expect(rEnded).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(endedAfterParkingMs).toBeGreaterThanOrEqual(CAP);
      expect(record(record(rEnded.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      expect(JSON.stringify(rEnded.resultJson)).not.toMatch(/"token"|processGroupId|controllerBootId|processStartedAt/);
      // C12: R's accepted `done` is DROPPED, never applied: the task is not Done. A person is waiting, so it is
      // not set Blocked either: it stays In progress for P.
      // (The status itself is read below, from the 100 ms samples of the real GET.)
      expect(await s.issue()).toMatchObject({ executionRunId: null, executionWorkspaceId: null });
      expect((await s.issue()).status).not.toBe("done");

      // P starts ONCE while R's executor is still hung in this same process.
      const startAt = Date.now();
      let p: Awaited<ReturnType<typeof s.runs>>[number] | undefined;
      while (Date.now() - startAt < 30_000 && box.inputs.length < 3) {
        await heartbeat.resumeQueuedRuns();
        await sleep(250);
      }
      [, , p] = await s.runs();
      expect(p, "P never started beside R's still-live executor").toBeTruthy();
      expect(box.inputs).toHaveLength(3);
      // C12: between R's fence and P running, the task NEVER reads Blocked (no In progress -> Blocked -> In progress).
      await sleep(250);
      await sampler.stop();
      const fencedAt = rEnded.finishedAt!.getTime();
      const sinceFence = sampler.samples.filter(sample => sample.at >= fencedAt - 200);
      const maxGapMs = Math.max(0, ...sampler.samples.slice(1).map((sample, index) => sample.at - sampler.samples[index].at));
      evidence.C12 = { route: "GET /api/issues/:id", everyMs: 100, samples: sampler.samples.length, sinceFence: sinceFence.length, maxGapMs,
        statuses: [...new Set(sampler.samples.map(sample => sample.status))],
        blocked: sampler.samples.filter(sample => sample.status === "blocked").map(sample => sample.at - fencedAt),
        pStartedAfterFenceMs: p!.startedAt ? p!.startedAt.getTime() - fencedAt : null };
      expect(sinceFence.length).toBeGreaterThanOrEqual(3);
      expect(sampler.samples.filter(sample => sample.status === "blocked").map(sample => `${sample.at - fencedAt} ms after the fence`)).toEqual([]);
      expect([...new Set(sampler.samples.map(sample => sample.status))]).toEqual(["in_progress"]);
      expect((await request(s.app).get(`/api/issues/${s.issueId}`)).body).toMatchObject({ status: "in_progress" });
      expect(JSON.stringify(p!.contextSnapshot)).toContain(next);
      const startedAfterMs = Date.now() - startAt;
      const pReference = readNativeWorkspaceSyncReference(record(p!.runnerProfileJson).nativeWorkspaceSync)!;
      expect(pReference.leaseId).not.toBe(rReference.leaseId);
      expect(pReference.providerLeaseId).not.toBe(rReference.providerLeaseId);
      expect(pReference.remoteCwd).not.toBe(rReference.remoteCwd);
      const [rLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, rReference.leaseId));
      expect(await nativeWorkspaceExportPendingForResource(db, rLease, p!.id)).toBe(true);
      const pWorkspaceId = (await s.issue()).executionWorkspaceId!;
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, pWorkspaceId));
      const pRoot = pWorkspace.cwd!;
      expect(pRoot).not.toBe(hostDir);
      expect(await listing(pRoot)).toEqual(SAVED);
      expect(readPreviousTurnWorkspaceNotice(p!.contextSnapshot)).toMatch(/were not saved/);
      const pRootBefore = await treeSha256(pRoot);
      const frozen = { status: rEnded.status, errorCode: rEnded.errorCode, error: rEnded.error, finishedAt: rEnded.finishedAt?.toISOString() };

      // C7, NEVER-OK: R's live copy-back returns now. Its apply lands in R's old root and its executor throws late.
      s.releaseStall();
      await heartbeat.drainActiveRunExecutions();
      await sweep(r.id);
      const worker = nativeResponsePresentationWork(db);
      for (const entry of await worker.load({ companyId: s.companyId, issueId: s.issueId })) await worker.check(entry);
      const all = await s.runs();
      const [, rLate] = all;
      // never overwrites R's status;
      expect({ status: rLate.status, errorCode: rLate.errorCode, error: rLate.error, finishedAt: rLate.finishedAt?.toISOString() }).toEqual(frozen);
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, r.id)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode: STALLED });
      expect(readNativeWorkspaceSyncReference(record(rLate.runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared" });
      // never retries R: no run beyond R and P, none retrying R, none carrying M again;
      expect(all.map(run => run.id)).toEqual([r0.id, r.id, p!.id]);
      expect(all.filter(run => run.retryOfRunId === r.id)).toEqual([]);
      // no second answer: R's reply once, with the one LOST line; P's root byte-unchanged.
      const comments = await s.agentComments();
      expect(comments.filter(comment => comment.createdByRunId === r.id).map(comment => comment.body)).toEqual([ANSWER]);
      expect(await s.servedLine(r.id)).toMatchObject({ status: "failed", state: "lost", shown: THE_LINE });
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      expect((await s.issue()).executionWorkspaceId).toBe(pWorkspaceId);
      const lateOperations = (await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, r.id),
        eq(workspaceOperations.phase, "workspace_finalize")))).map(operation => ({ status: operation.status, stderr: operation.stderrExcerpt }));
      expect(lateOperations.map(operation => operation.status)).not.toContain("succeeded");
      expect(errors).toEqual([]);
      // T10: the release did not wait for R's box; its settlement is left to the settlement worker.
      expect(settled).toEqual([{ runId: r.id, companyId: s.companyId, agentId: s.agentId, succeeded: false, skipEnvironmentSettlement: true }]);
      evidence.K1live = { capMs: CAP, endedAfterParkingMs, startedAfterMs, R: { id: r.id, ...frozen, lease: rReference.leaseId, box: rReference.remoteCwd,
        rootAfterLateApply: await listing(hostDir), lateOperations }, P: { id: p!.id, lease: pReference.leaseId, box: pReference.remoteCwd, root: pRoot,
        files: await listing(pRoot) }, runs: all.map(run => ({ id: run.id, status: run.status, retryOfRunId: run.retryOfRunId })),
        task: { status: (await s.issue()).status }, agentComments: comments.map(comment => ({ by: comment.createdByRunId === r.id ? "R" : comment.createdByRunId === p!.id ? "P"
          : comment.createdByRunId === r0.id ? "turn 0" : comment.createdByRunId, body: comment.body })),
        settled };
    } finally {
      s.releaseStall(); receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions();
    }
  }, 240_000);

  // d2 compose (C12 x admit F1). bb/2dfix wrote this control on a task-own root; on d2 that case no longer exists as
  // "non-fenced": admit's F1 (RFL 04:56Z, R ends by ANY path) isolates a save that fails for the LAST time while a
  // person's message is parked. So the control moves to the failure admit does NOT isolate, a root the task does not
  // own, and the task-own-root case is the next row, with admit's outcome.
  it("C12 control: a NON-fenced terminal save failure (the box is gone: unrecoverable; a root the task does not own) still sets the task Blocked, even with a person's message parked", async () => {
    const s = await scenario({ sharedProjectRoot: true });
    await s.streamAndAccept();
    await s.personSaysWhileSaving("Also add a summary section to the report.");
    // PLANTED (named): R's box lease is expired, so the copy-back is unrecoverable. Beside it, the fenced path by the
    // real route is the K1 live row above. REAL from here: the worker's own check -> attemptNativeWorkspaceFinalization
    // -> recordNativeWorkspaceFinalizationFailure -> the finalizer's one terminal write.
    await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, s.leaseId));
    expect(await s.worker().check()).toMatchObject({ entries: 1 });
    const ended = await s.run();
    expect(ended).toMatchObject({ status: "failed", errorCode: "native_workspace_sync_out_unrecoverable" });
    // Not fenced: no stall marker, no tombstone, the task keeps its root.
    expect(record(ended.resultJson).workspaceSyncOutStall).toBeUndefined();
    expect(record(record(ended.runnerProfileJson).nativeWorkspaceFinalizationOwner).fenced).toBeUndefined();
    const task = (await request(s.app).get(`/api/issues/${s.issueId}`)).body;
    expect(task).toMatchObject({ status: "blocked", executionWorkspaceId: s.workspaceId });
    evidence.C12control = { route: "GET /api/issues/:id", root: "a root the task does not own", task: { status: task.status }, run: { status: ended.status, errorCode: ended.errorCode } };
    await cleanupNativeWorkspaceSync(s.runId);
  }, 120_000);

  it("C12 x admit F1: the SAME terminal save failure on the task's OWN root with a person's message parked is isolated as the cap isolates it -> the task is NOT Blocked, and the parked message starts once in its own root on the saved files", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const next = await s.personSaysWhileSaving("Also add a summary section to the report.");
    // PLANTED (named): R's box lease is expired (as the control above). REAL from here: the worker's own check ->
    // attemptNativeWorkspaceFinalization -> recordNativeWorkspaceFinalizationFailure -> the finalizer's one terminal write.
    await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, s.leaseId));
    expect(await s.worker().check()).toMatchObject({ entries: 1 });
    const ended = await s.run();
    // admit F1: ended as the cap ends a classic run (the same code, isolated, its owner a tombstone).
    expect(ended).toMatchObject({ status: "failed", errorCode: STALLED });
    expect(record(record(ended.resultJson).workspaceSyncOutStall).workspace).toMatchObject({ kind: "classic_isolated", sourceRunId: s.runId });
    expect(record(record(ended.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
    expect(await s.coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: STALLED,
      failureDetail: { originalFailureCode: "native_workspace_sync_out_unrecoverable" } });
    // C12: a person is waiting, so the task is not set Blocked (real GET); it is detached from R's root.
    const task = (await request(s.app).get(`/api/issues/${s.issueId}`)).body;
    expect(task).toMatchObject({ status: "in_progress", executionRunId: null, executionWorkspaceId: null });
    // REAL: the parked message is admitted and starts ONCE, in its own root, on the saved files.
    const started = await parkedMessageStarts(s, next.id);
    expect(started.successors).toHaveLength(1);
    expect(started.providerInputs).toHaveLength(1);
    const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!));
    expect(pWorkspace.cwd).not.toBe(s.hostDir);
    expect(await listing(pWorkspace.cwd!)).toEqual(SAVED);
    expect((await request(s.app).get(`/api/issues/${s.issueId}`)).body.status).not.toBe("blocked");
    evidence.C12xAdmitF1 = { route: "GET /api/issues/:id", root: "the task's own root", taskAtEnd: { status: task.status },
      run: { status: ended.status, errorCode: ended.errorCode }, P: { id: started.successor.id, status: started.successor.status, root: pWorkspace.cwd } };
    await cleanupNativeWorkspaceSync(s.runId);
  }, 120_000);

  it("FU-c, the held-publication probe: R's copy-back passed its LAST ownership check and its publication is held; R is fenced at the cap and P starts; the publication is released -> R's reference is not finalized, R's lease is not stamped, the inspector never shows R's save Succeeded, P's files are unchanged", async () => {
    const s = await liveScenario({ holdPublication: true });
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const CAP = 2_000;
    const work = nativeWorkspaceFinalizationWork(db, { environmentRuntime: {} as never, copyOutBound: { personWaitCapMs: CAP },
      onWorkspaceSettled: async () => undefined });
    const sweep = async (runId: string) => { for (const entry of await work.load({ companyId: s.companyId, runId })) await work.check(entry); };
    const seen: string[] = [];
    try {
      await receipts.ready;
      // REAL turn 0, then REAL M -> R (as in the K1 live row): no planted run, lease or workspace.
      await s.say("Please write the report.");
      for (let waited = 0; waited < 60_000; waited += 250) {
        await heartbeat.resumeQueuedRuns();
        await reconcileNativeFinalizations(db, (await s.runs()).map(run => run.id), { environmentRuntime: {} as never }).catch(() => undefined);
        const [first] = await s.runs();
        if (first && first.status !== "running" && first.status !== "queued") break;
        await sleep(250);
      }
      await heartbeat.drainActiveRunExecutions();
      expect((await s.runs())[0]).toMatchObject({ status: "succeeded" });
      const hostDir = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!)))[0].cwd!;
      await s.say("Please rewrite the report.");
      const held = Promise.race([s.stallReached.then(() => "held" as const), sleep(60_000).then(() => "R never reached its publication" as const)]);
      for (let waited = 0; waited < 60_000 && !(await Promise.race([held, sleep(250).then(() => null)])); waited += 250) await heartbeat.resumeQueuedRuns();
      expect(await held).toBe("held");
      const [, r] = await s.runs();
      expect(r).toMatchObject({ status: "running", runtimeMode: "native" });
      const rReference = readNativeWorkspaceSyncReference(record(r.runnerProfileJson).nativeWorkspaceSync)!;
      expect(rReference).toMatchObject({ state: "prepared" });
      // The hold is PAST the copy-back: R's apply already landed in R's root (the host write is done), nothing is published.
      expect(await listing(hostDir)).toMatchObject({ "notes.md": "R's new notes (unsaved)\n" });
      expect(record(r.runnerProfileJson).nativeWorkspaceFinalizationOwner).toMatchObject({ token: expect.any(String) });
      seen.push(...(await s.inspectorSaves(r.id)).map(save => save.status));
      expect(seen).toEqual(["running"]);
      // REAL: the person's next message parks; the bound's sweep fences R at the cap.
      const next = await s.say("Also add a summary section to the report.");
      const parked = async () => (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, s.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(wake => JSON.stringify(wake.payload).includes(next));
      await vi.waitFor(async () => expect(await parked()).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const parkedAt = (await parked())[0].requestedAt.getTime();
      while ((await s.runs())[1].status === "running" && Date.now() - parkedAt < CAP + 15_000) { await sweep(r.id); await sleep(200); }
      const [, rEnded] = await s.runs();
      expect(rEnded).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(record(record(rEnded.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      // REAL: P starts beside R's held publication.
      const startAt = Date.now();
      while (Date.now() - startAt < 30_000 && box.inputs.length < 3) { await heartbeat.resumeQueuedRuns(); await sleep(250); }
      const [, , p] = await s.runs();
      expect(p, "P never started beside R's held publication").toBeTruthy();
      expect(box.inputs).toHaveLength(3);
      const [pWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, (await s.issue()).executionWorkspaceId!));
      const pRoot = pWorkspace.cwd!;
      expect(pRoot).not.toBe(hostDir);
      expect(await listing(pRoot)).toEqual(SAVED);
      const pRootBefore = await treeSha256(pRoot);
      seen.push(...(await s.inspectorSaves(r.id)).map(save => save.status));

      // The publication is released AFTER the fence.
      s.releaseStall();
      const polling = (async () => { for (let i = 0; i < 20; i++) { seen.push(...(await s.inspectorSaves(r.id)).map(save => save.status)); await sleep(100); } })();
      await heartbeat.drainActiveRunExecutions();
      await polling;
      await sweep(r.id);
      const presentation = nativeResponsePresentationWork(db);
      for (const entry of await presentation.load({ companyId: s.companyId, issueId: s.issueId })) await presentation.check(entry);
      const [, rLate] = await s.runs();
      const [rLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, rReference.leaseId));
      const saves = await s.inspectorSaves(r.id);
      evidence.FUc = { route: "GET /api/heartbeat-runs/:runId/workspace-operations", R: { id: r.id, status: rLate.status, errorCode: rLate.errorCode,
        reference: readNativeWorkspaceSyncReference(record(rLate.runnerProfileJson).nativeWorkspaceSync)?.state,
        leaseStamp: record(rLease.metadata).nativeWorkspaceSync ?? null, saves, seen: [...new Set(seen)] },
        P: { id: p.id, root: pRoot, sha256Before: pRootBefore, sha256After: await treeSha256(pRoot) } };
      // R's reference is not finalized;
      expect(readNativeWorkspaceSyncReference(record(rLate.runnerProfileJson).nativeWorkspaceSync)).toMatchObject({ state: "prepared" });
      // the lease is not stamped R;
      expect(record(record(rLease.metadata).nativeWorkspaceSync).finalizedRunId).not.toBe(r.id);
      // the inspector never shows R's save Succeeded: it ends failed, superseded by the fence (ownership lost);
      expect([...new Set(seen)]).not.toContain("succeeded");
      expect(saves.map(save => save.status)).toEqual(["failed"]);
      // R stays as the bound ended it, the tombstone stays, one LOST line;
      expect(rLate).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(record(record(rLate.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      expect(await s.servedLine(r.id)).toMatchObject({ status: "failed", state: "lost", shown: THE_LINE });
      // P's files are unchanged, and the task still names P's root.
      expect(await treeSha256(pRoot)).toBe(pRootBefore);
      expect(await listing(pRoot)).toEqual(SAVED);
      expect((await s.issue()).executionWorkspaceId).toBe(pWorkspace.id);
      expect(errors).toEqual([]);
    } finally {
      s.releaseStall(); receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions();
    }
  }, 240_000);
});
