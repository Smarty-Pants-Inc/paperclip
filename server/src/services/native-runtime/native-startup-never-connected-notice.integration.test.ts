import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

// rf4 person timelines (R1-04 follow-up, r104b). The executor's real
// never-connected proof (nativeRunnerNeverAuthenticated over a real
// DurablePrpControlPlane checkpoint) is covered by
// native-controller-recovery.integration.test.ts; here it is the seam, so
// these tests follow what a PERSON sees across the three owners: the
// executor's failure settlement, the 120 s unanswered-message owner and the
// execution-disposition worker (settle / fresh continuation).
const proof = vi.hoisted(() => ({ neverAuthenticated: true }));
vi.mock("./native-runner-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native-runner-checkpoint.js")>();
  return {
    ...actual,
    nativeRunnerNeverAuthenticated: vi.fn(async (...args: Parameters<typeof actual.nativeRunnerNeverAuthenticated>) =>
      proof.neverAuthenticated ? true : actual.nativeRunnerNeverAuthenticated(...args)),
  };
});
const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";
import { FRESH_THREAD_STARTED_NOTE } from "./fresh-thread-stop-gate.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import {
  PENDING_WAIT_ACTION,
  PENDING_WAIT_BOUND_MS,
  settleUnansweredPersonMessage,
  unansweredMessageCode,
} from "../recovery/unanswered-person-message.js";

/** The transport's own stall text (runnerd-codex-transport.ts describeRunnerCommandStall). */
const PREPARE_NEVER_CONNECTED = "runner_ingress_unavailable: PRP command run.prepare timed out "
  + "(runner never connected; pending ahead 0; last runner event none)";

function sessionOpenFailure() {
  const result = { result: { code: "command_execution_failed",
    message: "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=session_ensure_failed)" },
  status: "failed" };
  const error = new Error(`PRP command session.open failed: ${JSON.stringify(result)}`);
  Object.defineProperty(error, "runnerCommandResult", { value: structuredClone(result), enumerable: false });
  return error;
}

