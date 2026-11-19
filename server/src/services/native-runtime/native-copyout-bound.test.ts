import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
  workspaceOperations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// The copy-out no-progress bound (Ruling P, smarty-dev#21235).
//
// REAL in every row (the route or producer is named at its call):
//   the person's messages ....... POST /api/issues/:id/comments (routes/issues.ts)
//   the workspace and its box ... reserveRemoteWorkspace + prepareRemoteWorkspace; the "sandbox" is a local
//                                 directory and every sandbox command really runs (node, the archive helper)
//   acceptance .................. NativeRunCoordinatorStore.completeRun
//   every copy-out attempt ...... nativeWorkspaceFinalizationWork(...).load + .check (the worker's own functions)
//                                 -> attemptNativeWorkspaceFinalization -> saveRemoteWorkspace
//   the bound ................... the same .check; then recordNativeWorkspaceFinalizationFailure
//                                 -> recordNativeFinalizationFailure (the finalizer's one terminal write)
//   the lock + owner receipt .... withNativeWorkspaceFinalizationOwnership
//   R's withheld reply .......... the reply-presentation worker (load + check)
//   the parked message's start .. heartbeat.registerDeferredReceiptWork + resumeQueuedRuns (real admission)
// NAMED INJECTIONS:
//   COPYOUT-STALL-1 ............. the box's sandbox commands block for one armed run until the test releases
//                                 them (the seam the DF1 disk-full hook wraps, remote-workspaces.ts capture target)
//   COPYOUT-SLOW-1 .............. the same seam, delaying each command of one armed run by a fixed time
//   COPYOUT-TIMEOUT-1 ........... the same seam: each command of one armed run reports that it timed out
// PLANTED (named): the native run row R, its lease and its claim of M's wake (the executor that creates them
//   needs a live provider);
//   row 4b's foreign-host owner receipt (its producer is a controller that died mid-copy on another host).
const box = vi.hoisted(() => ({ targets: new Map<string, unknown>(), storage: null as unknown, inputs: [] as unknown[],
  nextBox: null as null | ((leaseId: string) => Promise<unknown>) }));
vi.mock("../environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async (input: { leaseId?: string | null }) =>
    box.targets.get(String(input.leaseId)) ?? await box.nextBox?.(String(input.leaseId))
      ?? actual.resolveEnvironmentExecutionTarget(input as never)) as unknown as typeof actual.resolveEnvironmentExecutionTarget };
});
vi.mock("../../storage/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../storage/index.js")>();
  return { ...actual, getStorageService: () => box.storage ?? actual.getStorageService() };
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
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "next turn answered" };
  }) as typeof actual.executePaperclipNativeSession };
});
import { heartbeatService } from "../heartbeat.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { createStorageService } from "../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace } from "../remote-workspaces.js";
import { abandonedWorkspaceFilesHeldOnLease } from "../remote-workspace-abandoned-files-hold.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { nativeWorkspaceFinalizationWork } from "./native-workspace-finalization-work.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { FILE_LINE_KEPT_NO_BUTTON, readReplyFileLine, replyFileLineText } from "@paperclipai/shared";

// At the base commit these names do not exist; the drafts stand in and every row is red on behaviour.
const workModule = "./native-workspace-finalization-work.js";
const bound: { COPYOUT_NO_ATTEMPT_BOUND_MS?: number; COPYOUT_ATTEMPT_TIMEOUT_MS?: number; PERSON_WAIT_CAP_MS?: number } = await import(/* @vite-ignore */ workModule);
const admissionModule = "../heartbeat/predecessor-admission.js";
const admission: { PREVIOUS_TURN_FILES_SET_ASIDE_NOTICE?: string; readPreviousTurnWorkspaceNotice?: (context: unknown) => string | null;
  fenceUnverifiedPredecessorsAtAdmission: (db: Db, run: typeof heartbeatRuns.$inferSelect) => Promise<typeof heartbeatRuns.$inferSelect> }
  = await import(/* @vite-ignore */ admissionModule);
// Cut 2a: the kept line without a Recover button (the board does not read a set-aside epoch) is the shared renderer's.
const FILE_LINE_KEPT_SET_ASIDE = FILE_LINE_KEPT_NO_BUTTON;
const renderedFileLine = (resultJson: unknown) => replyFileLineText(
  readReplyFileLine(record(record(resultJson).presentationDecision).fileLine), { nowMs: Date.now(), recoverSavedFilesShown: false });
