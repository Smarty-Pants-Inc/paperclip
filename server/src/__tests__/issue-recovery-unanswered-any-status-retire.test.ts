import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, completionContracts, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_CARD_ANSWER_TEXT, UNANSWERED_MESSAGE_NO_REPLY_TEXT,
  UNANSWERED_MESSAGE_NO_RUN_TEXT, UNANSWERED_MESSAGE_TEXT } from "../services/recovery/unanswered-person-message.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

// Keep (never-OK rule: no false "wasn't answered" line stays on a thread whose input WAS answered). ANY-STATUS
// RETIREMENT, completed (rf-3 r3d item 3), reachable by the WORKER: every row below ends with the REAL recovery
// worker as the server wires it (heartbeat.registerIssueStateRecoveryWork -> work.ts register() -> the real
// heartbeat.reconcileStrandedAssignedIssues -> the real sweep step). No row settles a task directly after the
// answer: the worker must LOAD the done / cancelled task by itself.
// - (a) a MIXED group notice on a done or cancelled task: one member answered -> the notice stays and its metadata
//   names only the still-owed member; then all answered -> it retires;
// - (b) every notice family retires when its input is answered: failed run, no run, no reply, the waiting note of a
//   paused agent, and the card-answer notice (ruling 4), a mixed card-answer group included;
// - (c) the worktree execution cutoff (unanswered-person-message.ts settleOwedPersonMessages) does not block it.
// REAL: the notice is written by the real sweep step while the task is open; the task is closed by the real issue
// service (issueService.update); the card is answered by the real interaction service; one row's answer is the real
// accepted result published by the real finalizer. PLANTED (named in each helper): the person's message rows, the
// run rows, the reply rows of the family rows, the paused agent.
describeIssueRecovery("unanswered notices retire on ANY task status, every family (real recovery worker, real wiring)", () => {
  const state = issueRecoveryFixture();
  const { fixture } = state;
  const T = () => Date.now() - 20 * 60_000;

  async function seed(title: string) {
    const f = await fixture();
    const db = state.db;
    const t = T();
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title, status: "in_progress", assigneeAgentId: f.agentId,
      createdAt: new Date(t - 60_000) }).returning({ id: issues.id });
    const issueId = task!.id;
    /** PLANTED: a person's message row. */
    const message = async (ms: number, body = "Is the release out?") => (await db.insert(issueComments).values({ companyId: f.companyId, issueId, body,
      authorType: "user", authorUserId: "recovery-user", createdAt: new Date(t + ms) }).returning({ id: issueComments.id }))[0]!.id;
    /** PLANTED: a run whose OWN input names these messages (or the card answer `interactionId`). */
    const run = async (status: "failed" | "succeeded", own: string[], ms: number, context: Record<string, unknown> = {}) => (await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, status, runtimeMode: "native", nativeIssueId: issueId,
      ...(status === "failed" ? { errorCode: "adapter_failed", error: "adapter_failed: the model call failed" } : {}),
      contextSnapshot: { issueId, wakeReason: "issue_commented", ...(own.length ? { wakeCommentId: own.at(-1), wakeCommentIds: own } : {}), ...context },
      createdAt: new Date(t + ms), startedAt: new Date(t + ms + 500), finishedAt: new Date(t + ms + 1_000) }).returning({ id: heartbeatRuns.id }))[0]!.id;
    /** PLANTED: the reply a succeeded run published. */
    const reply = async (runId: string, at: Date) => db.insert(issueComments).values({ companyId: f.companyId, issueId, body: "Yes, it is out.",
      authorType: "agent", authorAgentId: f.agentId, createdByRunId: runId, createdAt: at });
    /** PLANTED answer: a succeeded run whose own input names exactly these inputs, and its reply. */
    const answer = async (own: string[], ms: number, context: Record<string, unknown> = {}) => {
      const id = await run("succeeded", own, ms, context); await reply(id, new Date(Math.max(t + ms + 1_000, Date.now()))); return id;
    };
    /** REAL: the sweep step writes the notice while the task is open. */
    const notice = async (expectedNoticed = 1, now = new Date()) =>
      expect(await settleUnansweredPersonMessagesForTask(db, { companyId: f.companyId, issueId, now }), "the real sweep step wrote the notice")
        .toEqual({ noticed: expectedNoticed, pending: 0 });
    const notices = () => db.select({ id: issueComments.id, deletedAt: issueComments.deletedAt, body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"),
        sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    /** REAL: the task is closed through the issue service. */
    const close = async (status: "done" | "cancelled") => {
      await issueService(db).update(issueId, { status });
      expect((await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe(status);
    };
    /** The REAL worker, as the server registers it; runs until it has nothing left to do. */
    const worker = async () => { if (state.worker) await state.restart(); else await state.start(); await state.settled(); };
    return { ...f, db, t, issueId, message, run, reply, answer, notice, notices, close, worker };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const live = async (f: Seed) => (await f.notices()).filter(n => n.deletedAt === null);

  const families: Array<[string, string, (f: Seed) => Promise<{ answer: () => Promise<unknown> }>]> = [
    ["failed run", UNANSWERED_MESSAGE_TEXT, async f => {
      const m = await f.message(0); await f.run("failed", [m], 1_000); await f.notice();
      return { answer: () => f.answer([m], 60_000) };
    }],
    ["no run", UNANSWERED_MESSAGE_NO_RUN_TEXT, async f => {
      const m = await f.message(0); await f.notice();
      return { answer: () => f.answer([m], 60_000) };
    }],
    ["no reply (a succeeded run that published nothing)", UNANSWERED_MESSAGE_NO_REPLY_TEXT, async f => {
      const m = await f.message(0); await f.run("succeeded", [m], 1_000); await f.notice();
      return { answer: () => f.answer([m], 60_000) };
    }],
    ["waiting note (the agent is paused)", "is paused. Your message is saved", async f => {
      const m = await f.message(0);
      await f.db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agentId)); // PLANTED pause
      await f.notice();
      expect(((await f.notices())[0]!.metadata as { sections: Array<{ rows: Array<{ label: string }> }> }).sections
        .some(section => section.rows.some(row => row.label === "Waiting code")), "a waiting-kind note").toBe(true);
      return { answer: async () => { await f.db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.agentId));
        await f.answer([m], 60_000); } };
    }],
    ["card answer (ruling 4)", UNANSWERED_CARD_ANSWER_TEXT, async f => {
      const { cardId } = await answeredCard(f);
      await f.run("failed", [], 120_000, { interactionId: cardId, interactionStatus: "answered", source: "issue.interaction.respond" });
      await f.notice(1, new Date(Date.now() + 11 * 60_000));
      expect((await f.notices())[0]!.metadata).toMatchObject({ authorizationReason: `unanswered_message:${cardId}` });
      return { answer: () => f.answer([], 180_000, { interactionId: cardId, interactionStatus: "answered" }) };
    }],
  ];
  /** A card the agent posted for M from a run that named M (PLANTED rows), answered by the person through the REAL
   * interaction service. */
  async function answeredCard(f: Seed, prompt = "Which scope?") {
    const m = await f.message(0);
    const source = await f.run("succeeded", [m], 1_000);
    const [card] = await f.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: source,
      kind: "ask_user_questions", status: "pending", createdByAgentId: f.agentId, addresseeUserId: "recovery-user", continuationPolicy: "none",
      payload: { version: 1, questions: [{ id: "scope", prompt, required: true, selectionMode: "single",
        options: [{ id: "first", label: "First" }] }] } as never }).returning({ id: issueThreadInteractions.id });
    await issueThreadInteractionService(f.db).answerQuestions({ id: f.issueId, companyId: f.companyId }, card!.id,
      { answers: [{ questionId: "scope", optionIds: ["first"] }] } as never, { userId: "recovery-user" });
    return { m, cardId: card!.id };
  }

  for (const status of ["done", "cancelled"] as const) {
    it.each(families)(`(b) %s notice, the input is answered, the task is ${status} -> the worker retires it`, async (_family, text, build) => {
      const f = await seed(`Family row, ${status}`);
      const { answer } = await build(f);
      const [before] = await live(f);
      expect(before!.body, "the family's own words").toContain(text);
      await answer();
      await f.close(status);
      expect(await live(f), "still live before the worker's pass (nothing settled it directly)").toHaveLength(1);
      await f.worker();
      const all = await f.notices();
      expect(all, "no second notice").toHaveLength(1);
      expect(all[0]!.deletedAt, `the answered input's notice retired on the ${status} task`).not.toBeNull();
    });

    it(`(a) MIXED group notice on a ${status} task: one member answered -> it stays and names only the still-owed member; all answered -> it retires`, async () => {
      const f = await seed(`Mixed group, ${status}`);
      const m1 = await f.message(0, "First question"), m2 = await f.message(500, "Second question");
      await f.run("failed", [m1, m2], 1_000);
      await f.notice();
      expect((await live(f))[0]!.metadata, "ONE group notice for the two messages the failed run carried").toMatchObject({
        unansweredMessageIds: [m1, m2], authorizationReason: `unanswered_message:${m2}` });
      await f.answer([m2], 60_000); // the LATER member is answered: the notice's key must move to the still-owed one
      await f.close(status);
      await f.worker();
      const shrunk = await f.notices();
      expect(shrunk, "the one notice").toHaveLength(1);
      expect(shrunk[0]!.deletedAt, "a still-owed member: the notice STAYS").toBeNull();
      expect(shrunk[0]!.metadata, "and names only the still-owed member").toMatchObject({
        unansweredMessageIds: [m1], authorizationReason: `unanswered_message:${m1}` });
      await f.answer([m1], 120_000);
      await f.worker();
      const retired = await f.notices();
      expect(retired, "never a second notice").toHaveLength(1);
      expect(retired[0]!.deletedAt, "all members answered: the notice retired").not.toBeNull();
    });

    it(`(a)+(b) MIXED card-answer group on a ${status} task: one answer acted on -> the notice stays for the other answer; both -> it retires`, async () => {
      const f = await seed(`Mixed card group, ${status}`);
      const first = await answeredCard(f, "Which scope?");
      const [second] = await f.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        sourceRunId: (await f.db.select({ id: issueThreadInteractions.sourceRunId }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, first.cardId)))[0]!.id,
        kind: "ask_user_questions", status: "pending", createdByAgentId: f.agentId, addresseeUserId: "recovery-user", continuationPolicy: "none",
        payload: { version: 1, questions: [{ id: "scope", prompt: "Which region?", required: true, selectionMode: "single",
          options: [{ id: "first", label: "First" }] }] } as never }).returning({ id: issueThreadInteractions.id });
      await issueThreadInteractionService(f.db).answerQuestions({ id: f.issueId, companyId: f.companyId }, second!.id,
        { answers: [{ questionId: "scope", optionIds: ["first"] }] } as never, { userId: "recovery-user" });
      // PLANTED: one failed run carried BOTH answers as its own input (a carry's interactionIds).
      await f.run("failed", [], 120_000, { interactionIds: [first.cardId, second!.id], interactionId: second!.id });
      await f.notice(1, new Date(Date.now() + 11 * 60_000));
      const [group] = await live(f);
      const members = (group!.metadata as { unansweredMessageIds?: string[] }).unansweredMessageIds;
      expect(members?.slice().sort(), "ONE group notice for the two answers the failed run carried").toEqual([first.cardId, second!.id].sort());
      await f.answer([], 180_000, { interactionId: first.cardId });
      await f.close(status);
      await f.worker();
      const shrunk = await f.notices();
      expect(shrunk, "the one notice").toHaveLength(1);
      expect(shrunk[0]!.deletedAt, "the other answer is still owed: the notice STAYS (it is not retired with the first answer's reply)").toBeNull();
      expect(shrunk[0]!.metadata).toMatchObject({ unansweredMessageIds: [second!.id], authorizationReason: `unanswered_message:${second!.id}` });
      await f.answer([], 240_000, { interactionId: second!.id });
      await f.worker();
      expect((await f.notices()).map(n => n.deletedAt === null), "both answered: retired, never a second notice").toEqual([false]);
    });
  }

  it("REAL answer path: the run's accepted result is published by the real finalizer, the task is closed done -> the worker retires the notice", async () => {
    const f = await seed("Real answer path");
    const m = await f.message(0); await f.run("failed", [m], 1_000); await f.notice();
    // REAL producers (as person-message-answer.accepted-published.test.ts): completeRun writes the accepted result,
    // finalizeNativeRun commits it and publishes the reply. The run row itself is planted.
    const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    const [contract] = await f.db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Answer", criteria: [] },
      canonicalSha256: `any-status-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await f.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, runnerInstanceId: runnerId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId, source: "assignment", wakeReason: "issue_commented", wakeCommentId: m } });
    await f.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const port = new NativeRunCoordinatorStore(f.db, { companyId: f.companyId, issueId: f.issueId, runId, agentId: f.agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary: "The release is out.",
      blocker: { reasonCode: "access", owner: { kind: "user", name: "Board operator" }, unblockAction: "Confirm the notes", scope: "task_wide" },
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "blocked" },
      turnId: "answer-turn" });
    await finalizeNativeRun({ db: f.db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true, preserveProviderAttempt: true });
    expect(await f.db.select({ body: issueComments.body }).from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.createdByRunId, runId))), "the real finalizer published the reply").toEqual([{ body: "The release is out." }]);
    await f.close("done");
    expect(await live(f), "still live before the worker's pass").toHaveLength(1);
    await f.worker();
    expect((await f.notices()).map(n => n.deletedAt === null)).toEqual([false]);
  });

  it.each(["in_progress", "done"] as const)(
    "(c) a %s task created BEFORE the worktree execution cutoff: its answered notice still retires; nothing new is noticed there", async status => {
    const f = await seed(`Before the cutoff, ${status}`);
    const m = await f.message(0); await f.run("failed", [m], 1_000); await f.notice();
    await f.answer([m], 60_000);
    // A second, still-owed message with no notice on the same task: the cutoff must keep it un-noticed.
    if (status === "in_progress") await f.message(120_000, "And the changelog?");
    else await f.close("done");
    // REAL cutoff: a worktree runtime whose run execution was activated NOW (instance settings), so this task is older.
    const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "any-status-retire" };
    await instanceSettingsService(f.db, { runtimeEnv }).updateExperimental({ enableWorktreeRunExecution: true });
    state.heartbeat = heartbeatService(f.db, { runtimeEnv });
    await f.worker();
    const all = await f.notices();
    expect(all, "no new notice on a task older than the cutoff").toHaveLength(1);
    expect(all[0]!.deletedAt, "the answered message's notice retired despite the cutoff").not.toBeNull();
  });
});
