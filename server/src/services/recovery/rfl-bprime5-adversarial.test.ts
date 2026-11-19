import { randomUUID } from "node:crypto";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { settleConversationTurnForRun } from "../agent-conversations.js";
import { PaperclipControlPlanePort } from "../native-runtime/paperclip-control-plane-port.js";
import { recoveryService } from "./service.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition, unansweredPersonMessageCondition } from "./unanswered-person-message.js";

// Keep reason: recorded N1/SMAA-501/25-SILENT-BLOCK and a safety guard that can
// refuse publication. These are actual PostgreSQL/sweep/native-finalizer paths,
// not snapshots or mocked decision predicates. No provider or production I/O.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL Bprime5 independent attribution and bounded fallback", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("rfl-bprime5-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { if (db) await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await database?.cleanup(); });
  async function fixture(status = "blocked", chat = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `judge-${randomUUID()}`;
    const base = Date.now() - 600_000;
    await db.insert(companies).values({ id: companyId, name: "Independent Bprime5", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Production and staging", status, assigneeAgentId: agentId,
      responsibleUserId: userId, ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    const message = async (body: string, at: number, id = randomUUID()) => {
      await db.insert(issueComments).values({ id, companyId, issueId, body, authorType: "user", authorUserId: userId,
        createdAt: new Date(at), updatedAt: new Date(at) }); return id;
    };
    const run = async (messageId: string, at: number, carrying: Record<string, unknown> = { wakeCommentId: messageId }, status = "succeeded") => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", nativeIssueId: issueId, status,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", conversationSessionGeneration: 0, ...carrying },
        createdAt: new Date(at), startedAt: new Date(at), updatedAt: new Date(at + 30_000), finishedAt: new Date(at + 30_000),
        livenessState: "advanced" }).returning(); return row!.id;
    };
    const reply = async (runId: string, at: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
        createdByRunId: runId, body: "The production version is v8.", origin: "comment", createdAt: new Date(at), updatedAt: new Date(at) }).returning(); return row!.id;
    };
    const notices = async () => (await db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(row => row.metadata?.recoveryResponsibility !== "system");
    const flags = async () => ({
      discovered: (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId), unansweredPersonMessageCondition(issues.id, issues.companyId)))).length > 0,
      batched: (await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId), unansweredPersonMessageCommentCondition()))).length > 0,
    });
    const sweep = (worker = false) => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId,
      skipRelatedRecovery: true, skipExternalConversationSettlement: true, ...(worker ? { unanswered: true } : {}) });
    /** Per message, in the order given: how many times the ONE function counts it answered (1 or 0), by the product's SQL. */
    const answerCounts = async (...ids: string[]) => {
      const rows = await db.select({ id: issueComments.id, answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`,
        companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
        .from(issueComments).where(inArray(issueComments.id, ids));
      expect(rows, "every message row exists (a deleted row cannot pass)").toHaveLength(ids.length);
      return ids.map(id => rows.find(row => row.id === id)!.answered ? 1 : 0);
    };
    const agentReplies = async () => (await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "agent")))).length;
    return { companyId, agentId, issueId, userId, base, message, run, reply, notices, flags, sweep, answerCounts, agentReplies };
  }

  // Record row 9 (N1: 3 messages). OLD: the latest message only was owed; its notice covered it alone, the middle
  // message stayed silent. NEW: the first run's reply answers the first message only; the two later messages are
  // one no-run batch and ONE notice covers both (keyed to the latest, its list names both). Ruling: every owed
  // message keeps a true line until THAT message is answered; one notice per owed group (RFL ruling B).
  // count = 2 is the row as it was (one owed message, a group of one).
  for (const count of [2, 3]) it(count === 2 ? "N1: 2 messages before first prose; discovery and actual worker flag preserve latest message"
    : "supersedes(N1: 3 messages before first prose; discovery and actual worker flag preserve latest message; RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118)", async () => {
    const f = await fixture();
    const ids = [await f.message("Production version?", f.base)];
    const firstRun = await f.run(ids[0]!, f.base + 1_000);
    for (let i = 1; i < count; i++) ids.push(await f.message(`Question ${i + 1}`, f.base + i * 10_000));
    await f.reply(firstRun, f.base + 60_000);
    await settleConversationTurnForRun(db, f.companyId, firstRun);
    const [native] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(native).toMatchObject({ status: "in_progress", conversationState: "active" });
    // A held conversation has no automatic delivery path. Without the hold,
    // native conversation delivery correctly starts another run, so silence
    // while that run is live would not be an unanswered-message defect.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));
    expect(await f.flags()).toEqual({ discovered: true, batched: true });
    await f.sweep(true); await f.sweep(true);
    expect(await f.answerCounts(...ids), "the first run's reply answers the first message only").toEqual(count === 2 ? [1, 0] : [1, 0, 0]);
    const notices = await f.notices();
    expect(notices.map(n => n.metadata?.authorizationReason), "exactly ONE notice, keyed to the latest message").toEqual([`unanswered_message:${ids.at(-1)}`]);
    expect((notices[0]!.metadata as { unansweredMessageIds?: string[] }).unansweredMessageIds, "it covers every owed message").toEqual(count === 2 ? undefined : ids.slice(1));
    expect(ids.map(id => notices.filter(n => n.metadata?.authorizationReason === `unanswered_message:${id}`
      || ((n.metadata as { unansweredMessageIds?: string[] }).unansweredMessageIds ?? []).includes(id)).length),
      "notices covering each message: the answered first 0, every owed one exactly 1").toEqual(count === 2 ? [0, 1] : [0, 1, 1]);
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    expect(await f.flags()).toEqual({ discovered: false, batched: false });
    expect(await f.agentReplies(), "one agent reply").toBe(1);
  });

  const keys = ["wakeCommentId", "wakeCommentIds", "commentId", "conversationReplyBoundaryCommentId", "firstTurnQueuedInput"] as const;
  function carry(key: typeof keys[number], id: string) {
    return key === "wakeCommentIds" ? { [key]: [id] } : key === "firstTurnQueuedInput" ? { [key]: { commentIds: [id] } } : { [key]: id };
  }
  // RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118, rows 2-6, ruling row (b): a reply counts for message M only if its run's
  // OWN input names M; a reply to a LATER message never answers M.
  // OLD: the task is not flagged (discovered/batched false) and has no notice: the earlier message read as answered
  //   by the later message's reply.
  // NEW: exact answer counts [earlier, later] = [0, 1] from ONE agent reply; the earlier message is owed and gets its
  //   ONE notice; the later (answered) message gets none.
  // Control (still ANSWERED): the same run and reply with the earlier message in the run's own input too -> [1, 1],
  //   and the earlier message's notice is retired.
  for (const key of keys) it(`supersedes(attribution by ${key} answers the carried later message, not semantic analysis of prose; RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118)`, async () => {
    const f = await fixture();
    const first = await f.message("Production version?", f.base);
    const second = await f.message("Staging version?", f.base + 10_000);
    const run = await f.run(second, f.base + 11_000, carry(key, second));
    // Deliberately answers only the first question. Native finalization judges
    // a durable response and input boundary, not the semantic completeness.
    await f.reply(run, f.base + 40_000);
    await settleConversationTurnForRun(db, f.companyId, run);
    const [native] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    // F-B (RFL 23:59Z; rf-5 23:57Z): the chat's saved state follows the one function too. The earlier message is
    // owed (below: its ONE notice), so the Status row stays In Progress; it was "In Review" beside that notice.
    expect(native).toMatchObject({ status: "in_progress", conversationState: "active" });
    // The carried (latest) message is answered once; the earlier one, which the run's own input does not name, is owed.
    expect(await f.agentReplies()).toBe(1);
    expect(await f.answerCounts(first, second)).toEqual([0, 1]);
    expect(await f.flags()).toEqual({ discovered: true, batched: true });
    expect(await settleUnansweredPersonMessage(db, f)).toMatchObject({ kind: "noticed", code: "no_run" });
    await f.sweep();
    expect((await f.notices()).map(n => n.metadata?.authorizationReason), "ONE notice, the earlier message's; none for the answered one")
      .toEqual([`unanswered_message:${first}`]);
    expect(await f.flags()).toEqual({ discovered: false, batched: false });
    // Control: the same run and reply, with the earlier message in the run's own input too, answers both.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented",
      conversationSessionGeneration: 0, ...carry(key, second), ...(key === "wakeCommentIds" ? { wakeCommentIds: [first, second] }
        : { wakeCommentIds: [first] }) } }).where(eq(heartbeatRuns.id, run));
    expect(await f.answerCounts(first, second)).toEqual([1, 1]);
    expect(await f.flags()).toEqual({ discovered: true, batched: true }); // the earlier message's notice needs retiring
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
    expect(await f.notices()).toHaveLength(0);
    expect(await f.flags()).toEqual({ discovered: false, batched: false });
  });

  // RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118, row 7, ruling row (b).
  // OLD: a reply whose run named only the later (then soft-deleted) message retired the FIRST message's notice
  //   (flags true/true "notice needs retiring", settle answered, 0 notices).
  // NEW: that reply never answers the first message: answer count [first] = 0 with ONE agent reply on the task, the
  //   first message's ONE notice stays, nothing is flagged.
  // Control (still ANSWERED): a reply from a succeeded run whose own input names the first message -> count 1, and
  //   the notice is retired, by the same predicate in discovery, the worker flag and the settle.
  it("supersedes(supersession across a soft-deleted later carrying boundary uses the same predicate everywhere; RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118)", async () => {
    const f = await fixture();
    const first = await f.message("Production version?", f.base);
    await f.sweep(); const [notice] = await f.notices(); expect(notice?.metadata?.authorizationReason).toBe(`unanswered_message:${first}`);
    const second = await f.message("Staging version?", f.base + 10_000);
    const run = await f.run(second, f.base + 11_000, { conversationReplyBoundaryCommentId: second });
    await f.reply(run, f.base + 40_000);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, second));
    expect(await f.agentReplies()).toBe(1);
    expect(await f.answerCounts(first)).toEqual([0]);
    expect(await f.flags()).toEqual({ discovered: false, batched: false }); // the first message is still owed and has its notice
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    expect((await f.notices()).map(n => n.metadata?.authorizationReason)).toEqual([`unanswered_message:${first}`]);
    // A reply from a succeeded run whose own input names the first message retires it.
    const own = await f.run(first, f.base + 50_000);
    await f.reply(own, f.base + 80_000);
    expect(await f.answerCounts(first)).toEqual([1]);
    expect(await f.flags()).toEqual({ discovered: true, batched: true }); // notice needs retiring
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "answered" });
    expect(await f.notices()).toHaveLength(0);
    expect(await f.flags()).toEqual({ discovered: false, batched: false });
  });

  // Record row 10. OLD: before the first run's reply only the second (latest) message had a notice: 1 notice.
  // NEW: both messages are owed, in two groups (the first's reply-less run; the second with no run): 2 notices,
  // one each. The reply then answers the first message alone: it retires the first's notice, never the second's.
  // Ruling: every owed message keeps a true line until THAT message is answered; one notice per owed group.
  it("supersedes(unrelated first-message prose must not supersede the second message's existing notice; RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118)", async () => {
    const f = await fixture();
    const first = await f.message("Production version?", f.base);
    const run = await f.run(first, f.base + 1_000);
    const second = await f.message("Staging version?", f.base + 10_000);
    await f.sweep();
    expect(await f.answerCounts(first, second), "both owed").toEqual([0, 0]);
    expect((await f.notices()).map(n => n.metadata?.authorizationReason).sort(), "exactly two notices, one per message").toEqual([first, second].map(id => `unanswered_message:${id}`).sort());
    await f.reply(run, f.base + 40_000);
    expect(await f.answerCounts(first, second), "the reply answers the first only").toEqual([1, 0]);
    expect(await f.flags()).toEqual({ discovered: true, batched: true }); // the first message's notice needs retiring
    expect(await settleUnansweredPersonMessage(db, f)).toEqual({ kind: "noticed_before" });
    expect((await f.notices()).map(n => n.metadata?.authorizationReason), "exactly one notice left: the second's").toEqual([`unanswered_message:${second}`]);
    expect(await f.flags()).toEqual({ discovered: false, batched: false });
    expect(await f.agentReplies(), "one agent reply").toBe(1);
  });

  async function blockedResult(f: Awaited<ReturnType<typeof fixture>>, commentId: string, runId: string) {
    const contractId = randomUUID(), runnerInstanceId = randomUUID();
    const request = "Inspect the current attachment and report the result.";
    const sha = `judge-contract-${runId}`;
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v3", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "1", objective: request, criteria: [{ id: "objective", requirement: request }] },
      canonicalSha256: sha, createdByActorType: "system", createdByActorId: "judge" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, completionContractSha256: sha, nativeSessionId: runId,
      runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
    const port = new PaperclipControlPlanePort(db, { companyId: f.companyId, issueId: f.issueId, runId, agentId: f.agentId, sessionId: runId,
      completionContractId: contractId, completionContractSha256: sha, sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: `judge-${runId}` });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary: "The attachment could not be read.",
      blocker: { scope: "current_track", owner: { kind: "system", name: "Attachment access" }, reasonCode: "permission_denied",
        unblockAction: "Grant access to the attachment, then explicitly retry." },
      completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [{ criterionId: "objective", status: "not_satisfied", evidenceRefs: [] }],
        remainingWork: [{ description: request, blocksCompletion: true }] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "blocked" } });
    // The same persisted old-finalizer state as upstream's native-blocked repair tests.
    await db.update(nativeRunFinalizations).set({ phase: "committed", updatedAt: new Date(f.base + 60_000) }).where(eq(nativeRunFinalizations.runId, runId));
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
    expect(accepted?.schemaStatus).toBe("accepted");
    return { ...f, runId, commentId };
  }
  function repairPredicate() {
    return recoveryService(db, { enqueueWakeup: async () => { throw new Error("Judge forbids starting provider work"); } }).nativeBlockedRepairApplies;
  }

  for (const published of [false, true]) it(`25-SILENT-BLOCK: issue blocked, final words published=${published} => ${published ? "no" : "exactly one"} notice`, async () => {
    const f = await fixture("blocked");
    const message = await f.message("Inspect it.", f.base);
    const run = await f.run(message, f.base + 1_000);
    await blockedResult(f, message, run);
    if (published) await f.reply(run, f.base + 90_000);
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(published ? 0 : 1);
    if (!published) expect((await f.notices())[0]?.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
  });

  it("exception positive control: native repair publishes its unblock request once without a rival Bprime notice", async () => {
    const f = await fixture("in_progress", false);
    const message = await f.message("Inspect it.", f.base);
    const run = await f.run(message, f.base + 1_000, { wakeCommentId: message, wakeCommentIds: [message] });
    await blockedResult(f, message, run);
    expect(await repairPredicate()({ companyId: f.companyId, issueId: f.issueId, runId: run }, db)).toBe(true);
    await f.sweep(); await f.sweep();
    const [row] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(row?.status).toBe("blocked");
    const notices = await f.notices(); expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("Unblock request:");
    expect(notices[0]?.metadata?.authorizationReason).not.toBe(`unanswered_message:${message}`);
  });

  for (const refusal of ["edited-carried-message", "later-status-decision", "board-owned-hold-skips-repair"] as const) {
    it(`EXCEPTION MUST BE BOUNDED: real predicate true, ${refusal} prevents repair, no notice by 23h is a failure`, async () => {
      const f = await fixture("in_progress", false);
      const message = await f.message("Inspect it.", f.base);
      const run = await f.run(message, f.base + 1_000, { wakeCommentId: message, wakeCommentIds: [message] });
      const b = await blockedResult(f, message, run);
      if (refusal === "edited-carried-message") await db.update(issueComments).set({ body: "Inspect the corrected attachment.", updatedAt: new Date(f.base + 90_000) }).where(eq(issueComments.id, message));
      if (refusal === "later-status-decision") await db.update(issues).set({ lastStatusDecisionId: randomUUID() }).where(eq(issues.id, f.issueId));
      if (refusal === "board-owned-hold-skips-repair") await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "native_continuation_requires_reconciliation",
        fingerprint: `judge:${run}`, evidence: { runId: run }, nextAction: "Review the held run before continuing." });
      const predicate = repairPredicate();
      expect(await predicate(b, db)).toBe(true);
      expect(await f.flags()).toEqual({ discovered: true, batched: true });
      // Real sweeps cannot publish: their own native repair guard (or board-hold
      // early return) refuses. Simulated now below exercises the owner's exact
      // deadline decision without sleeping for a day or replacing its predicate.
      await f.sweep(); await f.sweep(); await f.sweep(true);
      const outcomes = [];
      for (const minutes of [0, 1, 10, 60, 23 * 60]) {
        const now = new Date(Date.now() + minutes * 60_000);
        const outcome = await settleUnansweredPersonMessage(db, { ...f, now, nativeBlockedRepairApplies: predicate });
        outcomes.push({ minutes, outcome, deltaMs: outcome.kind === "pending" ? outcome.recheckAt - now.getTime() : null });
      }
      const notices = await f.notices();
      const expired = await settleUnansweredPersonMessage(db, { ...f, now: new Date(Date.now() + 25 * 60 * 60_000), nativeBlockedRepairApplies: predicate });
      expect(await predicate(b, db)).toBe(true);
      console.log("BPRIME5_UNBOUNDED_EXCEPTION", JSON.stringify({ refusal, outcomes, visibleNotices: notices.length, realPredicateStillTrue: await predicate(b, db), after25h: expired }));
      expect(notices, "By 23 hours an unpublished native-repair promise must fall back to exactly one notice").toHaveLength(1);
      expect(notices[0]?.metadata?.authorizationReason).toBe(`unanswered_message:${message}`);
    });
  }
});
