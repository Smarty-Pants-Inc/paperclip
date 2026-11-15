import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, nativeRunFinalizations, plugins, completionContracts, nativeRunResults, workAssessments, statusDecisions, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { heartbeatService } from "./heartbeat.js";
import { ensureFreshContinuation } from "./fresh-continuation-fallback.js";
import { inspectFreshThreadStopResources, readFreshThreadStopProof } from "./native-runtime/fresh-thread-stop-gate.js";
import { readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { hasBoundRemoteStopReceipt } from "./remote-execution-termination.js";
import { issueService } from "./issues.js";
import { getNativeReviewAssignment } from "./native-runtime/native-review-participant.js";
import { deliverConversationComments } from "./agent-conversations.js";
import { requestTaskRetry } from "./task-retry.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { createAgentLifecycle, configureAgentLifecycle } from "./agent-lifecycle.js";
import { createLifecycleDriver } from "./agent-lifecycle-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// Keep reason: SEED-B's receipt-less ended allocation is a data-safety and
// provider-ownership trust boundary. These deliberately RED invariant tests use
// production DB/admission/acquisition/cleanup owners and only fake external Boat
// I/O. They do not prove any live Boat instance fixed. No product edits.
const support = await getEmbeddedPostgresTestSupport();
const cases = ["typed", "generic", "source-drift", "ordinary-message", "assigned-sweep", "startup-queued", "manual-retry", "paused-message", "reviewer", "native-reviewer", "on-demand-wake"] as const;
type Door = typeof cases[number];
type Variant = "running" | "error";
const wall = new Date("2026-11-15T01:20:00.000Z");
const out = process.env.TASK_OUT;

describe.skipIf(!support.supported)("door-count: one ended receipt-less Boat allocation", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let hb: ReturnType<typeof heartbeatService> | undefined;
  let lifecycleWorker: ReturnType<typeof configureAgentLifecycle> | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("door-count");
    db = createDb(database.connectionString, { maxConnections: 12 });
  }, 60_000);
  afterEach(async () => {
    // Own every execution before closing its fixture. No unawaited test work.
    await lifecycleWorker?.stop();
    lifecycleWorker = undefined;
    await hb?.drainActiveRunExecutions();
    hb = undefined;
    vi.useRealTimers();
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table companies, environments, plugins cascade`);
    });
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(door: Door, variant: Variant) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wall);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID(), userId = randomUUID();
    const root = join(tmpdir(), `door-count-${companyId}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use the saved conversation.\n");
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: wall, updatedAt: wall });
    await db.insert(companies).values({ id: companyId, name: "Door invariant", issuePrefix: "DOOR", defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const [env] = await db.insert(environments).values({ name: `Boat ${companyId}`, driver: "sandbox", status: "active", config: { provider: "boat", image: "boot-source-before", reuseLease: true } }).returning();
    await db.insert(agents).values({ id: agentId, companyId, name: "SEED-B", role: "engineer", status: "idle", adapterType: "paperclip_runner", defaultEnvironmentId: env.id,
      adapterConfig: { provider: "codex", model: "gpt-5.6-luna", cwd: root }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    const conversation = door === "ordinary-message" || door === "paused-message";
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Remember ALDER-B", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat controlled peer", author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true, configSchema: { type: "object" } }] } });
    const failure = door === "typed" ? "native_controller_recovery_missing_evidence:retained_sandbox_binding"
      : door === "generic" || door === "manual-retry" ? "native_session_interrupted" : null;
    const [old] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", nativeSessionId: randomUUID(),
      status: failure ? "failed" : "succeeded", errorCode: failure, responsibleUserId: userId, nativePhase: failure ? "terminal_failure" : "committed",
      createdAt: new Date(wall.getTime() - 1_800_000), finishedAt: new Date(wall.getTime() - 1_500_000),
      contextSnapshot: { issueId, ...(conversation ? { conversation: true } : {}) } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: old.id, phase: failure ? "terminal_failure" : "committed", failureCode: failure, recoveryState: failure ? "blocked" : null });
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: env.id, issueId, heartbeatRunId: old.id,
      provider: "boat", providerLeaseId: `bx-old-${old.id}`, leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success", failureReason: null,
      acquiredAt: new Date(wall.getTime() - 1_790_000), releasedAt: new Date(wall.getTime() - 1_500_000), expiresAt: new Date(wall.getTime() + 7_200_000),
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId,
        ...env.config, historicalEvidence: "must survive byte-for-byte or in endedLeaseEvidence", pendingCleanupInFlight: false } }).returning();
    let environment = { ...env, envVars: {} } as Environment;
    if (door === "source-drift") {
      const [changed] = await db.update(environments).set({ config: { ...env.config, image: "boot-source-after" } }).where(eq(environments.id, env.id)).returning();
      environment = { ...changed, envVars: {} } as Environment;
    }
    const calls: { method: string; params: unknown }[] = [];
    const providerWork: { currentSystemNotes: number; lease: unknown }[] = [];
    const call = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "environmentInspectLease") {
        if (variant === "error") throw new Error("Boat read unavailable (variant B)");
        return { providerLeaseId: (params as { providerLeaseId?: string }).providerLeaseId ?? lease.providerLeaseId, state: "running" };
      }
      // Crossing this boundary is provider work, even if later preparation
      // fails. Stop never reports proof in either variant.
      if (method === "environmentAcquireLease") {
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        const [oldLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
        providerWork.push({ currentSystemNotes: comments.filter(c => c.authorType === "system" && !c.deletedAt && !c.metadata?.supersededByCommentId).length, lease: oldLease });
        return { providerLeaseId: `bx-new-${randomUUID()}`, metadata: { ...environment.config, remoteCwd: "/workspace" } };
      }
      if (method === "environmentResumeLease") return { providerLeaseId: (params as { providerLeaseId: string }).providerLeaseId, metadata: { ...environment.config, remoteCwd: "/workspace" } };
      if (method === "environmentStopLease") return undefined;
      throw new Error(`Controlled Boat peer refuses out-of-scope ${method}`);
    });
    const manager = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", "environmentInspectLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    hb = heartbeatService(db, { environmentRuntime: runtime, pluginWorkerManager: manager, runtimeEnv: { PAPERCLIP_NATIVE_RUNTIME_ENABLED: "true" },
      beforeNativeRuntimeSelection: async () => { throw new Error("Controlled test stops after real admission/workspace acquisition"); },
      nativeSessionBackendFactory: () => { throw new Error("No provider model session permitted in this invariant test"); } });
    const readLease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]!;
    const acquire = async (runId: string) => runtime.acquireRunLease({ companyId, environment, issueId, agentId, heartbeatRunId: runId, adapterType: "paperclip_runner", persistedExecutionWorkspace: null });
    return { companyId, agentId, issueId, userId, issue, old, lease, environment, runtime, manager, calls, providerWork, readLease, acquire };
  }

  // Negative controls deliberately change the ended-allocation fixture: these
  // are ordinary acquisition at the shared runtime boundary, not fresh-thread
  // replacement. Create the valid fingerprints/handoff through production code.
  async function warmFixture() {
    const f = await fixture("ordinary-message", "running");
    await db.update(environmentLeases).set({ status: "expired", provider: "local", providerLeaseId: null })
      .where(eq(environmentLeases.id, f.lease.id));
    const source = await nextRun(f);
    const initial = await f.acquire(source.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: wall }).where(eq(heartbeatRuns.id, source.id));
    await db.update(environmentLeases).set({ status: "retained", releasedAt: wall, cleanupStatus: "success" })
      .where(eq(environmentLeases.id, initial.lease.id));
    f.calls.length = 0;
    return { ...f, retained: initial.lease };
  }
  async function nextRun(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", createdAt: wall, responsibleUserId: f.userId }).returning())[0]!;
  }
  async function recordControl(name: string, f: Awaited<ReturnType<typeof fixture>>, result: unknown) {
    if (out) await appendFile(join(out, process.env.DOOR_EVIDENCE_FILE ?? "door-observations.jsonl"),
      JSON.stringify({ control: name, result, calls: f.calls }) + "\n");
    console.log("DOOR-CONTROL", JSON.stringify({ name, calls: f.calls.map(c => c.method) }));
  }
  it("NEGATIVE CONTROL: ordinary WARM turn resumes its own retained box, no wait or GET-stop", async () => {
    const f = await warmFixture(), next = await nextRun(f);
    const resumed = await f.acquire(next.id);
    await recordControl("warm", f, resumed);
    expect(resumed.lease.providerLeaseId).toBe(f.retained.providerLeaseId);
    expect(f.calls.map(c => c.method)).toEqual(["environmentResumeLease"]);
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))).toHaveLength(0);
  }, 90_000);
  it("NEGATIVE CONTROL: production reusable handoff belongs to NEWER lease, no stop or wait", async () => {
    const f = await warmFixture(), holder = await nextRun(f);
    const handoff = await f.acquire(holder.id);
    const [retired] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.retained.id));
    expect(retired.status).toBe("expired");
    expect(retired.metadata?.reusableLeaseSuccessor).toBeDefined();
    expect(handoff.lease.providerLeaseId).toBe(f.retained.providerLeaseId);
    f.calls.length = 0;
    const resumed = await f.acquire(holder.id);
    await recordControl("newer-handoff", f, { retired, handoff, resumed });
    expect(resumed.lease.id).toBe(handoff.lease.id);
    expect(f.calls.map(c => c.method)).toEqual(["environmentResumeLease"]);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, retired.id)))[0]).toEqual(retired);
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))).toHaveLength(0);
  }, 90_000);
  it("NEGATIVE CONTROL: LOCAL-env run acquires unchanged, no remote GET-stop or wait", async () => {
    const f = await fixture("ordinary-message", "running"), next = await nextRun(f);
    const [local] = await db.update(environments).set({ driver: "local", config: {} }).where(eq(environments.id, f.environment.id)).returning();
    await db.update(environmentLeases).set({ provider: "local", providerLeaseId: null }).where(eq(environmentLeases.id, f.lease.id));
    const acquired = await f.runtime.acquireRunLease({ companyId: f.companyId, environment: { ...local, envVars: {} } as Environment,
      issueId: f.issueId, agentId: f.agentId, heartbeatRunId: next.id, adapterType: "paperclip_runner", persistedExecutionWorkspace: null });
    await recordControl("local", f, acquired);
    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.provider).toBe("local");
    expect(f.calls).toHaveLength(0);
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))).toHaveLength(0);
  }, 90_000);

  // NOT DRIVABLE under the required same-issue earlier-run fixture: a hire is
  // a NEW agent, and its harness verification acquires with issueId/runId=null
  // (agent-environment-test.ts:302). Inventing a conversation identity here
  // would test a contract the hire path does not have. No result is guessed.
  it.skip.each(["running", "error"] as const)("hire: %s (NOT DRIVABLE: no prior issue/run identity)", () => {
    throw new Error("Hire does not carry the required same-issue continuation identity");
  });

  for (const door of cases) it.each(["running", "error"] as const)(`${door}: %s must not open a successor without stop proof`, async variant => {
    const f = await fixture(door, variant);
    let result: unknown, entryError: string | null = null;
    let initialRunIds = [f.old.id];
    try {
      if (door === "typed") {
        // Same outside-lock inspect owner used by execution disposition; the
        // typed entry itself only reads durable evidence under its transaction.
        await inspectFreshThreadStopResources(db, f.old, f.issueId, id => f.runtime.inspectLeaseResource(id, { freshThreadStop: true }));
        result = await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.old.id, trigger: "held_recovery" });
        await deliverReconciledExecutions(db, hb!.wakeup);
      } else if (door === "generic") {
        result = await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.old.id, trigger: "held_recovery" });
        await deliverReconciledExecutions(db, hb!.wakeup);
      } else if (door === "source-drift") {
        const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "running", createdAt: wall, responsibleUserId: f.userId }).returning();
        initialRunIds.push(next.id); // This case starts at acquisition, not admission.
        result = await f.acquire(next.id);
      } else if (door === "ordinary-message" || door === "paused-message") {
        if (door === "paused-message") {
          lifecycleWorker = configureAgentLifecycle(db, createLifecycleDriver(db, f.manager));
          await createAgentLifecycle(db).pauseAgent(f.agentId);
          await lifecycleWorker.process(f.agentId);
        }
        await issueService(db).addComment(f.issueId, "What word did I ask you to remember?", { userId: f.userId }, { clientRequestId: randomUUID() });
        if (door === "paused-message") {
          await deliverConversationComments(db, f.issue, hb!.wakeup);
          await createAgentLifecycle(db).resumeAgent(f.agentId);
          await lifecycleWorker!.process(f.agentId);
        }
        result = await deliverConversationComments(db, f.issue, hb!.wakeup);
      } else if (door === "assigned-sweep") {
        result = await hb!.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: f.issueId });
      } else if (door === "startup-queued") {
        // A persisted never-started ordinary message is the documented startup
        // fast path. It is seeded, not admitted by this test's wakeup call.
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "queued", invocationSource: "automation", triggerDetail: "system", responsibleUserId: f.userId,
          contextSnapshot: { issueId: f.issueId }, createdAt: wall }).returning();
        result = await hb!.resumeFreshQueuedRunsAtStartup();
      } else if (door === "native-reviewer") {
        // Distinct native-review claim, seeded exactly like the native review
        // attachment-manifest fixture. Previous lease belongs to this reviewer;
        // the reviewed worker is another agent on the same issue.
        const workerId = randomUUID();
        await db.insert(agents).values({ id: workerId, companyId: f.companyId, name: "Reviewed worker", status: "idle", adapterType: "paperclip_runner" });
        const [reviewIssue] = await db.update(issues).set({ status: "in_review", assigneeAgentId: workerId,
          executionState: { status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review",
            currentParticipant: { type: "agent", agentId: f.agentId, userId: null },
            returnAssignee: { type: "agent", agentId: workerId, userId: null }, reviewRequest: null,
            completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).where(eq(issues.id, f.issueId)).returning();
        const [contract] = await db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId, revision: 1,
          schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "low", completionAuthority: "agent",
          incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "user", createdByActorId: f.userId }).returning();
        const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: workerId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "succeeded", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
          createdAt: new Date(wall.getTime() - 60_000), finishedAt: new Date(wall.getTime() - 30_000) }).returning();
        initialRunIds.push(source.id);
        const [accepted] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: source.id,
          completionContractId: contract.id, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() }).returning();
        const [assessment] = await db.insert(workAssessments).values({ companyId: f.companyId, issueId: f.issueId, runId: source.id,
          contractId: contract.id, resultId: accepted.id, triggerKind: "native_result", triggerActorCompanyId: f.companyId,
          priorIssueStatus: "in_progress", priorStatusVersion: 2, policyVersion: "fixture", assessmentJson: {}, inputDigest: randomUUID() }).returning();
        const [decision] = await db.insert(statusDecisions).values({ companyId: f.companyId, issueId: f.issueId, runId: source.id,
          assessmentId: assessment.id, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review",
          reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion }, decisionDigest: randomUUID(), applicationState: "applied" }).returning();
        const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
          kind: "request_confirmation", sourceRunId: source.id, addresseeAgentId: f.agentId, createdByAgentId: workerId,
          payload: { version: 1, prompt: "Review saved work", target: { type: "custom", key: "native_completion_review", revisionId: decision.id } } }).returning();
        await db.update(issues).set({ lastStatusDecisionId: decision.id }).where(eq(issues.id, f.issueId));
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "queued", invocationSource: "automation", triggerDetail: "system", responsibleUserId: f.userId,
          contextSnapshot: { issueId: f.issueId, nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: decision.id }, createdAt: wall });
        const assignment = await getNativeReviewAssignment(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
          contextSnapshot: { nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: decision.id } });
        expect(assignment, "native review fixture must have real reviewer authority before measuring").not.toBeNull();
        result = { startup: await hb!.resumeFreshQueuedRunsAtStartup(), assignment };
      } else if (door === "reviewer") {
        // Existing execution-stage review fixture from heartbeat-process-recovery:
        // this is the actual stage participant, not an arbitrary wake reason.
        await db.update(issues).set({ status: "in_review", executionState: { status: "pending", currentStageId: randomUUID(), currentStageIndex: 0,
          currentStageType: "review", currentParticipant: { type: "agent", agentId: f.agentId, userId: null },
          returnAssignee: { type: "agent", agentId: f.agentId, userId: null }, reviewRequest: null,
          completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).where(eq(issues.id, f.issueId));
        result = await hb!.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "execution_review_requested",
          payload: { issueId: f.issueId }, requestedByActorType: "system", requestedByActorId: null,
          contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" } });
      } else if (door === "on-demand-wake") {
        result = await hb!.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
          payload: { issueId: f.issueId }, requestedByActorType: "user", requestedByActorId: f.userId,
          contextSnapshot: { issueId: f.issueId, responsibleUserId: f.userId } });
      } else if (door === "manual-retry") {
        result = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
          idempotencyKey: randomUUID(), observedRunId: f.old.id });
        const requestId = (result as { requestId?: string }).requestId;
        if (requestId) await hb!.resumeTaskRetry(f.companyId, requestId);
      }
    } catch (error) { entryError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    await hb!.drainActiveRunExecutions();
    const beforeSweep = await f.readLease();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const currentNotes = comments.filter(c => c.authorType === "system" && !c.deletedAt && !c.metadata?.supersededByCommentId);
    const providerAcquisitions = f.calls.filter(c => c.method === "environmentAcquireLease");
    const successors = runs.filter(r => !initialRunIds.includes(r.id));
    const claimedSuccessors = successors.filter(r => r.startedAt !== null);
    // Existing owner only, repeated service maintenance must never send a
    // second stop. No fresh proof is introduced by this controlled provider.
    for (let n = 0; n < 3; n++) { vi.setSystemTime(wall.getTime() + n * 3_600_000); await hb!.sweepPendingCleanupLeases(); }
    await hb!.drainActiveRunExecutions();
    const after = await f.readLease();
    const snapshot = JSON.parse(JSON.stringify(f.lease));
    const afterJson = JSON.parse(JSON.stringify(after));
    const intent = readStopOnlyCleanup(after);
    const preserved = isDeepStrictEqual(afterJson, snapshot)
      || isDeepStrictEqual(after.metadata?.endedLeaseEvidence, snapshot)
      || isDeepStrictEqual((intent as unknown as { endedLeaseEvidence?: unknown })?.endedLeaseEvidence, snapshot);
    const oldAllocationCalls = f.calls.filter(c => {
      const params = c.params as { providerLeaseId?: string; lease?: { providerLeaseId?: string } };
      return (params.providerLeaseId ?? params.lease?.providerLeaseId) === f.lease.providerLeaseId;
    });
    const noteCountAtAdmission = f.providerWork[0]?.currentSystemNotes ?? currentNotes.length;
    const observations = { door, variant, result, entryError, providerWork: f.providerWork, noteCountAtAdmission, providerAcquisitions: providerAcquisitions.length,
      claimedSuccessors: claimedSuccessors.map(r => r.id), currentSystemNotes: currentNotes.length,
      stopRequests: oldAllocationCalls.filter(c => c.method === "environmentStopLease").length,
      inspectRequests: oldAllocationCalls.filter(c => c.method === "environmentInspectLease").length,
      preserved, boundStopReceipt: hasBoundRemoteStopReceipt(after), before: f.lease, beforeSweep, after, runs, comments,
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)), calls: f.calls,
      proof: await readFreshThreadStopProof(db, f.old, f.issueId) };
    if (out) await appendFile(join(out, process.env.DOOR_EVIDENCE_FILE ?? "door-observations.jsonl"), JSON.stringify(observations) + "\n");
    console.log("DOOR-RESULT", JSON.stringify({ door, variant, entryError, providerAcquisitions: observations.providerAcquisitions,
      claimedSuccessors: observations.claimedSuccessors.length, currentSystemNotes: observations.currentSystemNotes, noteCountAtAdmission,
      stopRequests: observations.stopRequests, inspectRequests: observations.inspectRequests, preserved }));
    expect.soft(entryError, "entry must be driven, not fail in fixture authorization/setup").toBeNull();
    expect.soft(providerAcquisitions, "NO successor may claim provider acquisition while old box has no stop proof").toHaveLength(0);
    expect.soft(claimedSuccessors, "NO successor execution may start while old box has no stop proof").toHaveLength(0);
    expect.soft(noteCountAtAdmission, "exactly ONE current system note before provider work, or while waiting (never silent)").toBe(1);
    expect.soft(preserved, "original ended lease evidence must survive intact or in endedLeaseEvidence").toBe(true);
    expect.soft(observations.stopRequests, "only existing stop owner, at most ONE stop request").toBeLessThanOrEqual(1);
    expect.soft(observations.boundStopReceipt, "RUNNING/error must not become stop proof").toBe(false);
  }, 90_000);
});
