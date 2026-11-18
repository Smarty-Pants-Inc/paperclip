import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE, noticeHeldUnfinishedPredecessor } from "./native-session-executor.js";
import { readUnsupersededHeldConversationNotice } from "./pi-session-recovery-notice.js";
import { HELD_PREDECESSOR_NEW_TASK_ACTION, HELD_PREDECESSOR_SEND_NOTICE } from "./held-predecessor-notice-text.js";
import { settleUnansweredPersonMessagesForTask } from "../recovery/unanswered-person-message.js";
import { heldConversationRemedy } from "../held-conversation-remedy.js";
import { subscribeAllCompanyLiveEvents, subscribeCompanyLiveEvents, subscribeGlobalLiveEvents } from "../live-events.js";
import { sql } from "drizzle-orm";
import { HELD_PREDECESSOR_SEND_ACTION } from "./held-predecessor-notice-text.js";
import { UNANSWERED_MESSAGE_NEW_TASK_TEXT, UNANSWERED_MESSAGE_TEXT } from "../recovery/unanswered-person-message.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { readStandingRunNotice } from "../standing-run-notice.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { instanceSettingsService } from "../instance-settings.js";
import { heartbeatService, type HeartbeatServiceOptions } from "../heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../heartbeat/run-admission.js";
import { closeIdleWarmNativeSessionsForRestart } from "./native-session-executor.js";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";

