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
import { errorHandler } from "../../middleware/index.js";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { nativeCleanupAdmissionBlock } from "./native-cleanup-admission-hold.js";
import { nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";
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
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-classic-bound-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "classic-bound-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "classic@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.useRealTimers(); box.inputs.length = 0; box.session = null; box.nextBox = null; });
  afterAll(async () => {
    if (process.env.CLASSIC_BOUND_EVIDENCE) await fs.writeFile(process.env.CLASSIC_BOUND_EVIDENCE, JSON.stringify(evidence, null, 2));
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const ANSWER = "Done. I rewrote the report and added the notes file.";
  const SAVED = { "report.md": "report, saved v1\n", "data/keep.txt": "kept since the first turn\n" };

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
      expect(await s.issue()).toMatchObject({ executionRunId: null, executionWorkspaceId: null, status: "blocked" });

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
    app.use("/api", activityRoutes(db)); app.use(errorHandler);
    // Every box is a local directory. Only R's box carries the fault, armed after R accepted.
    const fault = { stall: null as null | { entered: () => void; release: Promise<void> } };
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
    return { companyId, agentId, issueId, app, boxes, runs, issue, say, agentComments, servedLine, faultedBox,
      stallReached, releaseStall: () => { release(); fault.stall = null; } };
  }

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
      // REAL: the bound's own sweep, beside the live executor that still holds the copy-back's lock.
      const ended = async () => (await s.runs())[1].status !== "running";
      while (!(await ended()) && Date.now() - parkedAt < CAP + 15_000) { await sweep(r.id); await sleep(200); }
      const endedAfterParkingMs = Date.now() - parkedAt;
      const [, rEnded] = await s.runs();
      expect(rEnded).toMatchObject({ status: "failed", errorCode: STALLED });
      expect(endedAfterParkingMs).toBeGreaterThanOrEqual(CAP);
      expect(record(record(rEnded.runnerProfileJson).nativeWorkspaceFinalizationOwner)).toMatchObject({ fenced: true });
      expect(JSON.stringify(rEnded.resultJson)).not.toMatch(/"token"|processGroupId|controllerBootId|processStartedAt/);
      // C12: R's accepted `done` is DROPPED, never applied: the person sees the task Blocked, not Done.
      expect(await s.issue()).toMatchObject({ status: "blocked", executionRunId: null, executionWorkspaceId: null });

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
});