describe("a first start whose Runner never connected: what the person sees (rf4)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-never-connected-notice-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Never connected", issuePrefix: "NNC" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed(options: { userComment: boolean }) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: `Agent ${agentId.slice(0, 8)}`, status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", agent: "claude" } });
    const issueId = randomUUID();
    const runId = randomUUID();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Please do this first task",
      status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
    let messageId: string | null = null;
    if (options.userComment) {
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        body: "Please do this first task." }).returning();
      messageId = comment!.id;
    }
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system",
      startedAt: new Date(), contextSnapshot: { issueId, ...(messageId ? { wakeCommentId: messageId } : {}) } }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: { identifier: issueId, title: issue!.title, description: null, prompt: "Continue the task.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) },
      interactionResponses: [],
      credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    return { agentId, issueId, runId, execution, runnerInstanceId: native.runnerInstanceId, messageId };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function fail(seeded: Seeded, failure: Error, leaseOwner?: string) {
    provider.execute.mockReset().mockImplementation(async () => { throw failure; });
    await expect(executePaperclipNativeSession({ db, execution: seeded.execution, runnerInstanceId: seeded.runnerInstanceId,
      ...(leaseOwner ? { leaseOwner } : {}),
      backend: { descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); } } })).rejects.toThrow();
  }

  async function read(seeded: Seeded) {
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, seeded.issueId),
      eq(issueComments.authorType, "system")));
    const continued = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.issueId),
      eq(activityLog.action, "issue.continued_from_saved_work")));
    return { coordinator: coordinator!, run: run!, issue: issue!, actions, notes: notes.filter(note => !note.deletedAt), continued };
  }

  async function claimRetry(seeded: Seeded) {
    const { coordinator } = await read(seeded);
    expect(coordinator.nextAttemptAt).toBeInstanceOf(Date);
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "never-connected-test", runIds: [seeded.runId],
      now: new Date(coordinator.nextAttemptAt!.getTime() + 1), deferIneligible: false });
    expect(claims).toHaveLength(1);
    return claims[0]!.leaseOwner;
  }

  const unanswered = (seeded: Seeded, now: Date) => settleUnansweredPersonMessage(db, { companyId, issueId: seeded.issueId, now });

  it("classifies the run as runner_ingress_startup_failed and posts no unanswered notice while attempt 2's retry is scheduled", async () => {
    const seeded = await seed({ userComment: true });
    await fail(seeded, new Error(PREPARE_NEVER_CONNECTED));
    let state = await read(seeded);
    expect(state.coordinator).toMatchObject({ phase: "retryable_failure", attempt: 1,
      failureDetail: expect.objectContaining({ originalFailureCode: "runner_ingress_startup_failed", recoveryMode: "bootstrap_retry" }) });
    expect(state.issue.status).toBe("in_progress");
    // The owner's code for this run: the shown code, not unclassified_failure.
    expect(state.run.errorCode).toBe("runner_ingress_startup_failed");
    expect(unansweredMessageCode(state.run)).toBe("runner_ingress_startup_failed");
    // Attempt 1's +16 s owner pass.
    expect((await unanswered(seeded, new Date(Date.now() + 16_000))).kind).toBe("pending");

    // Attempt 2 fails; its retry is scheduled (jittered 48-72 s out).
    await fail(seeded, new Error(PREPARE_NEVER_CONNECTED), await claimRetry(seeded));
    state = await read(seeded);
    expect(state.coordinator).toMatchObject({ phase: "retryable_failure", attempt: 2 });
    const [wait] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.issueId),
      eq(activityLog.action, PENDING_WAIT_ACTION)));
    // The bounded 120 s wait from attempt 1 has expired; attempt 3 is still scheduled.
    const pastBound = new Date((wait?.createdAt ?? new Date()).getTime() + PENDING_WAIT_BOUND_MS + 5_000);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThan(pastBound.getTime() - 5 * 60_000);
    expect((await unanswered(seeded, pastBound)).kind).toBe("pending");
    expect((await read(seeded)).notes).toEqual([]);
  });

  it.each([{ userComment: true }, { userComment: false }])(
    "after exhaustion posts exactly one truthful note and no fresh-thread note (user comment: $userComment)",
    async ({ userComment }) => {
      const seeded = await seed({ userComment });
      await fail(seeded, new Error(PREPARE_NEVER_CONNECTED));
      expect((await read(seeded)).notes).toEqual([]);
      await fail(seeded, new Error(PREPARE_NEVER_CONNECTED), await claimRetry(seeded));
      expect((await read(seeded)).notes).toEqual([]);
      await fail(seeded, new Error(PREPARE_NEVER_CONNECTED), await claimRetry(seeded));
      let state = await read(seeded);
      expect(state.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_retry_exhausted", attempt: 3,
        failureDetail: expect.objectContaining({ originalFailureCode: "runner_ingress_startup_failed", recoveryMode: "bootstrap_retry",
          providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false }) });
      const truthful = String(state.coordinator.failureDetail?.nextAction);
      expect(truthful).toContain("3 attempts");

      // Every owner gets its turn: the unanswered-message owner after its
      // settle time, and the execution-disposition worker.
      await unanswered(seeded, new Date(Date.now() + 16_000));
      await settleUnrecoverableExecutions(db, new Date(Date.now() + 20_000));
      await unanswered(seeded, new Date(Date.now() + 10 * 60_000));
      state = await read(seeded);

      expect(state.notes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE))).toEqual([]);
      // No fresh continuation that would start a "restored" thread.
      expect(state.continued).toEqual([]);
      expect(state.notes).toHaveLength(1);
      expect(state.notes[0]!.body).toBe(truthful);
      expect(state.issue.status).toBe("blocked");
    },
  );

  it("guard: another startup code's exhaustion still continues from saved work (the fresh-thread path is unchanged)", async () => {
    const seeded = await seed({ userComment: false });
    await fail(seeded, sessionOpenFailure());
    await fail(seeded, sessionOpenFailure(), await claimRetry(seeded));
    await fail(seeded, sessionOpenFailure(), await claimRetry(seeded));
    let state = await read(seeded);
    expect(state.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_retry_exhausted",
      failureDetail: expect.objectContaining({ originalFailureCode: "provider_session_open_rejected" }) });
    expect(state.notes).toEqual([]);
    await settleUnrecoverableExecutions(db, new Date(Date.now() + 20_000));
    state = await read(seeded);
    expect(state.continued).toHaveLength(1);
    expect(state.continued[0]!.details).toMatchObject({ failureCode: "provider_session_open_rejected", trigger: "recovery_refused" });
  });

  it("guard: other codes' unanswered-notice classification is unchanged", () => {
    expect(unansweredMessageCode({ status: "failed", error: "provider_session_open_timeout: x", errorCode: "provider_session_open_timeout" }))
      .toBe("provider_session_open_timeout");
    expect(unansweredMessageCode({ status: "failed", error: "boom", errorCode: "runner_ingress_unavailable" })).toBe("unclassified_failure");
    expect(unansweredMessageCode({ status: "failed", error: null, errorCode: "native_session_interrupted" })).toBe("native_session_interrupted");
  });
});
