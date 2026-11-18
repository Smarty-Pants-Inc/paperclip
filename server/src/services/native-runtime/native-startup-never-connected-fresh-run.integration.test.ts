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

// r104c (RFL + org 11-16 11:11-11:17Z): an exhausted never-connected first start
// KEEPS the automatic fresh continuation (a fresh run on a new box usually
// answers); only its note becomes truthful. Harness copied from r104b's
// native-startup-never-connected-notice.integration.test.ts.
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
import { FRESH_THREAD_STARTED_NOTE, freshThreadStartedNote } from "./fresh-thread-stop-gate.js";
import { selectFreshContinuationThread } from "./pi-conversation-record.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";

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

describe("a first start whose Runner never connected keeps its automatic fresh continuation, with a truthful note (r104c)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-never-connected-fresh-run-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Never connected fresh run", issuePrefix: "NCF" });
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

  /** The plain note this case owes: nothing was restored, a fresh run starts. */
  const TRUTHFUL = "Provider startup failed 3 times before any work began; starting again in a fresh run.";

  async function exhaust(seeded: Seeded, failure: () => Error) {
    await fail(seeded, failure());
    await fail(seeded, failure(), await claimRetry(seeded));
    await fail(seeded, failure(), await claimRetry(seeded));
  }

  /** The continuation is recorded and delivered, and its run selects its thread. */
  async function continueAndSelect(seeded: Seeded) {
    // Every owner gets its turn in the order they run: the unanswered-message
    // owner after its settle time, the execution-disposition worker, the
    // unanswered owner again while the continuation is on its way, then the
    // continuation's run selects its thread (where its one note is owed).
    await unanswered(seeded, new Date(Date.now() + 16_000));
    await settleUnrecoverableExecutions(db, new Date(Date.now() + 20_000));
    await unanswered(seeded, new Date(Date.now() + 60_000));
    const state = await read(seeded);
    expect(state.continued).toHaveLength(1);
    // The continuation's run as the delivery wake creates it (deliverReconciledExecutions' wake;
    // the heartbeat wake itself is out of scope here), admitted and running.
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, seeded.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    expect(action!.evidence).toMatchObject({ continuationDelivery: "pending",
      freshContinuation: { sourceRunId: seeded.runId }, freshContinuationSettlement: { decision: "continue_in_fresh_run" } });
    const recordedAt = String((action!.evidence.freshContinuation as { recordedAt: string }).recordedAt);
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId: seeded.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: seeded.issueId, invocationSource: "automation", triggerDetail: "system",
      retryOfRunId: seeded.runId, createdAt: new Date(new Date(recordedAt).getTime() + 1_000), startedAt: new Date(),
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, recoveryActionId: action!.id, previousRunId: seeded.runId,
        retryOfRunId: seeded.runId, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" },
    }).returning();
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
      { continuationDelivery: "delivered", continuationRunId: next!.id })}::jsonb` }).where(eq(issueRecoveryActions.id, action!.id));
    const input = { companyId, agentId: seeded.agentId, issueId: seeded.issueId, runId: next!.id };
    const selected = await selectFreshContinuationThread(db, input);
    expect(selected).toEqual(expect.any(String));
    expect(await selectFreshContinuationThread(db, input)).toBe(selected);
    await unanswered(seeded, new Date(Date.now() + 10 * 60_000));
    return read(seeded);
  }

  it.each([{ userComment: true }, { userComment: false }])(
    "after exhaustion continues automatically in a fresh run whose one note is truthful (user comment: $userComment)",
    async ({ userComment }) => {
      const seeded = await seed({ userComment });
      await exhaust(seeded, () => new Error(PREPARE_NEVER_CONNECTED));
      const exhausted = await read(seeded);
      expect(exhausted.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_retry_exhausted", attempt: 3,
        failureDetail: expect.objectContaining({ originalFailureCode: "runner_ingress_startup_failed", recoveryMode: "bootstrap_retry",
          providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false }) });
      // The recovery record keeps r104b's truthful next step.
      expect(String(exhausted.coordinator.failureDetail?.nextAction)).toContain("3 attempts");

      const state = await continueAndSelect(seeded);
      // The automatic fresh continuation is recorded, exactly as before r104b.
      expect(state.continued).toHaveLength(1);
      // Exactly one note in total: the continuation's, and it is the truthful one.
      expect(state.notes.map(note => note.body)).toEqual([TRUTHFUL]);
      expect(state.notes.filter(note => note.body.includes("earlier provider thread"))).toEqual([]);
      expect(state.notes.filter(note => note.body.includes(FRESH_THREAD_STARTED_NOTE))).toEqual([]);
    },
  );

  it("the note is chosen by the same predicate: the exhausted never-connected source gets the truthful text", async () => {
    const seeded = await seed({ userComment: false });
    await exhaust(seeded, () => new Error(PREPARE_NEVER_CONNECTED));
    const { run } = await read(seeded);
    expect(await freshThreadStartedNote(db, run)).toBe(TRUTHFUL);
  });

  it("guard: a run that had a provider thread still gets the 'earlier thread' note", async () => {
    const seeded = await seed({ userComment: false });
    await exhaust(seeded, () => new Error(PREPARE_NEVER_CONNECTED));
    const { coordinator, run } = await read(seeded);
    await db.update(nativeRunFinalizations).set({ failureDetail: { ...coordinator.failureDetail, providerSessionEstablished: true } })
      .where(eq(nativeRunFinalizations.runId, seeded.runId));
    expect(await freshThreadStartedNote(db, run)).toBe(FRESH_THREAD_STARTED_NOTE);
  });

  it("guard: another startup code's exhaustion continues with the unchanged 'earlier thread' note, exactly one note", async () => {
    const seeded = await seed({ userComment: false });
    await exhaust(seeded, sessionOpenFailure);
    const exhausted = await read(seeded);
    expect(exhausted.coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "native_session_retry_exhausted",
      failureDetail: expect.objectContaining({ originalFailureCode: "provider_session_open_rejected" }) });
    expect(exhausted.notes).toEqual([]);
    const state = await continueAndSelect(seeded);
    expect(state.continued[0]!.details).toMatchObject({ failureCode: "provider_session_open_rejected", trigger: "recovery_refused" });
    expect(state.notes.map(note => note.body)).toEqual([FRESH_THREAD_STARTED_NOTE]);
  });
});
