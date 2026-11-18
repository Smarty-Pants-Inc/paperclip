import { randomUUID } from "node:crypto";
import { agents, authUsers, companies, completionContracts, createDb, environmentLeases, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
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
        if (writer === "sweep") expect(nextActionOf(notes[0]!)).toContain("Send a new message to try again.");
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
});
