import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { answerWithNativePeer } from "../__tests__/helpers/native-answer-peer.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest } from "../vendor/paperclip-runner/index.js";
import { buildNativeRuntimeContext } from "./native-runtime/runtime-context.js";
import { prepareNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { createNativeSessionHandoffLoader } from "./native-runtime/native-session-handoff.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./heartbeat/runtime-selection.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { listFreshContinuations } from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { prepareUnconfirmedSourceSandboxStop, retryUnconfirmedSourceSandboxStop } from "./sandbox-stop-and-retain.js";
import { freshThreadStopGate, readFreshThreadStopProof } from "./native-runtime/fresh-thread-stop-gate.js";
import { hasBoundRemoteStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

// Keep reason: SEED-B's recorded data-loss/silence incident, and the allocation
// ownership trust boundary. Only context materialization/sandbox I/O are peers;
// proof, cleanup claims, disposition, wake admission, history and native result
// settlement are the real owners. This is local deterministic qualification,
// not a claim that a live Boat deployment was repaired.
vi.mock("./native-runtime/runtime-context.js", async original => ({
  ...await original<typeof import("./native-runtime/runtime-context.js")>(),
  buildNativeRuntimeContext: vi.fn(async () => nativeRuntimeContextFixture()),
}));
vi.mock("./native-runtime/native-workspace-sync.js", async original => ({
  ...await original<typeof import("./native-runtime/native-workspace-sync.js")>(),
  prepareNativeWorkspaceSync: vi.fn(async () => null),
}));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F1 SEED-B real sequence", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "f1-seed-b-"));
    await writeFile(join(root, "AGENTS.md"), "Read the saved conversation and answer the person's message.\n");
    database = await startEmbeddedPostgresTestDatabase("f1-seed-b");
    db = createDb(database.connectionString);
    vi.mocked(buildNativeRuntimeContext).mockImplementation(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = root;
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
    vi.mocked(prepareNativeWorkspaceSync).mockResolvedValue(null);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`truncate table companies cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });

  it.each(["idle-release", "receipt-window-end", "released-no-receipt", "expired-no-receipt", "retained-age-stop", "observed-owner", "observed-proof-arrives", "proof-arrives", "running", "stopping", "unknown", "other-lease", "tl07-idle", "tl07-running"] as const)(
    "%s: stop-safe recovery; TL07 idle answers without a waiting note", async shape => {
    const t0 = Date.now();
    const tl07 = shape.startsWith("tl07-");
    const liveTurn = shape === "tl07-running";
    const observedOwner = shape.startsWith("observed-");
    vi.useFakeTimers({ toFake: ["Date"] });
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "SEED-B replay", issuePrefix: "FSB", defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Seed B agent", role: "engineer", status: "running", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Remember the word", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [old] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running", responsibleUserId: userId, createdAt: new Date(t0 - 600_000), contextSnapshot: { issueId: issue.id } }).returning();
    const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const inputFor = (run: typeof old): HeartbeatRuntimeSelectionInput => ({
      run, agent,
      nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
      task: { issueRef: issue, issueContext: null, context: run.contextSnapshot ?? {}, executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskResumeSessionId: null, isFailedChatRunRetry: false, getFreshSessionHandoff: createNativeSessionHandoffLoader({ db, companyId: company.id, agentId: agent.id, issueId: issue.id, before: run.createdAt }) },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null }, executionTarget: null, isDotRun: false, projectRepositoryPaths: [], activeEnvironmentLease: { lease: { id: randomUUID(), companyId: company.id, environmentId: null, executionWorkspaceId: null, issueId: issue.id, heartbeatRunId: run.id, status: "active", leasePolicy: "ephemeral", provider: null, providerLeaseId: null, acquiredAt: new Date(), lastUsedAt: new Date(), expiresAt: null, releasedAt: null, failureReason: null, cleanupStatus: null, metadata: null, createdAt: new Date(), updatedAt: new Date() } } },
      config: { runtimeConfig: {}, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null, agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
      recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null }, issuesSvc: { addComment: vi.fn() }, runtimeEnv: {}, onAdapterEvent: vi.fn(async () => {}), onNativeLifecycleSelected: vi.fn(), onProviderResourceDisposition: vi.fn(), onNativeOwnershipHeld: vi.fn(), stopControllerLease: vi.fn(),
    });
    const first = await selectHeartbeatRuntime(db, inputFor(old));
    if (!first.selected || !first.nativeExecution) throw new Error("Initial native session not selected");
    const sessionId = first.nativeExecution.session.normalizedSessionId!;
    await db.update(heartbeatRuns).set({ status: observedOwner || liveTurn ? "running" : "succeeded", finishedAt: observedOwner || liveTurn ? null : new Date(t0 - 500_000), errorCode: observedOwner ? "native_execution_ownership_unverified" : null }).where(eq(heartbeatRuns.id, old.id));
    await db.update(nativeRunFinalizations).set({ phase: observedOwner || liveTurn ? "observed" : "committed", leaseOwner: observedOwner || liveTurn ? "departed-owner" : null, leaseExpiresAt: new Date(liveTurn ? t0 + 3600_000 : 0), resultId: null, nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, old.id));
    // The exact saved input wording/word and provider allocation are from the
    // supplied SEED-B capture. Legacy missing-confirmedAt is an explicit variant:
    // the capture omits raw lease metadata, so it is NOT asserted to be its bytes.
    await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: userId, body: "Remember the word ALDER-B. Reply only: noted.", createdAt: new Date(t0 - 600_000) });
    await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: userId, body: "TEST: What word did I ask you to remember? Reply with that word only.", createdAt: new Date(t0 - 60_000) });
    // TL07 is the persisted instruction-edit refusal on an OPEN task. Idle
    // must ANSWER, not merely post a waiting note; a genuinely in-flight turn
    // keeps its owner and one note. Dev-lead owns the runner's prepare change.
    if (tl07) await writeFile(join(root, "AGENTS.md"), "Updated assigned skill: answer the saved word from history.\n");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure", errorCode: tl07 ? "native_runner_refresh_required" : "native_controller_recovery_missing_evidence:retained_sandbox_binding", resultJson: tl07 ? { nativeFreshContinuationRefusal: { code: "native_runner_refresh_required", prepareRefusalCode: "provider_instructions_changed", waitForTurn: liveTurn } } : null, responsibleUserId: userId, createdAt: new Date(t0 - 60_000), finishedAt: new Date(t0 - 30_000), contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id, phase: "terminal_failure", failureCode: source.errorCode, recoveryState: "blocked" });
    const [blocked] = await db.update(issues).set({ status: "blocked", blockedTransitionAt: source.finishedAt }).where(eq(issues.id, issue.id)).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id, kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", status: "active", ownerType: "board", returnOwnerAgentId: agent.id, fingerprint: `f1-seed-b:${source.id}`, nextAction: "Attempt 1/3: do not open a replacement", evidence: { runId: source.id, nativeFailureBlock: { runId: source.id, statusVersion: blocked.statusVersion } } }).returning();
    const inspectedStop = ["released-no-receipt", "expired-no-receipt", "retained-age-stop"].includes(shape);
    const endedWithoutReceipt = shape === "released-no-receipt" || shape === "expired-no-receipt";
    const preconfirmed = ["idle-release", "receipt-window-end", "observed-owner", "other-lease"].includes(shape);
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, heartbeatRunId: old.id, provider: "boat", providerLeaseId: "bx_ysh5xvy5", leasePolicy: "reuse_by_environment", status: shape === "expired-no-receipt" ? "expired" : preconfirmed || endedWithoutReceipt ? "released" : "retained", cleanupStatus: preconfirmed || endedWithoutReceipt || shape === "retained-age-stop" ? "success" : null, acquiredAt: new Date(t0 - 590_000), releasedAt: preconfirmed || endedWithoutReceipt ? new Date(t0 - 300_000) : null, metadata: { pluginId: "fixture-boat" } }).returning();
    if (preconfirmed) await db.update(environmentLeases).set({ metadata: { ...lease.metadata, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: company.id, runId: old.id, leaseId: lease.id, provider: "boat", providerLeaseId: lease.providerLeaseId, state: "stopped", ...(shape === "receipt-window-end" ? { confirmedAt: lease.releasedAt!.toISOString() } : {}) } } }).where(eq(environmentLeases.id, lease.id));
    const before = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]!;
    if (shape === "receipt-window-end") {
      expect(before.metadata?.remoteExecutionTermination).not.toHaveProperty("kind");
      expect((before.metadata?.remoteExecutionTermination as { confirmedAt: string }).confirmedAt).toBe(before.releasedAt!.toISOString());
      expect(hasRemoteTerminationReceipt(before)).toBe(true);
      expect(hasBoundRemoteStopReceipt(before)).toBe(true);
      expect((await readFreshThreadStopProof(db, source, issue.id)).gone).toBe(true);
    }
    if (endedWithoutReceipt) {
      await db.transaction(tx => freshThreadStopGate(tx as unknown as Db, source, issue.id));
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(before);
      expect(await prepareUnconfirmedSourceSandboxStop(db, before)).toBeNull();
      expect(await retryUnconfirmedSourceSandboxStop(db, before)).toBeNull();
    }
    if (!preconfirmed && !inspectedStop) await db.update(environmentLeases).set({ metadata: { ...before.metadata,
      pendingCleanupController: { bootId: "stale-boot", processStartedAt: "2026-11-14T11:49:42.000Z" } } }).where(eq(environmentLeases.id, lease.id));
    if (shape === "other-lease") {
      const [peerIssue] = await db.insert(issues).values({ companyId: company.id, title: "Allocation's actual holder", status: "in_progress", assigneeAgentId: agent.id }).returning();
      const [peer] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: peerIssue.id, status: "running", runtimeMode: "native", nativeIssueId: peerIssue.id, controllerLeaseExpiresAt: new Date(t0 + 3600_000), contextSnapshot: { issueId: peerIssue.id } }).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: company.id, issueId: peerIssue.id, runId: peer.id, phase: "observed", leaseOwner: "actual-allocation-holder", leaseExpiresAt: new Date(t0 + 3600_000) });
      await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: peer.id, issueId: peerIssue.id, provider: "boat", providerLeaseId: lease.providerLeaseId, status: "active" });
    }
    let providerState: string = inspectedStop ? "stopped" : shape === "running" ? "active" : shape;
    const inspectLeaseResource = vi.fn(async () => {
      // A separate transaction can take the task lock NOWAIT at the provider
      // boundary. Calling this from the locked admission gate would fail.
      await db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update", { noWait: true }); });
      return { providerLeaseId: lease.providerLeaseId!, state: providerState };
    });
    const stop = vi.fn(async () => undefined);
    const hb = heartbeatService(db, { environmentRuntime: { inspectLeaseResource, retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    const tick = async (n: number) => {
      vi.setSystemTime(t0 + n * (inspectedStop ? 30_000 : 300_000));
      await hb.reapOrphanedRuns();
      await settleUnrecoverableExecutions(db, new Date(), { inspectLeaseResource });
      await hb.sweepPendingCleanupLeases();
      await settleUnrecoverableExecutions(db, new Date(), { inspectLeaseResource });
      if (process.env.TASK_OUT) await appendFile(join(process.env.TASK_OUT, "seed-states.jsonl"), JSON.stringify({ shape, n, runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id)), leases: await db.select().from(environmentLeases).where(eq(environmentLeases.issueId, issue.id)), actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)) }) + "\n");
    };
    const notes = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).filter(c => c.authorType === "system");
    const current = async () => (await notes()).filter(c => !c.metadata?.supersededByCommentId);
    const runCount = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id))).length;
    for (let n = 0; n < 3; n++) {
      await tick(n);
      if ((!preconfirmed && !inspectedStop && shape !== "tl07-idle") || shape === "other-lease") {
        expect(await runCount()).toBe(2);
        expect(await listFreshContinuations(db, { companyId: company.id, issueId: issue.id })).toHaveLength(0);
        expect(await current()).toHaveLength(1);
        expect((await current())[0].body).toMatch(liveTurn || observedOwner ? /current step must finish/ : /earlier attempt.*stop|stopping the earlier attempt/);
        expect(await notes()).toHaveLength(1); // no repeated note at ~5-min sweeps
      }
    }
    if (preconfirmed) {
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(before);
      expect(await prepareUnconfirmedSourceSandboxStop(db, before)).toBeNull();
      expect(await retryUnconfirmedSourceSandboxStop(db, before)).toBeNull();
      expect(stop).not.toHaveBeenCalled();
      expect(inspectLeaseResource).not.toHaveBeenCalled();
    }
    if (inspectedStop) {
      expect(inspectLeaseResource).toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      const [settledLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(settledLease.status).toBe(endedWithoutReceipt ? before.status : "released");
      expect(hasRemoteTerminationReceipt(settledLease)).toBe(true);
      expect(settledLease.metadata).not.toHaveProperty("sandboxStopAndRetainReceipt");
      if (endedWithoutReceipt) {
        // The new physical observation is now, not the historical idle close;
        // never backdate its receipt to that old timestamp.
        expect(settledLease.releasedAt!.getTime()).toBeGreaterThanOrEqual(before.releasedAt!.getTime());
        expect((settledLease.metadata?.remoteExecutionTermination as { confirmedAt: string }).confirmedAt).toBe(settledLease.releasedAt!.toISOString());
      }
      expect(await current()).toHaveLength(1);
    }
    if (!["idle-release", "receipt-window-end", "observed-owner", "observed-proof-arrives", "proof-arrives", "tl07-idle"].includes(shape) && !inspectedStop) {
      expect(await runCount()).toBe(2);
      return;
    }
    const proofLands = shape === "proof-arrives" || shape === "observed-proof-arrives";
    if (proofLands) {
      providerState = "stopped"; await tick(3); expect(inspectLeaseResource).toHaveBeenCalled();
      const [stoppedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(stoppedLease).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { leaseId: lease.id, runId: old.id, providerLeaseId: lease.providerLeaseId, state: "stopped" } } });
      expect(stoppedLease.metadata).not.toHaveProperty("sandboxStopAndRetainReceipt");
      expect((stoppedLease.metadata?.pendingCleanupController as { bootId?: string } | undefined)?.bootId).not.toBe("stale-boot");
    }
    if (shape === "tl07-idle") {
      // RFL ruling 20:21Z: an idle instruction refresh must close successfully
      // and answer from history, without first posting a stop-waiting note.
      expect(await notes()).toHaveLength(0);
      const [closedIdleLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(hasBoundRemoteStopReceipt(closedIdleLease)).toBe(true);
    }
    // Occupy the agent slot so real delivery/admission leaves its automatically
    // admitted run observable as queued. No test mints a successor run or resends
    // input. Then exercise that run's real selection/executor with a native peer.
    const [busy] = await db.insert(issues).values({ companyId: company.id, title: "Other work", status: "in_progress", assigneeAgentId: agent.id }).returning();
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: busy.id, status: "running", contextSnapshot: { issueId: busy.id } });
    await deliverReconciledExecutions(db, hb.wakeup);
    await hb.drainActiveRunExecutions();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
    expect(successors).toHaveLength(1);
    expect(successors[0].status).toBe("queued");
    expect(successors[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: source.id });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0]).toMatchObject({ status: "resolved", outcome: "restored" });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).not.toBe("blocked");
    expect(await getExecutionBlocker(db, company.id, issue.id)).toBeNull();
    const [next] = await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successors[0].id)).returning();
    await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, issue.id));
    // The controlled peer starts the genuinely queued admission in place of
    // dispatch's external provider. Mirror dispatch's agent running projection;
    // this is not a claim that the test exercises the queue's process launcher.
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, agent.id));
    const selected = await selectHeartbeatRuntime(db, inputFor(next));
    if (!selected.selected || !selected.nativeExecution) throw new Error("Fresh selection not admitted");
    expect(selected.nativeExecution.session.normalizedSessionId).not.toBe(sessionId);
    if (process.env.TASK_OUT) await appendFile(join(process.env.TASK_OUT, "seed-before-answer.jsonl"), JSON.stringify({ shape, run: await readRun(next.id), agent: (await db.select().from(agents).where(eq(agents.id, agent.id)))[0], issue: (await db.select().from(issues).where(eq(issues.id, issue.id)))[0] }) + "\n");
    const answer = await answerWithNativePeer({ db, execution: selected.nativeExecution, runnerInstanceId: selected.nativeRunnerInstanceId!, text: "ALDER-B", getFreshSessionHandoff: selected.getNativeFreshSessionHandoff! });
    expect(answer.settled.status).toBe("succeeded");
    expect(JSON.stringify(answer.prompts)).toContain("ALDER-B");
    expect(JSON.stringify(answer.prompts)).toContain("What word did I ask you to remember?");
    for (let n = 4; n < 7; n++) { await settleUnrecoverableExecutions(db); await deliverReconciledExecutions(db, hb.wakeup); }
    expect(await runCount()).toBe(3);
    if (shape === "tl07-idle") {
      expect(await current()).toHaveLength(0);
      expect(await notes()).toHaveLength(0);
    } else {
      expect(await current()).toHaveLength(1);
      expect((await current())[0].body).toContain("fresh thread");
      expect(await notes()).toHaveLength(proofLands || endedWithoutReceipt ? 2 : 1);
    }
    if (inspectedStop) expect(Date.now() - t0).toBeLessThanOrEqual(60_000);
    if (observedOwner) expect(await readRun(old.id)).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
  }, 60_000);
});
