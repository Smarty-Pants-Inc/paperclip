import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { EXECUTION_BLOCKER_PERSON_RETRY_ACTION, getExecutionBlocker } from "./execution-blocker.js";
import { HELD_PREDECESSOR_NOTICE } from "./native-runtime/native-session-executor.js";
import { writePiSessionHistoryLossNotice } from "./native-runtime/pi-session-recovery-notice.js";
import { EXECUTION_FINALIZATION_DEADLINE_MESSAGE } from "./execution-control-deadline.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution blocker PostgreSQL read projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-blocker-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}, extraEvidence: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocker fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Blocker agent", adapterType: "process", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Blocker task", status: "blocked", assigneeAgentId: agentId });
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      startedAt: new Date("2020-01-01T00:00:00Z"), finishedAt: new Date("2020-01-01T00:01:00Z"),
      errorCode: "adapter_failed", error: "Fixture failure", contextSnapshot: { issueId, prompt: payload },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner", adapterConfig: { instructions: payload } }, instructions: payload },
      stdoutExcerpt: payload, ...patch,
    }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "legacy_execution_requires_reconciliation", fingerprint: run.id, status: "active", nextAction: "Inspect the source run.",
      evidence: { runId: run.id, ...extraEvidence } });
    return { companyId, agentId, issueId, run };
  }

  function recordRunReads(fullRows = false) {
    const reads: unknown[][] = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = args[0] === heartbeatRuns && fullRows ? target.select().from(heartbeatRuns) : from(...args);
          if (args[0] === heartbeatRuns) {
            const execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              const rows = await execute(...executeArgs); reads.push(rows); return rows;
            };
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    return { recorded, reads };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>) {
    const baseline = recordRunReads(true), projected = recordRunReads();
    const expected = await getExecutionBlocker(baseline.recorded, f.companyId, f.issueId);
    const result = await getExecutionBlocker(projected.recorded, f.companyId, f.issueId);
    expect(expected).not.toBeNull();
    expect(result).toEqual(expected);
    expect(projected.reads).toHaveLength(baseline.reads.length);
    expect(projected.reads.flat()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected.reads))).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(baseline.reads))).toBeGreaterThan(128 * 1024);
    return result;
  }

  it("preserves blocker and retry decisions without returning prompts, profiles, or output", async () => {
    const f = await fixture();
    expect(await compare(f)).toMatchObject({ runId: f.run.id, agentId: f.agentId, canRetry: true, canContinue: false });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect(await getExecutionBlocker(db, randomUUID(), f.issueId)).toBeNull();
  });

  it("names Retry as the person's control, so an agent reading the blocker does not re-run the work", async () => {
    const f = await fixture();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: true });
    expect(blocker!.nextAction).toBe(`Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}`);
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toMatch(/^A person can use Retry on this task/);
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toContain("Agents cannot retry it for them.");
  });

  it("shows plain wording and Retry for a finalization deadline saved by the previous release", async () => {
    const previousReleaseText = "Inspect the failed run and verify its provider has stopped. Reconcile any uncertain external action before explicitly continuing this task.";
    const f = await fixture({ runtimeMode: "native", errorCode: "execution_finalization_deadline_exceeded",
      error: previousReleaseText, nextAction: previousReleaseText });
    await db.update(issueRecoveryActions).set({ cause: "execution_finalization_deadline_exceeded", ownerType: "board",
      nextAction: previousReleaseText }).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));

    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);

    expect(blocker).toMatchObject({ canRetry: true, runError: EXECUTION_FINALIZATION_DEADLINE_MESSAGE,
      nextAction: `${EXECUTION_FINALIZATION_DEADLINE_MESSAGE} ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    expect(JSON.stringify(blocker)).not.toMatch(/Inspect the failed run|verify its provider|Reconcile any uncertain/);
  });

  it("retains the claimed adapter and startup receipts for a cancelled pre-provider run", async () => {
    const f = await fixture({ status: "cancelled", startedAt: null, errorCode: "operator_interrupted",
      resultJson: { startupCancellation: { beforeNativeSelection: true }, startupPreparationSettledAt: "2020-01-01T00:01:00Z" } });
    expect(await compare(f)).toMatchObject({ canRetry: true, canContinue: false });
    await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: false });
  });

  it.each(["valid", "number", "missing"])("preserves typed pre-dispatch interaction evidence (%s)", async kind => {
    const context = { source: "connection_intent.resolved", connectionIntentResolution: "existing_connection",
      interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction",
      ...(kind === "missing" ? {} : { interactionId: kind === "valid" ? randomUUID() : 42 }) };
    const f = await fixture({ status: "cancelled", errorCode: "issue_waiting_for_response", contextSnapshot: context,
      resultJson: { stopReason: "issue_waiting_for_response", timeoutSource: "stale_queued_run_gate",
        preDispatchResponseWait: { version: 1, providerWorkStarted: false } } });
    expect(await compare(f)).toMatchObject({ canRetry: kind === "valid" });
  });

  it.each([true, false])("preserves native no-workspace evidence and cwd presence (%s)", async hasCwd => {
    const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
      workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
    });
    const input = { schema: "paperclip.native-execution-input.v6",
      binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
      provider: { kind: "grok_bot" }, workspace: { access: "none", ...(hasCwd ? { cwd: null } : {}) },
      task: { description: randomBytes(128 * 1024).toString("base64") },
      runtimeContext: { instructions: randomBytes(128 * 1024).toString("base64") } };
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
      runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: input } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await compare(f)).toMatchObject({ workspaceRepairRequired: !hasCwd, canRetry: false });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(stored.runnerProfileJson?.nativeExecutionInput).toEqual(input);
  });

  it.each(["run", "company", "agent", "issue", "provider", "schema", "access", "workspace", "binding", "missing_binding",
    "null_input", "array_input", "scalar_input", "number_input"])(
    "does not relax native workspace recovery for invalid input (%s)", async kind => {
      const f = await fixture({ runtimeMode: "native", driverKind: "grok_bot_mcp" }, {
        workspaceRestoreFailure: "restore_unsafe_archive",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
      });
      const input: Record<string, unknown> = {
        schema: "paperclip.native-execution-input.v6",
        binding: { runId: f.run.id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId },
        provider: { kind: "grok_bot" }, workspace: { access: "none", cwd: null },
        task: { description: randomBytes(128 * 1024).toString("base64") },
      };
      const binding = input.binding as Record<string, unknown>;
      if (kind === "run") binding.runId = randomUUID();
      if (kind === "company") binding.companyId = randomUUID();
      if (kind === "agent") binding.agentId = randomUUID();
      if (kind === "issue") binding.issueId = randomUUID();
      if (kind === "provider") input.provider = { kind: "codex" };
      if (kind === "schema") input.schema = "unsupported";
      if (kind === "access") input.workspace = { cwd: null };
      if (kind === "workspace") input.workspace = "none";
      if (kind === "binding") input.binding = [];
      if (kind === "missing_binding") delete input.binding;
      const selectedInput = kind === "null_input" ? null : kind === "array_input" ? []
        : kind === "scalar_input" ? "input" : kind === "number_input" ? 42 : input;
      await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId,
        runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: selectedInput } }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await compare(f)).toMatchObject({ workspaceRepairRequired: true, canRetry: false });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].runnerProfileJson?.nativeExecutionInput).toEqual(selectedInput);
    },
  );

  // A chat's saved files were recovered, but its conversation is held: a new
  // message is refused the same way, so the blocker must not offer one.
  async function recoveredRefusal(patch: Partial<typeof heartbeatRuns.$inferInsert>, status = "recovered") {
    const f = await fixture({ runtimeMode: "native", ...patch });
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issueRecoveryActions).set({ cause: "native_continuation_requires_reconciliation",
      nextAction: "The original sandbox is retained for workspace repair.",
      evidence: { runId: f.run.id, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [] },
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.run.id, status,
          stage: "saving_receipts", attempt: 1, requestIds: [] } } })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    return f;
  }
  const generic = "Saved work recovered. Send a message to continue.";
  // The durable notice exactly as the executor writes it (noticeHeldUnfinishedPredecessor).
  async function heldNotice(f: Awaited<ReturnType<typeof recoveredRefusal>>, sessionId: string) {
    await db.transaction(tx => writePiSessionHistoryLossNotice(db, tx, { companyId: f.companyId, issueId: f.issueId,
      runId: f.run.id, agentId: f.agentId, authorizationReason: `native_prior_owner_held:${sessionId}`,
      body: HELD_PREDECESSOR_NOTICE }));
  }
  async function committedSuccess(f: Awaited<ReturnType<typeof recoveredRefusal>>, sessionId: string) {
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: later.id, phase: "committed" });
  }
  const ordinary = { errorCode: "native_continuation_requires_reconciliation", error: "Fixture failure" };

  it("shows the held conversation's notice instead of offering a message", async () => {
    const sessionId = randomUUID();
    const f = await recoveredRefusal({ ...ordinary, nativeSessionId: sessionId });
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toBe(generic);
    await heldNotice(f, sessionId);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.run.id, canContinue: false, workspaceRecovery: { status: "recovered" } });
    expect(blocker!.nextAction).toBe(HELD_PREDECESSOR_NOTICE);
    expect(blocker!.nextAction).not.toMatch(/send a message to continue/i);
    // A success on another conversation (a new task) does not clear it.
    await committedSuccess(f, randomUUID());
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toBe(HELD_PREDECESSOR_NOTICE);
    // A later committed success on the same conversation supersedes it.
    await committedSuccess(f, sessionId);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toBe(generic);
  });

  it("does not call files kept before they are recovered, even with a held notice", async () => {
    const sessionId = randomUUID();
    const f = await recoveredRefusal({ ...ordinary, nativeSessionId: sessionId }, "recovering");
    await heldNotice(f, sessionId);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toBe("Recovering saved work…");
  });

  // Runs saved before the held notice existed: the run's own refusal code.
  it.each([
    { errorCode: "native_continuation_requires_reconciliation", error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" },
    { errorCode: "native_continuation_requires_reconciliation", error: "native_controller_recovery_unsupported:metadata_format" },
    { errorCode: "adapter_failed", error: "native_controller_recovery_unsupported:metadata_format" },
    { errorCode: "native_session_cleanup_quarantined", error: "Fixture failure" },
    { errorCode: "adapter_failed", error: "runner_process_termination_unconfirmed" },
    { errorCode: "adapter_failed", error: "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=true" },
    { errorCode: "native_continuation_requires_reconciliation", error: "runner_state_identity_mismatch: prior_owner_active" },
    { errorCode: "native_continuation_requires_reconciliation", error: "runner_state_identity_mismatch: prior_owner_scope_mismatch" },
    { errorCode: "adapter_failed", error: "runner_state_identity_mismatch: legacy_prior_owner_terminal_state_indeterminate" },
    { errorCode: "native_runner_warm_attachment_runner_exited", error: "Fixture failure" },
    { errorCode: "adapter_failed", error: "native_runner_warm_attachment_runner_exited: runner process ended" },
  ])("does not offer a message when the conversation was refused ($errorCode, $error)", async patch => {
    const f = await recoveredRefusal(patch);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.run.id, canRetry: false, canContinue: false,
      workspaceRecovery: { status: "recovered" } });
    expect(blocker!.nextAction).not.toMatch(/send a message to continue/i);
    expect(blocker!.nextAction).toBe(HELD_PREDECESSOR_NOTICE);
  });

  it("shows the notice text, without Retry, for a successor refused behind a succeeded owner that wrote no notice", async () => {
    const sessionId = randomUUID();
    const f = await recoveredRefusal({ errorCode: "native_continuation_requires_reconciliation",
      error: "runner_state_identity_mismatch: prior_owner_active", nativeSessionId: sessionId });
    // The prior owner on the same conversation committed a success before the successor was refused.
    const [owner] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: sessionId, contextSnapshot: { issueId: f.issueId },
      createdAt: new Date("2019-12-31T23:00:00Z"), finishedAt: new Date("2019-12-31T23:30:00Z") }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: owner.id, phase: "committed" });
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ runId: f.run.id, canContinue: false, canRetry: false, workspaceRecovery: { status: "recovered" } });
    expect(blocker!.nextAction).toBe(HELD_PREDECESSOR_NOTICE);
    expect(blocker!.nextAction).not.toContain(EXECUTION_BLOCKER_PERSON_RETRY_ACTION);
  });

  it("does not offer Retry while a held conversation's notice still stands", async () => {
    const sessionId = randomUUID();
    // A failed run a person could otherwise retry.
    const f = await fixture({ runtimeMode: "native", nativeSessionId: sessionId });
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
    await heldNotice(f, sessionId);
    const held = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(held).toMatchObject({ canRetry: false, canContinue: false });
    expect(held!.nextAction).toBe("Inspect the source run.");
    expect(held!.nextAction).not.toContain(EXECUTION_BLOCKER_PERSON_RETRY_ACTION);
    // A committed success on the same conversation supersedes the notice; Retry returns.
    await committedSuccess(f, sessionId);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true,
      nextAction: `Inspect the source run. ${EXECUTION_BLOCKER_PERSON_RETRY_ACTION}` });
  });

  it("keeps the ordinary recovered wording when the conversation was not refused", async () => {
    // The no-replay hold code alone is not a refusal.
    const f = await recoveredRefusal(ordinary);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: false, canContinue: false, workspaceRecovery: { status: "recovered" } });
    expect(blocker!.nextAction).toBe(generic);
  });

  it.each([null, [], "scalar", 42, { issueId: 42, taskId: false }].map(context => ({ context })))("preserves decisions for malformed context $context", async ({ context }) => {
    const f = await fixture({ contextSnapshot: context as Record<string, unknown> | null });
    expect(await compare(f)).toMatchObject({ canRetry: true });
  });
});