const STALLED = "native_workspace_sync_out_stalled";
const PERSON = "copyout-bound-person";
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const record = (value: unknown) => (value && typeof value === "object" ? value : {}) as Record<string, any>;
const evidence: Record<string, unknown> = {};

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("copy-out no-progress bound: the run ends with its files kept", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-copyout-bound-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "copyout-bound-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
    box.storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))), provider: "s3" as const };
    await db.insert(authUsers).values({ id: PERSON, name: "Person", email: "copyout@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => {
    if (process.env.COPYOUT_BOUND_EVIDENCE) await fs.writeFile(process.env.COPYOUT_BOUND_EVIDENCE, JSON.stringify(evidence, null, 2));
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const ANSWER = "Done. I added the notes file.";

  async function scenario() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Copy-out bound", issuePrefix: `B${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: PERSON, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: PERSON, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Add the notes file", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, responsibleUserId: PERSON, issueNumber: 1, identifier: `B${companyId.slice(0, 6)}-1` });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, {} as never)); app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);

    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Add the notes file", criteria: [] },
      canonicalSha256: `copyout-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    // PLANTED: the native run that carries M, already executing in its box.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", responsibleUserId: PERSON, startedAt: new Date(),
      contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented" } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    // REAL: the person's message M.
    const sent = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Please add the notes file.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const messageId: string = sent.body.id;

    // (R is planted before M is sent, so M's wake is deterministically saved behind it and never races the
    // planting as a queued wake; R then carries M.)
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented",
      wakeCommentId: messageId, commentId: messageId } }).where(eq(heartbeatRuns.id, runId));
    const [environment] = await db.insert(environments).values({ name: `Box ${runId}`, driver: "sandbox", status: "active",
      config: { provider: "fake", image: "fixture:test", reuseLease: true } }).returning();
    await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, agentId));
    const [leaseRow] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: `sandbox-${randomUUID()}`, status: "active", leasePolicy: "ephemeral" }).returning();

    // The box: a local directory; every sandbox command really runs.
    const remoteCwd = path.join(root, runId, "remote");
    await fs.mkdir(remoteCwd, { recursive: true });
    const fault = { stall: null as null | { entered: () => void; release: Promise<void> }, slowMs: 0, timeOut: false, commands: 0 };
    const transfer: NonNullable<NonNullable<AdapterSandboxExecutionTarget["runner"]>["syncIn"]> = async operations => {
      for (const operation of operations) for (const file of operation.files) {
        await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
        await fs.cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId,
        filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    };
    const boxTarget = (leaseId: string, cwd: string, faulted: boolean): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox", leaseId, remoteCwd: cwd, timeoutMs: 30_000,
      runner: { syncIn: transfer, syncOut: transfer, execute: async input => {
        if (faulted) {
          fault.commands += 1;
          // COPYOUT-STALL-1 / COPYOUT-SLOW-1.
          if (fault.stall) { fault.stall.entered(); await fault.stall.release; }
          if (fault.slowMs) await sleep(fault.slowMs);
          // COPYOUT-TIMEOUT-1.
          if (fault.timeOut) return { exitCode: null, stdout: "", stderr: "", signal: "SIGTERM", timedOut: true,
            pid: process.pid, startedAt: new Date().toISOString() };
        }
        const result = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? cwd,
          env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, signal: null, timedOut: false,
          pid: process.pid, startedAt: new Date().toISOString() };
      } },
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
    const storage = box.storage as never;
    // REAL: the task's workspace, prepared in the box for R.
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" } });
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId, lease: leaseRow as EnvironmentLease, target });
    await db.update(environmentLeases).set({ executionWorkspaceId: reserved.id }).where(eq(environmentLeases.id, leaseRow.id));
    await db.update(issues).set({ executionRunId: runId, executionWorkspaceId: reserved.id, status: "in_progress" }).where(eq(issues.id, issueId));
    // PLANTED with R: M's wake is the one R was started from (the real claim sets both), so M is not a
    // message parked behind R. Left alone, the planted R leaves M's own wake parked behind it.
    const ownWake = and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`);
    await vi.waitFor(async () => expect(await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(ownWake))
      .toEqual([{ status: "deferred_issue_execution" }]), { timeout: 10_000, interval: 25 });
    const [carried] = await db.update(agentWakeupRequests).set({ status: "claimed", runId, claimedAt: new Date(), updatedAt: new Date() })
      .where(ownWake).returning({ id: agentWakeupRequests.id });
    await db.update(heartbeatRuns).set({ wakeupRequestId: carried.id }).where(eq(heartbeatRuns.id, runId));
    // R's edit, in the box only.
    const editPath = path.join(prepared.remoteRoot, "notes.md");
    await fs.writeFile(editPath, "R's unsaved edit\n");

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
        summary: "Added the notes file.", completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
        terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
        turnId: "answer-turn" });
    }
    const settled: unknown[] = [];
    /** REAL: the copy-out worker's own discovery and check. */
    function worker(copyOutBound?: { noAttemptMs?: number; attemptTimeoutMs?: number; personWaitCapMs?: number; now?: () => number }, handle: Db = db) {
      const options = { environmentRuntime: {} as never, onWorkspaceSettled: async (input: unknown) => { settled.push(input); },
        ...(copyOutBound ? { copyOutBound } : {}) };
      const work = nativeWorkspaceFinalizationWork(handle, options as never);
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
    const workspace = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, reserved.id)))[0];
    const authority = async () => readRemoteWorkspaceAuthority((await workspace()).metadata)!;
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseRow.id)))[0];
    const attempts = async () => (await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize")))).map(operation => operation.status);
    const committedSnapshots = async () => (await db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id), eq(executionWorkspaceSnapshots.status, "committed")))).map(row => row.id).sort();
    const recovery = async () => db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.cause, STALLED)));
    async function presentationWorker() {
      const work = nativeResponsePresentationWork(db);
      for (const entry of await work.load({ companyId, issueId })) await work.check(entry);
    }
    async function replies() {
      const got = await request(app).get(`/api/issues/${issueId}/comments`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      return (got.body as Array<{ id: string; body: string; authorType: string; createdByRunId: string | null }>).filter(comment => comment.authorType === "agent");
    }
    function armStall() {
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      fault.stall = { entered, release: new Promise<void>(resolve => { release = resolve; }) };
      return { reached, release: () => { release(); fault.stall = null; } };
    }
    /** The state every fired bound must leave. */
    async function expectEndedWithFilesKept(before: { epoch: number; snapshotId: string | null; committed: string[] }) {
      expect(await coordinator()).toMatchObject({ phase: "terminal_failure", failureCode: STALLED,
        failureDetail: { originalFailureCode: STALLED, recoveryOwner: { kind: "board" } }, nextAttemptAt: null });
      const ended = await run();
      expect(ended).toMatchObject({ status: "failed", errorCode: STALLED, finishedAt: expect.any(Date),
        resultJson: { originalFailureCode: STALLED, workspaceSyncOutStall: { workspace: { abandonedEpoch: before.epoch, epoch: before.epoch + 1,
          quarantine: { state: "retained_unapplied" } } } } });
      expect(ended.error).toContain("made no progress");
      // The fence: the epoch moved, nothing of R's was applied, and the box root is held for 7 days.
      expect(await authority()).toMatchObject({ epoch: before.epoch + 1, writerRunId: null, dirty: false, location: null, snapshotId: before.snapshotId });
      expect(await committedSnapshots()).toEqual(before.committed);
      const receipts = record((await workspace()).metadata).remoteWorkspaceAbandonedEpochs as Array<Record<string, any>>;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ runId, epoch: before.epoch });
      expect(receipts[0].released ?? null).toBeNull();
      expect(Math.abs(Date.parse(receipts[0].retainUntil) - Date.parse(receipts[0].abandonedAt) - 7 * 86_400_000)).toBeLessThan(1_000);
      expect(await abandonedWorkspaceFilesHeldOnLease(db, await lease())).toBe(true);
      expect(await fs.readFile(editPath, "utf8")).toBe("R's unsaved edit\n");
      // The board's recovery action of the kept-files class.
      const actions = await recovery();
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ status: "active", ownerType: "board", evidence: { runId, originalFailureCode: STALLED } });
      expect(settled).toEqual([{ runId, companyId, agentId, succeeded: false }]);
      return { action: actions[0], receipt: receipts[0] };
    }
    const snapshotBefore = async () => { const current = await authority();
      return { epoch: current.epoch, snapshotId: current.snapshotId, committed: await committedSnapshots() }; };
    return { app, companyId, agentId, issueId, runId, messageId, leaseId: leaseRow.id, target, fault, editPath, remoteRoot: prepared.remoteRoot,
      streamAndAccept, worker, coordinator, run, issue, workspace, authority, lease, attempts, committedSnapshots, recovery,
      presentationWorker, replies, armStall, expectEndedWithFilesKept, snapshotBefore, settled, storage, nextBoxes };
  }

  it("row 1 + row 3 (COPYOUT-STALL-1): a capture that never returns -> the bound ends the run with its files kept; the late save is refused", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    expect((await s.authority()).writerRunId).toBe(s.runId);
    const stall = s.armStall();
    const startedAt = Date.now();
    // One real check: its attempt never returns. The bound is shortened for the test (attempt 600 ms + no-attempt 300 ms).
    const checking = s.worker({ attemptTimeoutMs: 600, noAttemptMs: 300 }).check();
    await stall.reached;
    expect(await s.attempts()).toEqual(["running"]);
    expect((await s.run()).status).toBe("running");
    const checked = await checking;
    const firedAfterMs = Date.now() - startedAt;
    expect(checked).toEqual({ entries: 1, results: [null] });
    expect(firedAfterMs).toBeGreaterThanOrEqual(900);
    // The owner of the hung attempt is still recorded: the terminal write passed that guard, with the fence.
    expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toBeTruthy();
    const kept = await s.expectEndedWithFilesKept(before);
    // R's accepted answer reaches the person once, with the KEPT line.
    await s.presentationWorker();
    const [reply, ...more] = await s.replies();
    expect(more).toEqual([]);
    // Cut 2a: the body is the answer alone; the line is rendered from the state on the presentation decision.
    expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
    expect((await s.run()).resultJson).toMatchObject({ nativeWithheldReply: { state: "published", fileLine: "kept" } });
    expect(renderedFileLine((await s.run()).resultJson)).toBe(FILE_LINE_KEPT_SET_ASIDE);

    // Row 3: the capture returns after the bound. Its save is refused at publication and changes nothing.
    stall.release();
    await vi.waitFor(async () => expect(await s.attempts()).toEqual(["failed"]), { timeout: 30_000, interval: 50 });
    const [snapshotOperation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"))).orderBy(desc(workspaceOperations.startedAt)); // cut 2a also records the initial save: read the final one
    expect(snapshotOperation).toMatchObject({ status: "failed" });
    expect(JSON.stringify(snapshotOperation.metadata)).toContain("remote_workspace_publication_fenced");
    await vi.waitFor(async () => expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toBeUndefined(),
      { timeout: 10_000, interval: 50 });
    // A direct late save by the same run is refused before any capture.
    await expect(saveRemoteWorkspace({ db, storage: s.storage, workspace: await s.workspace(), runId: s.runId,
      lease: await s.lease() as EnvironmentLease, target: s.target, assertOwned: async () => undefined })).rejects.toThrow(/remote_workspace_(save_binding_mismatch|authority_changed)/);
    s.settled.length = 1;
    const after = await s.expectEndedWithFilesKept(before);
    expect(after.action).toMatchObject({ id: kept.action.id, status: "active", nextAction: kept.action.nextAction });
    expect(after.receipt).toEqual(kept.receipt);
    expect(await s.replies()).toHaveLength(1);
    // A later sweep finds nothing to do.
    expect(await s.worker().check()).toEqual({ entries: 0, results: [] });
    // Recorded, not asserted (see result.md): what the board's "Recover saved files" request answers for this cause today.
    const inspected = await request(s.app).get(`/api/issues/${s.issueId}/recovery-actions`)
      .query({ inspectSourceRunId: s.runId, inspectSourceActionId: after.action.id });
    const recover = await request(s.app).post(`/api/issues/${s.issueId}/recovery-actions/recover-workspace`)
      .send({ actionId: after.action.id, runId: s.runId, idempotencyKey: randomUUID() });
    evidence.recoverSavedFiles = { inspect: { status: inspected.status, active: inspected.body?.active?.cause, source: inspected.body?.sourceInspection },
      recover: { status: recover.status, body: recover.body } };
    evidence.row1 = { firedAfterMs, run: await s.run(), coordinator: await s.coordinator(), action: after.action, receipt: after.receipt,
      lateSave: snapshotOperation.metadata, reply: reply.body };
  }, 120_000);

  it("row 1, the next turn: issues.executionRunId is cleared, the parked message starts on the saved files and its input names the set-aside turn", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    // Record the statement that clears issues.executionRunId for R.
    await db.execute(sql.raw(`create table if not exists copyout_bound_clear (issue_id uuid, statement text);
      create or replace function copyout_bound_clear_fn() returns trigger language plpgsql as $$
        begin insert into copyout_bound_clear values (new.id, current_query()); return new; end $$;
      drop trigger if exists copyout_bound_clear_t on issues;
      create trigger copyout_bound_clear_t after update on issues for each row
        when (old.execution_run_id is not null and new.execution_run_id is null) execute function copyout_bound_clear_fn()`));
    const stall = s.armStall();
    const checking = s.worker({ attemptTimeoutMs: 600, noAttemptMs: 300 }).check();
    await stall.reached;
    // REAL: the person's next message arrives while R is still saving its files. It is parked.
    const next = await request(s.app).post(`/api/issues/${s.issueId}/comments`).send({ body: "Also list the open questions.", clientRequestId: randomUUID() });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const wakes = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => JSON.stringify(wake.payload).includes(next.body.id));
    await vi.waitFor(async () => expect((await wakes()).map(wake => wake.status)).toContain("deferred_issue_execution"), { timeout: 10_000, interval: 50 });
    expect((await s.issue()).executionRunId).toBe(s.runId);
    expect(await checking).toEqual({ entries: 1, results: [null] });
    await s.expectEndedWithFilesKept(before);
    await s.presentationWorker();
    expect(await s.replies()).toHaveLength(1);

    // The exact line that clears it: the terminal write blocks the task through issueService.update
    // (native-run-finalizer.ts), whose status side effect clears the execution lock (issues.ts update:
    // `if (issueData.status && issueData.status !== "in_progress") { ... patch.executionRunId = null`).
    expect(await s.issue()).toMatchObject({ executionRunId: null, checkoutRunId: null, status: "blocked" });
    const cleared = [...await db.execute<{ statement: string }>(sql`select statement from copyout_bound_clear where issue_id = ${s.issueId}`)];
    expect(cleared).toHaveLength(1);
    expect(cleared[0].statement).toMatch(/^update "issues" set .*"status" = \$\d+, "checkout_run_id" = \$\d+, "execution_run_id" = \$\d+, "execution_agent_name_key" = \$\d+, "execution_locked_at" = \$\d+.* where "issues"\."id" = \$\d+/);

    await parkedMessageStarts(s, next.body.id, before, { cleared });
    stall.release();
  }, 280_000);

  type Scenario = Awaited<ReturnType<typeof scenario>>;
  /** The parked message `nextId` starts once R ended: the product's own release, admission and input. */
  async function parkedMessageStarts(s: Scenario, nextId: string, before: Awaited<ReturnType<Scenario["snapshotBefore"]>>,
    recorded: Record<string, unknown>, evidenceKey = "nextTurn") {
    const next = { body: { id: nextId } };
    const wakes = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => JSON.stringify(wake.payload).includes(nextId));
    // REAL: the deferred-receipt worker and queued-run admission of a running server.
    const errors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const receipts = heartbeat.registerDeferredReceiptWork(delivery, () => true);
    const successors = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, s.companyId),
      sql`${heartbeatRuns.id} <> ${s.runId}`))).filter(run => JSON.stringify(run.contextSnapshot).includes(next.body.id));
    const boundAt = Date.now();
    let startedAfterMs = -1;
    try {
      await receipts.ready;
      do {
        await heartbeat.resumeQueuedRuns();
        const [started] = await successors();
        if (started && startedAfterMs < 0) startedAfterMs = Date.now() - boundAt;
        // Far enough: the next run prepared its workspace. Its provider turn needs a live sandbox bridge.
        if (record(started?.runnerProfileJson).remoteWorkspace || box.inputs.length) break;
        await sleep(250);
      } while (Date.now() - boundAt < 90_000);
    } finally { receipts.stop?.(); await delivery.stop(); await heartbeat.drainActiveRunExecutions(); }
    const [successor] = (await successors()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    evidence[evidenceKey] = { ...recorded, startedAfterMs, wakes: await wakes(), successor, providerTurnsReached: box.inputs.length, errors: errors.map(String) };
    expect(successor).toBeTruthy();
    // The parked message became this run, by the product's own promotion.
    const promoted = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.agentId)))
      .filter(wake => wake.reason === "issue_execution_promoted");
    expect(promoted).toHaveLength(1);
    expect((await successors()).map(run => run.id)).toContain(promoted[0].runId);
    expect((await wakes()).map(wake => wake.status)).not.toContain("deferred_issue_execution");
    expect(JSON.stringify(successor.contextSnapshot)).toContain(next.body.id);
    // REAL admission (fenceUnverifiedPredecessorsAtAdmission): its input context names the set-aside turn, once.
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: s.runId,
      previousTurnWorkspaceNotice: { runId: s.runId, text: admission.PREVIOUS_TURN_FILES_SET_ASIDE_NOTICE } });
    // A retry of that run is told too: the notice stands until a next run succeeds.
    const admitted = (await successors()).filter(run => record(run.runnerProfileJson).remoteWorkspace);
    for (const later of admitted) expect(admission.readPreviousTurnWorkspaceNotice!(later.contextSnapshot))
      .toBe(admission.PREVIOUS_TURN_FILES_SET_ASIDE_NOTICE);
    expect(record(record((await s.run()).resultJson).workspaceSyncOutStall).noticeRunId).toEqual(expect.any(String));
    expect(record((await s.run()).resultJson).freshContinuationSupersededAt).toBeUndefined();
    // It starts on the saved files: a new epoch restored from the last saved version, in another box, without R's edit.
    const reference = record(successor.runnerProfileJson).remoteWorkspace;
    expect(reference).toMatchObject({ state: "prepared", epoch: before.epoch + 2, snapshotId: before.snapshotId });
    expect(reference.remoteCwd.startsWith(s.remoteRoot)).toBe(false);
    expect(s.nextBoxes.some(dir => reference.remoteCwd.startsWith(dir))).toBe(true);
    await expect(fs.access(path.join(reference.remoteCwd, "notes.md"))).rejects.toThrow();
    expect(await fs.readFile(s.editPath, "utf8")).toBe("R's unsaved edit\n");
    // The model input built from that context (the notice reader runtime-selection.ts uses, then the
    // product's input and envelope builders) carries the notice once, on a fresh and on a resumed session.
    const notice = admission.readPreviousTurnWorkspaceNotice!(successor.contextSnapshot);
    expect(notice).toBe(admission.PREVIOUS_TURN_FILES_SET_ASIDE_NOTICE);
    const { buildNativeExecutionInput } = await import("./native-execution-input.js");
    const { buildNativeModelEnvelope } = await import("../../vendor/paperclip-runner/index.js");
    const { nativeRuntimeContextFixture } = await import("./runtime-context.test-fixture.js");
    const input = buildNativeExecutionInput({ companyId: s.companyId, agentId: s.agentId, runId: successor.id,
      issue: { id: s.issueId, identifier: null, title: "Add the notes file", description: null, workMode: "standard" },
      taskPrompt: "Also list the open questions.", agentFileConflictNotice: notice,
      workspace: { id: successor.id, cwd: reference.remoteCwd, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: randomUUID(), resumedSession: true,
      previousTurn: { runId: s.runId, task: { title: "Add the notes file", description: null } },
      provider: "codex", completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "answer", requirement: "Answer" }] } },
      runtimeContext: nativeRuntimeContextFixture() });
    for (const envelope of [buildNativeModelEnvelope(input), buildNativeModelEnvelope(input, { resumedSession: true })]) {
      expect(JSON.stringify(envelope).split("file changes were not saved")).toHaveLength(2);
    }
    // R's own reply stays the one reply; nothing was posted in its name by the next turn.
    expect((await s.replies()).filter(reply => reply.createdByRunId === s.runId)).toHaveLength(1);
    evidence[evidenceKey] = { ...record(evidence[evidenceKey]), reference, notice, admittedNextRuns: admitted.length, recoveryActions: await s.recovery(), issue: await s.issue() };
  }

  it("row (a), the person-wait cap: a person's message parked behind a hung first attempt of a LIVE owner -> the run ends at the cap, not at the attempt's 40 min; the message starts with the notice in its input", async () => {
    expect(bound.PERSON_WAIT_CAP_MS).toBe(300_000);
    expect(bound.COPYOUT_ATTEMPT_TIMEOUT_MS).toBe(40 * 60_000);
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    const stall = s.armStall();
    // The production attempt timeout (40 min) and no-attempt bound (60 s). Only the cap is shortened: 5 min -> 2 s.
    const CAP = 2_000;
    const checking = s.worker({ personWaitCapMs: CAP }).check();
    try {
      await stall.reached;
      // Nobody is parked yet: longer than the cap passes and the live attempt is not cut.
      await sleep(CAP + 1_000);
      expect(await s.attempts()).toEqual(["running"]);
      expect((await s.run()).status).toBe("running");
      // REAL: the person's next message arrives while R is still saving its files. It is parked.
      const next = await request(s.app).post(`/api/issues/${s.issueId}/comments`).send({ body: "Also list the open questions.", clientRequestId: randomUUID() });
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      const parked = async () => (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, s.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(wake => JSON.stringify(wake.payload).includes(next.body.id));
      await vi.waitFor(async () => expect(await parked()).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const [wake] = await parked();
      expect(wake).toMatchObject({ requestedByActorType: "user", requestedByActorId: PERSON, runId: null });
      expect((await s.issue()).executionRunId).toBe(s.runId);
      // R ends by the cap, counted from the parking (later than the acceptance here).
      const checked = await Promise.race([checking, sleep(CAP + 20_000).then(() => "not ended by the cap" as const)]);
      const endedAfterParkingMs = Date.now() - wake.requestedAt.getTime();
      expect(checked).toEqual({ entries: 1, results: [null] });
      expect(endedAfterParkingMs).toBeGreaterThanOrEqual(CAP);
      expect(endedAfterParkingMs).toBeLessThan(CAP + 20_000);
      // The owner of the hung attempt is live and still recorded; its attempt is still running.
      expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toBeTruthy();
      expect(await s.attempts()).toEqual(["running"]);
      // It ended exactly as the no-attempt bound ends it: the same cause, the files kept, the epoch moved.
      const kept = await s.expectEndedWithFilesKept(before);
      await s.presentationWorker();
      const [reply, ...more] = await s.replies();
      expect(more).toEqual([]);
      expect(reply).toMatchObject({ body: ANSWER, createdByRunId: s.runId });
      expect(renderedFileLine((await s.run()).resultJson)).toBe(FILE_LINE_KEPT_SET_ASIDE);
      expect(await s.issue()).toMatchObject({ executionRunId: null, status: "blocked" });
      // The parked message starts through the real deferred-receipt release, with the notice in its input.
      await parkedMessageStarts(s, next.body.id, before, { capMs: CAP, endedAfterParkingMs, parkedAt: wake.requestedAt }, "personWaitCap");
      // The hung capture returns after the cap: its save is refused and nothing changes.
      stall.release();
      await vi.waitFor(async () => expect(await s.attempts()).toEqual(["failed"]), { timeout: 30_000, interval: 50 });
      const [snapshotOperation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
        eq(workspaceOperations.phase, "remote_workspace_snapshot"))).orderBy(desc(workspaceOperations.startedAt)); // cut 2a also records the initial save: read the final one
      expect(JSON.stringify(snapshotOperation.metadata)).toContain("remote_workspace_publication_fenced");
      expect(await s.committedSnapshots()).toEqual(before.committed);
      expect((await s.recovery()).map(action => action.id)).toEqual([kept.action.id]);
      expect((await s.replies()).filter(agentReply => agentReply.createdByRunId === s.runId)).toHaveLength(1);
    } finally { stall.release(); await checking.catch(() => undefined); }
  }, 280_000);

  it("row (cap), control: nobody parked + a hung attempt -> not cut at the cap; it keeps its own timeout and then the no-attempt bound", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    const stall = s.armStall();
    const startedAt = Date.now();
    // The cap (400 ms) is far shorter than the attempt's own timeout (4 s) + the no-attempt bound (500 ms).
    const checking = s.worker({ personWaitCapMs: 400, attemptTimeoutMs: 4_000, noAttemptMs: 500 }).check();
    try {
      await stall.reached;
      await sleep(2_500);
      // Six caps later the run is untouched.
      expect(await s.attempts()).toEqual(["running"]);
      expect((await s.run()).status).toBe("running");
      expect(await s.coordinator()).toMatchObject({ failureCode: null });
      expect(await checking).toEqual({ entries: 1, results: [null] });
      const firedAfterMs = Date.now() - startedAt;
      expect(firedAfterMs).toBeGreaterThanOrEqual(4_500);
      await s.expectEndedWithFilesKept(before);
      evidence.capControl = { capMs: 400, attemptTimeoutMs: 4_000, noAttemptMs: 500, firedAfterMs };
    } finally { stall.release(); await checking.catch(() => undefined); }
  }, 120_000);

  it("row x1 (COPYOUT-TIMEOUT-1): a parked person's message + a first attempt that times out -> the run ends at that attempt; with nobody parked it is retried", async () => {
    // Control: nobody parked. The timed-out attempt is retried as today.
    const control = await scenario();
    await control.streamAndAccept();
    control.fault.timeOut = true;
    const retried = await control.worker().check();
    expect(await control.attempts()).toEqual(["failed"]);
    expect(retried.results[0]).toMatchObject({ id: control.runId });
    expect(await control.coordinator()).toMatchObject({ failureCode: "native_workspace_sync_out_failed", nextAttemptAt: expect.any(Date) });
    expect((await control.coordinator()).phase).not.toBe("terminal_failure");
    expect((await control.run()).status).toBe("running");

    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    // REAL: the person's next message is parked behind R.
    const next = await request(s.app).post(`/api/issues/${s.issueId}/comments`).send({ body: "Also list the open questions.", clientRequestId: randomUUID() });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    await vi.waitFor(async () => expect((await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, s.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(wake => JSON.stringify(wake.payload).includes(next.body.id)))
      .toHaveLength(1), { timeout: 10_000, interval: 50 });
    s.fault.timeOut = true;
    // The production constants: the cap is 5 min away; the first timed-out attempt ends R.
    expect(await s.worker().check()).toEqual({ entries: 1, results: [null] });
    expect(await s.attempts()).toEqual(["failed"]);
    const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, s.runId),
      eq(workspaceOperations.phase, "workspace_finalize")));
    expect(JSON.stringify(operation.metadata)).toContain("remote_workspace_operation_timed_out");
    await s.expectEndedWithFilesKept(before);
    expect(await s.worker().check()).toEqual({ entries: 0, results: [] });
    evidence.x1 = { attempts: await s.attempts(), cause: record(record(operation.metadata).workspaceSync).cause, coordinator: await s.coordinator() };
  }, 120_000);

  it("row 2 (COPYOUT-SLOW-1): a copy slower than the no-attempt bound, inside its attempt timeout, is not cut and commits its files", async () => {
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    s.fault.slowMs = 700;
    // Each sandbox command takes longer than the whole no-attempt bound (300 ms); the attempt timeout is 60 s.
    const checking = s.worker({ attemptTimeoutMs: 60_000, noAttemptMs: 300 }).check();
    // While it runs, another sweep of the same run (as from a second controller) waits and does not fire,
    // even with its clock 20 minutes on and the production constants.
    await vi.waitFor(async () => expect(await s.attempts()).toEqual(["running"]), { timeout: 10_000, interval: 25 });
    const peer = createDb(database.connectionString);
    try {
      const waited = await s.worker({ now: () => Date.now() + 20 * 60_000 }, peer).check();
      expect(waited.entries).toBe(1);
      expect(waited.results[0]).toMatchObject({ id: s.runId });
      expect((await s.run()).status).toBe("running");
    } finally { await peer.$client.end({ timeout: 1 }); }
    const checked = await checking;
    expect(s.fault.commands).toBeGreaterThanOrEqual(2);
    expect(checked.entries).toBe(1);
    expect(await s.attempts()).toEqual(["succeeded"]);
    expect((await s.coordinator()).phase).not.toBe("terminal_failure");
    expect((await s.coordinator()).failureCode).toBeNull();
    const saved = await s.authority();
    expect(saved).toMatchObject({ epoch: before.epoch, writerRunId: null, dirty: false });
    expect(saved.snapshotId).not.toBe(before.snapshotId);
    expect(await s.committedSnapshots()).toContain(saved.snapshotId);
    expect(record((await s.workspace()).metadata).remoteWorkspaceAbandonedEpochs).toBeUndefined();
    expect(s.settled).toEqual([]);
    evidence.row2 = { commands: s.fault.commands, slowMsPerCommand: 700, noAttemptMs: 300, attempts: await s.attempts(), authority: saved };
  }, 120_000);

  it("row 4: a copy-out that never starts an attempt (the WAITING shape) fires at 60 s, not before", async () => {
    expect(bound.COPYOUT_NO_ATTEMPT_BOUND_MS).toBe(60_000);
    const s = await scenario();
    await s.streamAndAccept();
    const before = await s.snapshotBefore();
    // REAL: another controller holds the copy-out lock and its owner receipt, and starts no attempt.
    const peer = createDb(database.connectionString);
    let entered!: () => void, release!: () => void;
    const holding = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let lateSave: unknown;
    const owner = withNativeWorkspaceFinalizationOwnership({ db: peer, companyId: s.companyId, runId: s.runId }, async ownership => {
      entered(); await held;
      // After the bound this owner finally tries to save.
      lateSave = await saveRemoteWorkspace({ db: peer, storage: s.storage, workspace: await s.workspace(), runId: s.runId,
        lease: await s.lease() as EnvironmentLease, target: s.target, assertOwned: ownership.assertHeld }).then(() => "saved", error => String(error.message));
    });
    try {
      await holding;
      expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toBeTruthy();
      const accepted = Date.now();
      // The production constants; only the bound's clock moves.
      const at59 = await s.worker({ now: () => accepted + 59_000 }).check();
      expect(at59.entries).toBe(1);
      expect(at59.results[0]).toMatchObject({ id: s.runId });
      expect(await s.coordinator()).toMatchObject({ failureCode: null });
      expect((await s.run()).status).toBe("running");
      expect(await s.attempts()).toEqual([]);
      const at61 = await s.worker({ now: () => Date.now() + 61_000 }).check();
      expect(at61).toEqual({ entries: 1, results: [null] });
      expect(await s.attempts()).toEqual([]);
      expect(record((await s.run()).runnerProfileJson).nativeWorkspaceFinalizationOwner).toBeTruthy();
      expect((await s.run()).status).toBe("failed");
      // Row 3 again, at reservation: that owner now tries its save. It is refused and nothing changes.
      release(); await owner;
      expect(lateSave).toMatch(/remote_workspace_(save_binding_mismatch|authority_changed)/);
      const after = await s.expectEndedWithFilesKept(before);
      evidence.row4 = { lateSave, run: await s.run(), action: after.action };
    } finally { release(); await owner.catch(() => undefined); await peer.$client.end({ timeout: 1 }); }
  }, 120_000);
});
