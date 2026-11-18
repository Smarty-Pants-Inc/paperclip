// Keep (never-OK rule: no false "wasn't answered" line beside the agent's real published answer, and no silence
// for a message that got only partial text). RFL 23:13Z, record SUPERSEDE-ANSWERED-ACCEPTED-PUBLISHED-1118: the ONE
// function (answeredPersonMessageSql) also counts the run's ACCEPTED result, published once, whatever the run's
// later status. Old rule (person-message-answer.rows.test.ts row (a), which STAYS for its shape): a failed or
// cancelled run's reply never answers. New: it answers when the reply is THE comment the run's presentation
// decision recorded (result_json.presentationDecision.commentId) and the run has the accepted result row
// (native_run_results, schema_status 'accepted': id, canonical_sha256) its finalization committed.
// Real PostgreSQL. REAL producers: the accepted result is written by NativeRunCoordinatorStore.completeRun, the
// publication (the reply comment, presentationDecision.commentId) by finalizeNativeRun; the notice by the real
// sweep; the carry by readContinuationCommentInput. PLANTED, named in each row: the person's message row, the run
// row and the run's LATER status (failed / cancelled / timed_out after its result was published).
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
  nativeRunResults, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { NativeRunCoordinatorStore } from "./native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun } from "./native-runtime/native-run-finalizer.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";