it.each([
  "runner_harness_state_mismatch: backup_without_reusable_lease",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding",
])("D10b leaves typed refusal notices exclusively to proven-stop disposition (%s)", async code => {
  const select = vi.fn(() => { throw new Error("Legacy notice owner must not read"); });
  await noticeHeldUnfinishedPredecessor({ db: { select } as never, execution: {} as never },
    Object.assign(new Error(code), { code }));
  expect(select).not.toHaveBeenCalled();
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("held predecessor notice writer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("held-predecessor-notice-writer-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["runner_state_identity_mismatch: legacy_prior_owner_terminal_state_indeterminate",
    "native_runner_warm_attachment_runner_exited: runner exited before authority rotation"])("holds visibly on %s", async message => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held refusal", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    for (const status of ["failed", "running"] as const) {
      await new Promise(resolve => setTimeout(resolve, 5));
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId }).returning();
      if (status === "running") await noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
        binding: { companyId, agentId, issueId, runId: row!.id }, session: { normalizedSessionId: sessionId } } as never }, new Error(message));
    }
    const notices = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => String((comment.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
        === `native_prior_owner_held:${sessionId}`);
    expect(notices).toHaveLength(1);
    // RFL 20:36Z: a note the person must read is written open, not folded behind a chevron.
    expect(notices[0]!.presentation).toMatchObject({ kind: "system_notice", detailsDefaultOpen: true });
  });

  // S6 (rf5 round 2): after a PERSON's Stop the held writer wrote H, whose
  // "Send a new message to try again" invites a retype answered twice. It writes
  // R3 then. Controls: a non-person cancel and the Send's interrupt stop keep H.
  it.each(["person stop", "system cancel", "interrupt stop"] as const)("SCREEN S6: the held writer after a %s", async cause => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held stop", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    const resultJson = cause === "system cancel" ? { stopReason: "execution_reconciliation_required" }
      : { cancelledByActorType: "user", cancelledByUserId: "owner", ...(cause === "interrupt stop" ? { queuedCommentInterruptQueueId: randomUUID() } : {}) };
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: sessionId, resultJson });
    await new Promise(resolve => setTimeout(resolve, 5));
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: sessionId }).returning();
    await noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
      binding: { companyId, agentId, issueId, runId: row!.id }, session: { normalizedSessionId: sessionId } } as never },
    new Error("runner_process_termination_unconfirmed: stop not confirmed"));
    const notices = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => String((comment.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
        === `native_prior_owner_held:${sessionId}`);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(cause === "person stop"
      ? "Stopped. This message is waiting and will be sent when you send your next message. Send it now, or delete it."
      : HELD_PREDECESSOR_NOTICE);
    expect(notices[0]!.body.toLowerCase().includes("send a new message")).toBe(cause !== "person stop");
  });


  // RF5 held-note truth (rf-5 RF5-HELDNOTE-RESULT §2): BOTH held writers name the remedy by ONE rule. The default
  // is the new task (true in all 24 states); "Send a new message" only where the comment route's own explicit
  // continuation admission admits a new message (V02/V13: recorded local PID absent, no other hold).
  const HELD_STATES = ["missing_identity", "dead_pid", "controller", "live_pid", "legacy_unknown", "remote_unconfirmed",
    "restore_unsafe", "retained_result", "prior_cancelled", "prior_interrupted", "prior_timed_out", "quarantined"] as const;
  type HeldState = typeof HELD_STATES[number];
  const vRow = (kind: "chat" | "task", state: HeldState) => {
    const i = HELD_STATES.indexOf(state);
    return `V${String(state === "quarantined" ? (kind === "chat" ? 23 : 24) : (kind === "chat" ? 1 : 12) + i).padStart(2, "0")}`;
  };
  const QUARANTINE = "native_session_cleanup_quarantined:provider_close_unconfirmed";
  const PRIOR_OWNER = "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate";
  async function seedHeld(kind: "chat" | "task", state: HeldState) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID(), userId = `held-${randomUUID()}`;
    const error = state === "quarantined" ? QUARANTINE : PRIOR_OWNER;
    await db.insert(authUsers).values({ id: userId, name: "Held person", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Held truth", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "cold" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held truth", status: "in_progress", assigneeAgentId: agentId,
      ...(kind === "chat" ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" as const } : {}) });
    const t = Date.now() - 3_600_000;
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Earlier request that received no answer", createdAt: new Date(t) }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runtimeMode: state === "legacy_unknown" ? "legacy" : "native",
      status: state.startsWith("prior_") ? state.slice(6) as "cancelled" : "failed",
      startedAt: new Date(t + 1000), finishedAt: new Date(t + 2000), createdAt: new Date(t + 500), errorCode: error.split(":")[0], error,
      contextSnapshot: { issueId, wakeCommentId: message!.id },
      processPid: ["dead_pid", "quarantined", "legacy_unknown"].includes(state) ? 999_999_999 : state === "live_pid" ? process.pid : null,
      ...(state === "restore_unsafe" ? { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } } : {}) }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: source!.id, phase: "terminal_failure", failureCode: error,
      ...(state === "controller" ? { leaseOwner: "unverified-prior-controller" } : {}) });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "blocked", ownerType: "board", cause: "native_continuation_requires_reconciliation", fingerprint: `held-truth:${source!.id}`,
      nextAction: "Inspect the previous execution.", evidence: { runId: source!.id,
        ...(state === "restore_unsafe" ? { workspaceRestoreFailure: "restore_unsafe_archive" } : {}),
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: source!.id, replay: "blocked", actionOutcome: "unknown",
          recordedAt: new Date().toISOString() } } });
    if (state === "remote_unconfirmed") await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: source!.id,
      provider: "daytona", providerLeaseId: "held-truth-retained-box", status: "active", leasePolicy: "ephemeral" });
    if (state === "retained_result") {
      const contractId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "v1", policyVersion: "v1",
        risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "45".repeat(32),
        createdByActorType: "system", createdByActorId: "held-truth" });
      await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, source!.id));
      const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: source!.id, completionContractId: contractId,
        serverFingerprint: "held-truth", schemaStatus: "accepted", resultJson: { terminal: { runTerminalState: "succeeded" } },
        canonicalSha256: "held-truth" }).returning();
      await db.update(nativeRunFinalizations).set({ phase: "result_accepted", resultId: result!.id }).where(eq(nativeRunFinalizations.runId, source!.id));
    }
    return { companyId, agentId, issueId, sessionId, userId, error, sourceId: source!.id };
  }
  // The executor writes from the refused run's failure boundary. currentStatus "failed" is that refused run once it
  // has settled; "running" is the moment the executor calls the writer, where the admission says execution_active.
  async function writeHeld(f: Awaited<ReturnType<typeof seedHeld>>, writer: "executor" | "sweep",
    currentStatus: "failed" | "running" = "failed") {
    if (writer === "sweep") await settleUnansweredPersonMessagesForTask(db, { companyId: f.companyId, issueId: f.issueId, now: new Date() });
    else {
      const [current] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        nativeIssueId: f.issueId, nativeSessionId: f.sessionId, runtimeMode: "native", status: currentStatus, contextSnapshot: { issueId: f.issueId },
        ...(currentStatus === "failed" ? { startedAt: new Date(), finishedAt: new Date() } : {}) }).returning();
      await noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" }, binding: { companyId: f.companyId,
        agentId: f.agentId, issueId: f.issueId, runId: current!.id }, session: { normalizedSessionId: f.sessionId } } as never }, new Error(f.error));
    }
    return (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
      .filter(c => c.authorType === "system" && /^(native_prior_owner_held|unanswered_message):/.test(
        String((c.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")));
  }
  const nextActionOf = (note: { metadata: unknown }) => JSON.stringify(note.metadata ?? {});
  for (const writer of ["executor", "sweep"] as const) for (const kind of ["chat", "task"] as const) for (const state of HELD_STATES) {
    const admits = state === "dead_pid";
    it(`${vRow(kind, state)} ${writer} ${kind} ${state}: ${admits ? "admission admits, so 'Send a new message'"
      : "'Assign this agent a new task to continue.', never 'Send a new message'"}`, async () => {
      const notes = await writeHeld(await seedHeld(kind, state), writer);
      // The executor writes nothing behind a predecessor that kept a result (its existing early return).
      if (writer === "executor" && state === "retained_result") { expect(notes).toEqual([]); return; }
      expect(notes, `${writer} wrote the held notice`).toHaveLength(1);
      if (admits) {
        expect(notes[0]!.body).toBe(HELD_PREDECESSOR_SEND_NOTICE);
        if (writer === "sweep") expect(nextActionOf(notes[0]!)).toContain(HELD_PREDECESSOR_SEND_ACTION);
      } else {
        expect(notes[0]!.body).toBe(HELD_PREDECESSOR_NOTICE);
        expect(notes[0]!.body).toContain(HELD_PREDECESSOR_NEW_TASK_ACTION);
        expect(`${notes[0]!.body}\n${nextActionOf(notes[0]!)}`).not.toMatch(/send a new message/i);
        if (writer === "sweep") expect(nextActionOf(notes[0]!)).toContain(HELD_PREDECESSOR_NEW_TASK_ACTION);
      }
    });
  }

  it("V02/V13 executor while the refused run is still active: admission does not admit (execution_active) -> the new task", async () => {
    for (const kind of ["chat", "task"] as const) {
      const notes = await writeHeld(await seedHeld(kind, "dead_pid"), "executor", "running");
      expect(notes.map(note => note.body)).toEqual([HELD_PREDECESSOR_NOTICE]);
    }
  });

  // RFL 14:28Z: the remedy decision is a pure read. Run as each writer runs it (the executor on the database, the
  // sweep inside its own transaction), it leaves comments, wakes, queue entries, runs and their records byte-equal
  // and publishes no live event, whether admission admits (Send) or refuses (the new task).
  it("the remedy decision has no side effect: rows byte-equal before/after, no live event (both writers' paths)", async () => {
    const dump = async (companyId: string) => {
      const out: Record<string, string> = {};
      for (const table of ["issue_comments", "agent_wakeup_requests", "heartbeat_runs", "heartbeat_run_events",
        "issue_recovery_actions", "native_run_finalizations", "environment_leases", "issues", "activity_log"]) {
        const rows = await db.execute<{ row: string }>(sql`select row_to_json(t)::text as row from ${sql.identifier(table)} t
          where t.company_id = ${companyId} order by 1`);
        out[table] = rows.map(r => r.row).join("\n");
      }
      return out;
    };
    const events: unknown[] = [];
    const unsubscribe = [subscribeAllCompanyLiveEvents(e => events.push(e)), subscribeGlobalLiveEvents(e => events.push(e))];
    try {
      for (const path of ["executor", "sweep"] as const) for (const kind of ["chat", "task"] as const)
        for (const state of ["dead_pid", "quarantined", "controller"] as const) {
          const f = await seedHeld(kind, state);
          const mine: unknown[] = [];
          const off = subscribeCompanyLiveEvents(f.companyId, e => mine.push(e));
          const before = await dump(f.companyId);
          const remedy = path === "executor" ? await heldConversationRemedy(db, f)
            : await db.transaction(async tx => heldConversationRemedy(tx as unknown as typeof db, f));
          off();
          expect(remedy.newMessageAdmitted, `${path} ${kind} ${state}`).toBe(state === "dead_pid");
          expect(await dump(f.companyId), `${path} ${kind} ${state}: rows byte-equal`).toEqual(before);
          expect(mine, `${path} ${kind} ${state}: no company live event`).toEqual([]);
        }
      expect(events, "no live event on any stream").toEqual([]);
    } finally { for (const off of unsubscribe) off(); }
  });

  it("V02/V13 retire: the held banner stands until a later person message is REALLY answered (answeredPersonMessageSql)", async () => {
    for (const kind of ["chat", "task"] as const) {
      const f = await seedHeld(kind, "dead_pid");
      expect((await writeHeld(f, "executor"))[0]!.body).toBe(HELD_PREDECESSOR_SEND_NOTICE);
      await new Promise(resolve => setTimeout(resolve, 5));
      const [sent] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
        authorUserId: f.userId, body: "This is a NEW person message." }).returning();
      const [answering] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        nativeIssueId: f.issueId, nativeSessionId: randomUUID(), runtimeMode: "native", status: "succeeded",
        contextSnapshot: { issueId: f.issueId, wakeCommentId: sent!.id } }).returning();
      // Sent but not yet answered (a run alone is no answer): the banner still stands.
      expect(await readUnsupersededHeldConversationNotice(db, f)).not.toBeNull();
      await new Promise(resolve => setTimeout(resolve, 5));
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
        createdByRunId: answering!.id, body: "The answer." });
      expect(await readUnsupersededHeldConversationNotice(db, f), `${kind}: retired after a real answer`).toBeNull();
    }
  });

  it("writes one notice per hold: none while it stands, one new notice after the same session continued", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID(), contractId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held writer", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "45".repeat(32), createdByActorType: "system", createdByActorId: "fixture" });
    // Rows take the database clock in insertion order, like the notice itself.
    const run = async (status: "failed" | "running" | "succeeded", committed = false) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId, completionContractId: contractId }).returning();
      const [result] = committed ? await db.insert(nativeRunResults).values({ companyId, issueId, runId: row!.id,
        completionContractId: contractId, serverFingerprint: "fixture", schemaStatus: "accepted", resultJson: {},
        canonicalSha256: "fixture" }).returning() : [];
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: row!.id,
        phase: committed ? "committed" : "terminal_failure", resultId: result?.id ?? null });
      return row!.id;
    };
    // The executor's own refusal handling, for a message refused behind its unfinished predecessor.
    const refuse = (runId: string) => noticeHeldUnfinishedPredecessor({ db, execution: {
      provider: { kind: "pi_rpc" }, binding: { companyId, agentId, issueId, runId }, session: { normalizedSessionId: sessionId },
    } as never }, new Error("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate"));
    const notices = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => String((comment.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
        === `native_prior_owner_held:${sessionId}`);

    // Hold: the first refused message behind the failed predecessor posts the notice.
    await run("failed");
    const firstRefused = await run("running");
    await refuse(firstRefused);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]!.body).toBe(HELD_PREDECESSOR_NOTICE);
    // A second refusal while that notice stands adds none.
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, firstRefused));
    await refuse(await run("running"));
    expect(await notices()).toHaveLength(1);

    // The same session continues: a later run succeeds with a committed result.
    await run("succeeded", true);
    expect(await readUnsupersededHeldConversationNotice(db, { companyId, issueId })).toBeNull();

    // Held again: exactly ONE new notice, which stands again.
    await run("failed");
    const heldAgain = await run("running");
    await refuse(heldAgain);
    expect(await notices()).toHaveLength(2);
    expect(await readUnsupersededHeldConversationNotice(db, { companyId, issueId })).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, heldAgain));
    await refuse(await run("running"));
    expect(await notices()).toHaveLength(2);
  });
  // ---- heldnote r2b: the posted remedy stays TRUE in every later state, through the real comment route ----
  // A provider-only peer: the real heartbeat runs the new task's native run; this backend answers its one turn.
  const answeringPeer = (): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> => execution => {
    type Backend = ReturnType<NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]>>;
    type Session = Awaited<ReturnType<Backend["openSession"]>>;
    let identity: { runId: string; sessionId: string }; let sourceInstanceId = "";
    let resolveTurn!: (turnId: string) => void;
    const turn = { promise: new Promise<string>(resolve => { resolveTurn = resolve; }), resolve: (id: string) => resolveTurn(id) };
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const contract = execution.completionContract.contract as { revision: string; criteria: Array<{ id: string }> };
    const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The new task answered.",
      completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
        criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [] };
    const session = { identity: () => identity, capabilities: async () => capabilities,
      attachRun: async (input: { identity: typeof identity }) => { identity = input.identity; },
      startTurn: async () => { const turnId = randomUUID(); turn.resolve(turnId); return { turnId }; },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: string, payload: Record<string, unknown>) => ({ schema: "paperclip.prp.event.v1",
          sourceKind: "runner", sourceInstanceId, sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0,
          emittedAt: new Date().toISOString(), eventType, payload });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "The new task answered." });
        yield event(3, "run.result.proposed", result);
        yield event(4, "turn.completed", { status: "completed" });
      },
      result: async () => result,
      snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity, providerSessionId: "r2b-answering-peer",
        cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {} } as unknown as Session;
    return { descriptor: async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
      sourceInstanceId = run!.runnerInstanceId!;
      return { kind: "mock", name: "r2b-answering-peer", version: "1", capabilities,
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
    }, openSession: async (input: { identity: typeof identity }) => { identity = input.identity; return session; },
    recoverSession: async () => { throw new Error("only a fresh session is qualified"); } } as unknown as Backend;
  };
  const routeApp = async (userId: string, companyId: string) => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = { type: "board", source: "local_implicit", userId }; next(); });
    app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    return app;
  };
  const answered = async (commentId: string) => (await db.select({ answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`,
    companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
    .from(issueComments).where(eq(issueComments.id, commentId)))[0]?.answered;
  // A real POST of a new message on the held issue: 201, and its wake is deferred (no run admitted for it).
  const postDeferred = async (app: express.Express, f: { companyId: string; issueId: string }) => {
    const response = await request(app).post(`/api/issues/${f.issueId}/comments`)
      .send({ body: "A NEW message after the notice.", clientRequestId: randomUUID() });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    let wakes: Array<typeof agentWakeupRequests.$inferSelect> = [];
    for (let i = 0; i < 200 && !wakes.length; i++) {
      wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .filter(w => JSON.stringify(w.payload ?? {}).includes(response.body.id));
      if (!wakes.length) await new Promise(r => setTimeout(r, 25));
    }
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => JSON.stringify(r.contextSnapshot ?? {}).includes(response.body.id));
    return { id: response.body.id as string, wakes, runs };
  };
  // The new task remedy, through the real routes and the real heartbeat: create, message, run, answered.
  const newTaskAnswers = async (app: express.Express, f: { companyId: string; agentId: string }) => {
    const created = await request(app).post(`/api/companies/${f.companyId}/issues`)
      .send({ title: "New task remedy", description: "Answer the new message once.", status: "todo", assigneeAgentId: f.agentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sent = await request(app).post(`/api/issues/${created.body.id}/comments`)
      .send({ body: "Answer this NEW TASK message once.", clientRequestId: randomUUID() });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    await new Promise(r => setTimeout(r, 150));
    resetProcessRunAdmissionForTests();
    const hb = heartbeatService(db, { nativeSessionBackendFactory: answeringPeer() });
    try {
      await hb.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      for (let i = 0; i < 400 && !hb.getTaskDrainStatus().quiescent; i++) await new Promise(r => setTimeout(r, 50));
      for (let i = 0; i < 200 && !(await answered(sent.body.id)); i++) await new Promise(r => setTimeout(r, 50));
      await hb.drainActiveRunExecutions();
    } finally { await hb.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); closeProcessRunAdmission(); }
    return { issueId: created.body.id as string, messageId: sent.body.id as string, answered: await answered(sent.body.id) };
  };
  // A Send remedy standing without its hedge: the false remedy once a later hold defers new messages.
  const UNHEDGED_SEND = /send a new message to try again(?!; if it doesn't start, assign this agent a new task\.)/i;

  it("HN1: a posted Send note stays TRUE after a restore_unsafe hold: GET, card, standing reader and thread show no unhedged Send; a real POST is deferred and a new task answers (both writers)", async () => {
    closeProcessRunAdmission();
    try {
      for (const writer of ["executor", "sweep"] as const) for (const kind of ["task", "chat"] as const) {
        const label = `${writer} ${kind}`;
        const f = await seedHeld(kind, "dead_pid");
        await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.agentId));
        const app = await routeApp(f.userId, f.companyId);
        const notes = await writeHeld(f, writer);
        expect(notes.map(n => n.body), label).toEqual(["Your message and saved work are kept, but the previous run of this conversation "
          + "did not finish. Send a new message to try again; if it doesn't start, assign this agent a new task."]);
        // The state deteriorates after the note was posted: an unsafe-restore hold.
        await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } }).where(eq(heartbeatRuns.id, f.sourceId));
        const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
        await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence, workspaceRestoreFailure: "restore_unsafe_archive" } })
          .where(eq(issueRecoveryActions.id, hold!.id));
        expect((await heldConversationRemedy(db, f)).newMessageAdmitted, `${label}: the helper now refuses Send`).toBe(false);
        const get = await request(app).get(`/api/issues/${f.issueId}/comments`);
        expect(get.status, label).toBe(200);
        const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
        const card = await taskInterruptionPresentation(db, issue!);
        const standing = await readStandingRunNotice(db, f);
        const thread = (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).filter(c => c.authorType === "system");
        for (const [where, text] of [["GET", JSON.stringify(get.body)], ["card", JSON.stringify(card)],
          ["standing", JSON.stringify(standing)], ["thread", JSON.stringify(thread)]] as const) {
          expect(text, `${label} ${where}: no unhedged 'Send a new message to try again.'`).not.toMatch(UNHEDGED_SEND);
        }
        if (writer === "executor") expect(standing?.text, `${label}: the standing note names the new task`).toContain("assign this agent a new task");
        // The hedge is honest: the new message is saved (201) and deferred, and the new task answers.
        const post = await postDeferred(app, f);
        expect(post.runs, `${label}: no run admitted for the new message`).toEqual([]);
        expect(post.wakes.map(w => w.status), `${label}: deferred`).toEqual(["deferred_issue_execution"]);
        expect(JSON.stringify(post.wakes[0]!.payload), `${label}: workspace_repair_required`).toContain("workspace_repair_required");
        const remedy = await newTaskAnswers(app, f);
        expect(remedy.answered, `${label}: the new task answered`).toBe(true);
      }
    } finally { resetProcessRunAdmissionForTests(); }
  }, 240_000);

  // RF2 (RFL 14:57Z): on the LEGACY runtime a successor that failed adapter_failed leaves an execution blocker
  // (active_run_watchdog, legacy_execution_requires_reconciliation); dispatch defers every new message. The sweep's
  // "Sending it again is safe" notice takes its remedy from the ONE helper, which asks that blocker.
  // Named limit (RFL record SUPERSEDE-HELDNOTE-RF2-NEWTASK-1118): the legacy new task is shown unblocked, not
  // answered: this file has no process provider, so no run answers it here. Tracked with gold smarty-dev#21183.
  it("RF2: legacy (process) successor failed adapter_failed -> the sweep's notice and Next action say 'assign a new task', never 'safe'; a real POST is deferred; CONTROL native ordinary failure keeps its text", async () => {
    closeProcessRunAdmission();
    try {
      for (const runtime of ["legacy", "native"] as const) {
        const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `rf2-${randomUUID()}`;
        await db.insert(authUsers).values({ id: userId, name: "RF2 person", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
        await db.insert(companies).values({ id: companyId, name: "RF2 legacy", issuePrefix: `L${companyId.slice(0, 7)}` });
        await db.insert(agents).values({ id: agentId, companyId, name: `RF2 ${runtime} agent`, role: "engineer", status: "idle",
          ...(runtime === "legacy" ? { adapterType: "process", adapterConfig: { command: "true" } }
            : { adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "cold" } }),
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
        await db.insert(issues).values({ id: issueId, companyId, title: "RF2 task", status: "in_progress", assigneeAgentId: agentId });
        const app = await routeApp(userId, companyId);
        const t = Date.now() - 3_600_000;
        const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
          body: "M: a message delivered to the successor", createdAt: new Date(t) }).returning();
        // M delivered to a successor that actually started and failed adapter_failed.
        const [successor] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, runtimeMode: runtime,
          ...(runtime === "native" ? { nativeIssueId: issueId, nativeSessionId: randomUUID() } : {}),
          status: "failed", invocationSource: "on_demand", triggerDetail: "manual",
          startedAt: new Date(t + 1000), finishedAt: new Date(t + 2000), createdAt: new Date(t + 500),
          errorCode: "adapter_failed", error: "RF2 synthetic provider threw: adapter_failed",
          contextSnapshot: { issueId, wakeCommentId: message!.id } }).returning();
        const [hold] = runtime !== "legacy" ? [] : await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
          kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "legacy_execution_requires_reconciliation",
          fingerprint: `rf2:${successor!.id}`, nextAction: "The run stopped before it finished, and Paperclip cannot tell which of its "
            + "last actions took effect. Press Retry to continue the task in a fresh run; the agent checks those actions before repeating any.",
          evidence: { runId: successor!.id, adapterRecovery: "unsupported_or_unknown", originalFailure: "adapter_failed" } }).returning();
        const blocker = await getExecutionBlocker(db, companyId, issueId);
        expect(Boolean(blocker), `${runtime}: dispatch's execution blocker`).toBe(runtime === "legacy");
        await settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date() });
        const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
          .filter(c => c.authorType === "system" && String((c.metadata as Record<string, unknown> | null)?.authorizationReason ?? "")
            .startsWith("unanswered_message:"));
        expect(notes, `${runtime}: one notice`).toHaveLength(1);
        const shown = `${notes[0]!.body}\n${nextActionOf(notes[0]!)}`;
        if (runtime === "legacy") {
          expect(notes[0]!.body).toBe(UNANSWERED_MESSAGE_NEW_TASK_TEXT);
          expect(nextActionOf(notes[0]!)).toContain(`"Next action","value":"${HELD_PREDECESSOR_NEW_TASK_ACTION}"`);
          expect(shown).not.toMatch(/\bsafe\b/i);
          expect(shown).not.toMatch(/send the message again/i);
          // The new-task text is honest: a real POST of a new message is deferred behind the same blocker.
          const post = await postDeferred(app, { companyId, issueId });
          expect(post.runs, "legacy: no run admitted for the new message").toEqual([]);
          expect(post.wakes.map(w => w.status), "legacy: deferred").toEqual(["deferred_issue_execution"]);
          expect(post.wakes[0]!.payload?.executionWait, "legacy: deferred behind the legacy hold")
            .toMatchObject({ reason: "execution_recovery", recoveryActionId: hold!.id });
          // A new task for the agent is not behind this issue's blocker: its message is admitted, not deferred.
          const created = await request(app).post(`/api/companies/${companyId}/issues`)
            .send({ title: "RF2 new task", description: "Answer the new message.", status: "todo", assigneeAgentId: agentId });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          expect(await getExecutionBlocker(db, companyId, created.body.id), "legacy: the new task has no blocker").toBeNull();
        } else {
          // CONTROL: a native agent's ordinary failure (no blocker) keeps today's text.
          expect(notes[0]!.body).toBe(UNANSWERED_MESSAGE_TEXT);
          expect(notes[0]!.body, "CONTROL: the exact 'safe' text, pinned literally")
            .toBe("Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.");
          expect(nextActionOf(notes[0]!)).toContain("Send the message again; if it fails again, assign this agent a new task.");
        }
      }
    } finally { resetProcessRunAdmissionForTests(); }
  }, 120_000);
});
