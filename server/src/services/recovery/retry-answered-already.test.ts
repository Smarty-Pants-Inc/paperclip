import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { requestTaskRetry } from "../task-retry.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { readRetryAdmissionAuthority } from "../task-retry-eligibility.js";

// fam-retry3 ITEM A (RFL 20:33Z, R-ONCE): a Retry of a FAILED run whose person
// message a LATER run has already answered is a no-op with the true line
// "Already answered above." and no new run. The answer is the ONE shared
// ANSWERED predicate (person-message-answer.ts completedPersonMessageAnswerSql:
// a COMPLETED run's final answer through its own pending input, RFL F1/F2). Entry points: requestTaskRetry (what
// POST /api/issues/:id/retry calls) and taskInterruptionPresentation (the card).
const ALREADY_ANSWERED = "Already answered above.";

describe("fam-retry3: Retry of a failed run whose person message is already answered", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retry-answered-already-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /** testing-lead's live shape: the person's message m; run A carries it and
   * fails; successor B carries the same message and (answer = "final") posts its
   * final answer comment, or (answer = "cancelled") is cancelled having posted
   * nothing (partial output only), or (answer = "progress-failed") posted a
   * PROGRESS comment and then FAILED, or (answer = "none") there is no B. */
  async function seed(answer: "final" | "cancelled" | "progress-failed" | "none") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runA = randomUUID(), runB = randomUUID();
    const messageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Answered", defaultResponsibleUserId: "board", issuePrefix: `A${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" });
    const t0 = Date.now() - 10 * 60_000;
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Please summarise the report.", createdAt: new Date(t0) });
    const carries = { issueId, wakeCommentId: messageId, wakeCommentIds: [messageId] };
    await db.insert(heartbeatRuns).values({ id: runA, companyId, agentId, issueId, status: "failed", contextSnapshot: carries,
      errorCode: "adapter_failed", error: "adapter_failed", createdAt: new Date(t0 + 1_000), startedAt: new Date(t0 + 1_000),
      finishedAt: new Date(t0 + 60_000) });
    if (answer !== "none") {
      await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, issueId, status: answer === "final" ? "succeeded" : answer === "progress-failed" ? "failed" : "cancelled",
        contextSnapshot: { ...carries, retryOfRunId: runA }, createdAt: new Date(t0 + 120_000), startedAt: new Date(t0 + 120_000),
        finishedAt: new Date(t0 + 240_000), resultJson: answer === "cancelled" ? { partialOutput: "Here is the summ" } : {} });
      if (answer === "final") await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
        createdByRunId: runB, body: "Here is the summary of the report.", createdAt: new Date(t0 + 200_000) });
      if (answer === "progress-failed") await db.insert(issueComments).values({ companyId, issueId, authorType: "agent",
        authorAgentId: agentId, createdByRunId: runB, body: "Reading the report now; summary to follow.", createdAt: new Date(t0 + 150_000) });
    }
    const latestRunId = answer === "none" ? runA : runB;
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const wakes = async () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    return { companyId, agentId, issueId, runA, runB, latestRunId, messageId, issue, wakes };
  }
  const retry = (f: Awaited<ReturnType<typeof seed>>, observedRunId = f.latestRunId, idempotencyKey = randomUUID()) =>
    requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board", actorSource: "local_implicit",
      observedRunId, idempotencyKey });

  it("RED: the task Retry API on the answered message is a no-op with the line, saves no Retry and starts no run; a repeat refuses too", async () => {
    const f = await seed("final");
    const key = randomUUID();
    const answer = await retry(f, f.latestRunId, key);
    expect(answer).toMatchObject({ accepted: false, requestId: null,
      refused: { reason: "person_message_already_answered", message: ALREADY_ANSWERED } });
    expect(await f.wakes()).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(run => run.id).sort())
      .toEqual([f.runA, f.runB].sort());
    // The same click again: the same no-op (REFUSED_BEFORE_ADMISSION), never a replayed acceptance.
    expect(await retry(f, f.latestRunId, key)).toMatchObject({ accepted: false,
      refused: { reason: "person_message_already_answered", message: ALREADY_ANSWERED } });
    expect(await f.wakes()).toEqual([]);
  });

  it("RED: the one authority answers the same for Retry's source A (the chat Retry's failed run) and for the task's latest run", async () => {
    const f = await seed("final");
    for (const sourceRunId of [f.runA, f.runB, null]) {
      expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId }))
        .toMatchObject({ canRetry: false, reason: "person_message_already_answered", cardText: ALREADY_ANSWERED, nextAction: null });
    }
  });

  it("RED: the card for the failed run stops offering Retry once the message is answered and says the line", async () => {
    const f = await seed("final");
    // The card's run is the failed A (B's answer belongs to A's message): the
    // card reads the one authority for Retry's source.
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(heartbeatRuns.id, f.runB));
    const presentation = await taskInterruptionPresentation(db, await f.issue());
    expect(presentation).toMatchObject({ canRetry: false,
      retryWait: { reason: "person_message_already_answered", message: ALREADY_ANSWERED } });
  });

  /** rf-5 tA-min finding 3: M1's run R fails while M2 is held; a later run S
   * carries ONLY M2 and answers it (answer "m2-only"), or carries both and
   * answers both (control, "both"). */
  async function seedHeld(answer: "m2-only" | "both") {
    const f = await seed("none");
    const m2 = randomUUID(), runS = randomUUID(), t1 = Date.now() - 8 * 60_000;
    await db.insert(issueComments).values({ id: m2, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board",
      body: "And also list the open questions.", createdAt: new Date(t1) });
    const ids = answer === "both" ? [f.messageId, m2] : [m2];
    await db.insert(heartbeatRuns).values({ id: runS, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId, wakeCommentId: ids.at(-1), wakeCommentIds: ids }, createdAt: new Date(t1 + 120_000),
      startedAt: new Date(t1 + 120_000), finishedAt: new Date(t1 + 240_000), resultJson: {} });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: runS, body: "Here are the open questions.", createdAt: new Date(t1 + 200_000) });
    return { ...f, m2, runS, latestRunId: runS };
  }

  it("rf-5 tA-min finding 3: failed run R's M1 is NOT 'already answered' because a later run answered only the held M2", async () => {
    const f = await seedHeld("m2-only");
    for (const sourceRunId of [f.runA, f.runS, null]) {
      const authority = await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId });
      expect(authority.reason, String(sourceRunId)).not.toBe("person_message_already_answered");
      expect(authority.cardText ?? "", String(sourceRunId)).not.toContain(ALREADY_ANSWERED);
    }
    // The task's Retry names the latest run (the one that answered only M2): never the false no-op.
    const answer = await retry(f).catch(error => ({ error: String(error?.message ?? error) }));
    expect(answer).not.toMatchObject({ alreadyAnswered: true });
    expect(JSON.stringify(answer)).not.toContain(ALREADY_ANSWERED);
  });

  it("control (finding 3): once R's own M1 is ANSWERED too, the same Retry is 'Already answered above.'", async () => {
    const f = await seedHeld("both");
    for (const sourceRunId of [f.runA, f.runS, null]) {
      expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId }), String(sourceRunId))
        .toMatchObject({ canRetry: false, reason: "person_message_already_answered", cardText: ALREADY_ANSWERED });
    }
    expect(await retry(f)).toMatchObject({ accepted: false, alreadyAnswered: true,
      refused: { reason: "person_message_already_answered", message: ALREADY_ANSWERED } });
    expect(await f.wakes()).toEqual([]);
  });

  it("control (finding 3): a Retry run that answered R's M1 as attribution-only input makes the next Retry 'Already answered above.'", async () => {
    const f = await seedHeld("m2-only");
    const runT = randomUUID(), t2 = Date.now() - 3 * 60_000;
    await db.insert(heartbeatRuns).values({ id: runT, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry", attributionCommentIds: [f.messageId] }, createdAt: new Date(t2),
      startedAt: new Date(t2), finishedAt: new Date(t2 + 60_000), resultJson: {} });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: runT, body: "Here is the summary of the report.", createdAt: new Date(t2 + 30_000) });
    for (const sourceRunId of [f.runA, f.runS, runT, null]) {
      expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId }), String(sourceRunId))
        .toMatchObject({ canRetry: false, reason: "person_message_already_answered", cardText: ALREADY_ANSWERED });
    }
    expect(await retry(f, runT)).toMatchObject({ accepted: false, alreadyAnswered: true });
    expect(await f.wakes()).toEqual([]);
  });

  it("negative: an unanswered message still retries (accepted, a Retry saved)", async () => {
    const f = await seed("none");
    expect(await retry(f)).toMatchObject({ accepted: true });
    expect((await f.wakes()).filter(wake => wake.reason === "task_retry")).toHaveLength(1);
    expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runA }))
      .toMatchObject({ canRetry: true, reason: "retry" });
  });

  it("negative: a message 'answered' only by a cancelled run that posted no final answer still retries", async () => {
    const f = await seed("cancelled");
    expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runA }))
      .toMatchObject({ canRetry: true });
    expect(await retry(f)).toMatchObject({ accepted: true });
    expect((await f.wakes()).filter(wake => wake.reason === "task_retry")).toHaveLength(1);
  });

  it("negative (RFL F1): a run that posted a PROGRESS comment and then FAILED did not answer: the Retry still retries", async () => {
    const f = await seed("progress-failed");
    for (const sourceRunId of [f.runA, f.runB, null]) {
      expect(await readRetryAdmissionAuthority(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId }))
        .toMatchObject({ canRetry: true });
    }
    const answer = await retry(f);
    expect(answer).toMatchObject({ accepted: true });
    expect(JSON.stringify(answer)).not.toContain(ALREADY_ANSWERED);
    expect((await f.wakes()).filter(wake => wake.reason === "task_retry")).toHaveLength(1);
  });
});