import { settleUnansweredPersonMessagesForTask } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("ANSWERED: the run's accepted result, published once, whatever the run's later status", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("answered-accepted-published-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const summary = "The release is out: v4.2 went to production at 14:05.";
  /** A task, the person's message M and a native run whose OWN input names M (planted rows). */
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID();
    const t = Date.now() - 30 * 60_000;
    await db.insert(companies).values({ id: companyId, name: "Accepted published", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Releaser", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release", status: "in_progress", assigneeAgentId: agentId });
    const [m] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "board",
      body: "Is the release out?", createdAt: new Date(t) }).returning();
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Ship the release", criteria: [] },
      canonicalSha256: `accepted-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256,
      status: "running", runtimeMode: "native",
      contextSnapshot: { issueId, source: "assignment", wakeReason: "issue_commented", wakeCommentId: m!.id },
      createdAt: new Date(t + 1_000), startedAt: new Date(t + 2_000) });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    /** REAL producer: the run submits its result (accepted -> native_run_results) and the real finalizer commits it
     * and publishes it once (the reply comment + result_json.presentationDecision.commentId). */
    const acceptAndPublish = async () => {
      const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
        runnerSourceInstanceId: runnerId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256,
        completionContractRevision: "test", completionContractCriterionIds: [] });
      await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary,
        blocker: { reasonCode: "access", owner: { kind: "user", name: "Board operator" }, unblockAction: "Confirm the release notes",
          scope: "task_wide" },
        completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] },
        terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed",
          reportedWorkDisposition: "blocked" },
        turnId: "release-turn" });
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true, preserveProviderAttempt: true });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
      const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      const [reply] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "agent")));
      return { run: run!, accepted: accepted!, finalization: finalization!, reply: reply! };
    };
    const answered = async () => (await db.select({ answered: sql<boolean>`${answeredPersonMessageSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}` })
      .from(issueComments).where(eq(issueComments.id, m!.id)))[0]!.answered;
    const carried = async () => (await readContinuationCommentInput(db, { companyId, issueId, runId })).wakeCommentIds ?? [];
    /** The real sweep step, then the task's LIVE unanswered-message notices. */
    const notices = async () => {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId)); // the finalizer blocked the task; the sweep covers both
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId });
      return db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
        sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    };
    /** PLANTED: the run's LATER status, after its accepted result was published. */
    const later = (status: string, errorCode: string) => db.update(heartbeatRuns).set({ status, errorCode,
      error: status === "cancelled" ? null : `${errorCode}: the run ended after it published`, finishedAt: new Date(t + 120_000),
      updatedAt: new Date(t + 120_000) }).where(eq(heartbeatRuns.id, runId));
    return { companyId, issueId, agentId, runId, m: m!, t, acceptAndPublish, answered, carried, notices, later };
  }

  it("the real producers store what the rule keys on: an accepted result row and the published comment's id on the run", async () => {
    const f = await fixture();
    const p = await f.acceptAndPublish();
    expect(p.accepted, "native_run_results: the accepted result (resultId, canonicalSha256)").toMatchObject({
      schemaStatus: "accepted", id: expect.any(String), canonicalSha256: expect.stringMatching(/^sha256:/) });
    expect(p.finalization.resultId, "the finalization committed THAT result").toBe(p.accepted.id);
    expect((p.run.resultJson as Record<string, any>).presentationDecision, "published once: the decision names the comment")
      .toMatchObject({ commentAction: "create", commentId: p.reply.id });
    expect(p.reply).toMatchObject({ body: summary, createdByRunId: f.runId });
    // Real path, no planted status: the run as the real finalizer left it.
    expect(p.run.status).toBe("succeeded");
    expect(await f.answered()).toBe(true);
    expect(await f.notices(), "0 notices").toEqual([]);
  });

  it.each([["failed", "adapter_failed"], ["cancelled", "cancelled"], ["timed_out", "timeout"]])(
    "accepted result published, then the run is %s (planted later status) -> M is ANSWERED: 0 notices, not carried again", async (status, errorCode) => {
    const f = await fixture();
    await f.acceptAndPublish();
    await f.later(status, errorCode);
    expect.soft(await f.answered(), `published accepted result answers M though the run is ${status}`).toBe(true);
    expect.soft(await f.carried(), "the carry reads the same answer").toEqual([]);
    expect(await f.notices(), "no \"wasn't answered\" line beside the published answer").toEqual([]);
  });

  it("non-accepted text from a failed run -> M is still owed: exactly one notice, and it is carried again", async () => {
    // (1) partial text only: a failed run's own comment, no accepted result, no presentation decision (planted rows).
    const partial = await fixture();
    await db.insert(issueComments).values({ companyId: partial.companyId, issueId: partial.issueId, authorType: "agent",
      authorAgentId: partial.agentId, createdByRunId: partial.runId, body: "Checking the release pipeline...", createdAt: new Date(partial.t + 30_000) });
    await partial.later("failed", "adapter_failed");
    expect.soft(await partial.answered(), "partial text is not the accepted result").toBe(false);
    expect.soft(await partial.carried()).toEqual([partial.m.id]);
    expect.soft(await partial.notices(), "one notice").toHaveLength(1);

    // (2) a decision that names a comment, with NO accepted result behind it (planted): still owed.
    const noResult = await fixture();
    const [text] = await db.insert(issueComments).values({ companyId: noResult.companyId, issueId: noResult.issueId, authorType: "agent",
      authorAgentId: noResult.agentId, createdByRunId: noResult.runId, body: "Error: the model call failed.", createdAt: new Date(noResult.t + 30_000) }).returning();
    await noResult.later("failed", "adapter_failed");
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: text!.id } } })
      .where(eq(heartbeatRuns.id, noResult.runId));
    expect.soft(await noResult.answered(), "a recorded comment with no accepted result is not an answer").toBe(false);
    expect.soft(await noResult.notices(), "one notice").toHaveLength(1);

    // (3) the real accepted result IS published, and the failed run ALSO left another comment: only the published
    // comment answers. With the published one deleted, the other comment does not.
    const other = await fixture();
    const published = await other.acceptAndPublish();
    await other.later("failed", "adapter_failed");
    await db.insert(issueComments).values({ companyId: other.companyId, issueId: other.issueId, authorType: "agent",
      authorAgentId: other.agentId, createdByRunId: other.runId, body: "Leftover partial text.", createdAt: new Date() });
    expect.soft(await other.answered(), "control: the published accepted result answers").toBe(true);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, published.reply.id));
    expect.soft(await other.answered(), "the run's other comment is not its accepted result's publication").toBe(false);

    // (4) the result the run submitted was REJECTED (planted schema_status on the real row): its text is no answer.
    const rejected = await fixture();
    await rejected.acceptAndPublish();
    await rejected.later("failed", "adapter_failed");
    await db.update(nativeRunResults).set({ schemaStatus: "rejected", rejectionCode: "schema_invalid" }).where(eq(nativeRunResults.runId, rejected.runId));
    expect(await rejected.answered(), "a rejected result is not an accepted one").toBe(false);
  });
});
