// Keep (never-OK rule: a reader of "which person messages did this task's failed runs leave" must never see a cut
// list as the whole one). rf-3 r3d item 1: readTaskFailedOwnPersonMessageMembership is task- and company-complete,
// ordered, says when it is exhausted, reads groups from the notice's metadata.unansweredMessageIds and answered-ness
// only through the one function. Real PostgreSQL. REAL: the group notice is written and shrunk by the real sweep
// step. PLANTED (rows inserted): the person messages, the runs and the replies.
// The LAST row states the access path: EXPLAIN (ANALYZE, BUFFERS) of the page query on a seeded database (other
// companies, tasks, comments, runs, cards, activity), no sequential scan on any of the large tables.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, completionContracts, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions,
  nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { FAILED_OWN_PERSON_MESSAGE_ORDER, failedOwnPersonMessagePageSqlForExplain, readTaskFailedOwnPersonMessageMembership } from "./person-message-answer.js";
import { settleUnansweredPersonMessagesForTask } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("readTaskFailedOwnPersonMessageMembership: complete, ordered, company- and task-scoped", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("answered-membership-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function task(name = "Membership") {
    const t0 = Date.now() - 3 * 3600_000;
    const at = (ms: number) => new Date(t0 + ms);
    const [company] = await db.insert(companies).values({ name, issuePrefix: `M${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Coder", adapterType: "paperclip_runner", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "A task", status: "in_progress", assigneeAgentId: agent!.id,
      createdAt: at(-60_000) }).returning();
    const companyId = company!.id, agentId = agent!.id, issueId = issue!.id;
    /** PLANTED: person messages, one row each, at the given offsets. */
    const messages = async (offsets: number[], inIssue = issueId, inCompany = companyId) => (await db.insert(issueComments).values(offsets.map(ms => ({
      companyId: inCompany, issueId: inIssue, authorType: "user" as const, authorUserId: "board", body: `Message at ${ms}`, createdAt: at(ms) })))
      .returning({ id: issueComments.id, createdAt: issueComments.createdAt })).map(row => row.id);
    /** PLANTED: a run whose OWN input names these messages. */
    const run = async (status: string, own: string[], ms: number, where: { companyId?: string; agentId?: string; issueId?: string; native?: boolean } = {}) =>
      (await db.insert(heartbeatRuns).values({ companyId: where.companyId ?? companyId, agentId: where.agentId ?? agentId, status,
        runtimeMode: "native", ...(where.native === false ? {} : { nativeIssueId: where.issueId ?? issueId }),
        ...(status === "failed" ? { errorCode: "adapter_failed", error: "adapter_failed: the model call failed" } : {}),
        contextSnapshot: { issueId: where.issueId ?? issueId, wakeReason: "issue_commented", ...(own.length ? { wakeCommentId: own.at(-1), wakeCommentIds: own } : {}) },
        createdAt: at(ms), startedAt: at(ms + 500), finishedAt: ["queued", "running"].includes(status) ? null : at(ms + 1_000) }).returning({ id: heartbeatRuns.id }))[0]!.id;
    const reply = async (runId: string, ms: number) => db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
      createdByRunId: runId, body: "Done.", createdAt: at(ms) });
    const read = (options: { limit?: number; after?: { createdAt: string; messageId: string } | null } = {}) =>
      readTaskFailedOwnPersonMessageMembership(db, { companyId, issueId, ...options });
    return { companyId, agentId, issueId, at, messages, run, reply, read };
  }
  const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

  it("COMPLETE across more than 50 messages (450, more than two internal pages): every member once, exhaustion stated; non-members never", async () => {
    const f = await task();
    const named = await f.messages(Array.from({ length: 450 }, (_, i) => 1_000 + i * 1_000));
    for (const [index, own] of chunks(named, 10).entries()) await f.run("failed", own, 500_000 + index * 2_000);
    // Not members: named only by a succeeded, a cancelled or a running run; named by no run; an agent's own comment.
    const [bySucceeded, byCancelled, byRunning] = await f.messages([900_000, 901_000, 902_000, 903_000]);
    await f.run("succeeded", [bySucceeded!], 910_000); await f.run("cancelled", [byCancelled!], 911_000); await f.run("running", [byRunning!], 912_000);
    const all = await f.read();
    expect(all.exhausted, "the whole membership, and it says so").toBe(true);
    expect(all.next).toBeNull();
    expect(all.order).toBe(FAILED_OWN_PERSON_MESSAGE_ORDER);
    expect(all.members.map(member => member.messageId), "all 450, each once, oldest first; no non-member").toEqual(named);
    expect(new Set(all.members.map(member => member.failedRunCount))).toEqual(new Set([1]));
    // A timed-out and an interrupted run are FAILED runs too; the newest failed run is the one named.
    const again = await f.run("timed_out", [named[0]!], 950_000); await f.run("interrupted", [bySucceeded!], 951_000);
    const more = await f.read();
    expect(more.members).toHaveLength(451);
    expect(more.members[0]).toMatchObject({ messageId: named[0], failedRunId: again, failedRunCount: 2, answered: false });
    expect(more.members.at(-1)!.messageId, "a message a failed run names as well is a member, in its place by time").toBe(bySucceeded);
  }, 120_000);

  it("ORDERED: created_at ascending, the message id breaks ties; a caller's limit is stated as NOT exhausted and `next` continues without a gap or a repeat", async () => {
    const f = await task();
    // 12 messages at ONE instant (ids decide), then 20 more, inserted newest first so insertion order is not the order.
    const later = await f.messages(Array.from({ length: 20 }, (_, i) => 80_000 - i * 1_000));
    const tied = await f.messages(Array.from({ length: 12 }, () => 5_000));
    for (const own of chunks([...later, ...tied], 8)) await f.run("failed", own, 200_000);
    const expected = [...tied.slice().sort(), ...later.slice().reverse()];
    const all = await f.read();
    expect(all.members.map(member => member.messageId), "(created_at, id) ascending").toEqual(expected);
    const seen: string[] = [];
    let after: { createdAt: string; messageId: string } | null = null, pages = 0;
    for (;;) {
      const page = await f.read({ limit: 7, after });
      pages += 1; seen.push(...page.members.map(member => member.messageId));
      if (page.exhausted) { expect(page.next).toBeNull(); break; }
      expect(page.members, "a cut page is full").toHaveLength(7);
      expect(page.next, "and names where it stopped").toEqual({ createdAt: expect.any(String), messageId: page.members.at(-1)!.messageId });
      after = page.next;
    }
    expect(pages).toBe(5);
    expect(seen, "paged through the tie: the same list, no gap, no repeat").toEqual(expected);
  }, 60_000);

  it("COMPANY- and TASK-scoped: another company's or another task's run or comment never enters the membership", async () => {
    const f = await task("Ours"), other = await task("Theirs");
    const [mine, unnamed] = await f.messages([1_000, 2_000]);
    await f.run("failed", [mine!], 10_000);
    // Another COMPANY's failed run whose input names OUR message and OUR task id (a cross-company id in its context).
    await f.run("failed", [unnamed!, mine!], 11_000, { companyId: other.companyId, agentId: other.agentId, native: false });
    // Another company's own member, and another TASK of ours with its own member and a run naming our message.
    const [theirs] = await other.messages([1_000]); await other.run("failed", [theirs!], 10_000);
    const [sibling] = await db.insert(issues).values({ companyId: f.companyId, title: "Sibling", status: "in_progress", assigneeAgentId: f.agentId }).returning();
    const [siblingMessage] = await f.messages([3_000], sibling!.id);
    await f.run("failed", [siblingMessage!, unnamed!], 12_000, { issueId: sibling!.id });
    // OUR failed run also names a comment of the sibling task and one of the other company: not ours, not members.
    await f.run("failed", [siblingMessage!, theirs!], 13_000);
    const ours = await f.read();
    expect(ours.members.map(member => [member.messageId, member.failedRunCount]), "only our task's message, counted only through our company's run")
      .toEqual([[mine, 1]]);
    expect((await other.read()).members.map(member => member.messageId)).toEqual([theirs]);
    expect((await readTaskFailedOwnPersonMessageMembership(db, { companyId: f.companyId, issueId: sibling!.id })).members.map(member => member.messageId))
      .toEqual([siblingMessage]);
    // The wrong company for a real task id reads nothing.
    expect((await readTaskFailedOwnPersonMessageMembership(db, { companyId: other.companyId, issueId: f.issueId })).members).toEqual([]);
  }, 60_000);

  it("GROUPS come from the notice's metadata.unansweredMessageIds, ANSWERED only from the one function", async () => {
    const f = await task();
    const [m1, m2, m3] = await f.messages([1_000, 2_000, 3_000]);
    const failed = await f.run("failed", [m1!, m2!], 10_000);
    const lone = await f.run("failed", [m3!], 11_000);
    expect((await f.read()).members.map(member => [member.messageId, member.noticeId, member.groupMessageIds, member.answered]), "no notice yet")
      .toEqual([[m1, null, null, false], [m2, null, null, false], [m3, null, null, false]]);
    // REAL: the sweep step writes ONE group notice for m1 + m2 and one notice for m3.
    await settleUnansweredPersonMessagesForTask(db, { companyId: f.companyId, issueId: f.issueId });
    const noticed = (await f.read()).members;
    expect(noticed.map(member => [member.messageId, member.failedRunId, member.groupMessageIds]))
      .toEqual([[m1, failed, [m1, m2]], [m2, failed, [m1, m2]], [m3, lone, null]]);
    expect(noticed[0]!.noticeId).toBe(noticed[1]!.noticeId);
    expect(noticed[2]!.noticeId).not.toBe(noticed[0]!.noticeId);
    // A failed run's reply answers nothing; a succeeded run's reply does (the one function).
    await f.reply(failed, 20_000);
    expect((await f.read()).members.map(member => member.answered)).toEqual([false, false, false]);
    await f.reply(await f.run("succeeded", [m2!], 30_000), 32_000);
    expect((await f.read()).members.map(member => member.answered), "m2 answered, by the one function").toEqual([false, true, false]);
    // REAL: the sweep step shrinks the group notice to m1. The failed run still names both, but the group is READ
    // from the notice, not derived from the run: m1's group is [m1], and m2 has no live notice.
    await settleUnansweredPersonMessagesForTask(db, { companyId: f.companyId, issueId: f.issueId });
    expect((await f.read()).members.map(member => [member.messageId, member.noticeId === noticed[0]!.noticeId, member.groupMessageIds]))
      .toEqual([[m1, true, [m1]], [m2, false, null], [m3, false, null]]);
  }, 60_000);

  it("ACCESS PATH: EXPLAIN (ANALYZE, BUFFERS) on a seeded database uses the existing indexes; no sequential scan on a large table", async () => {
    // Seed: 40 other companies x 25 tasks, each task 30 person comments + 6 agent comments, 10 runs (5 with an
    // accepted result and its finalization), 2 cards, activity rows; the task under test (120 members, 10 of them
    // answered by a succeeded run, 10 by a FAILED run's published accepted result) in a company with 60 more tasks.
    const f = await task("Explain target");
    const named = await f.messages(Array.from({ length: 120 }, (_, i) => 1_000 + i * 1_000));
    for (const [index, own] of chunks(named, 10).entries()) await f.run("failed", own, 500_000 + index * 2_000);
    await f.reply(await f.run("succeeded", named.slice(0, 10), 600_000), 602_000);
    const contract = async (companyId: string, issueId: string) => (await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Seed", criteria: [] },
      canonicalSha256: `seed-${randomUUID()}`, createdByActorType: "system", createdByActorId: "test" }).returning({ id: completionContracts.id }))[0]!.id;
    /** PLANTED: accepted results (native_run_results) and their finalizations for these runs. */
    const acceptedResults = async (companyId: string, runs: Array<{ id: string; issueId: string; contractId: string }>) => {
      const results = await db.insert(nativeRunResults).values(runs.map(r => ({ companyId, issueId: r.issueId, runId: r.id, completionContractId: r.contractId,
        serverFingerprint: `seed-${r.id}`, schemaStatus: "accepted", resultJson: {}, canonicalSha256: `sha256:${r.id}` })))
        .returning({ id: nativeRunResults.id, runId: nativeRunResults.runId });
      await db.insert(nativeRunFinalizations).values(results.map(result => ({ companyId, issueId: runs.find(r => r.id === result.runId)!.issueId,
        runId: result.runId, phase: "committed", resultId: result.id })));
    };
    // PLANTED: a FAILED run whose accepted result was published (the reply its presentation decision names).
    const targetContract = await contract(f.companyId, f.issueId);
    const [published] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: f.issueId, completionContractId: targetContract, errorCode: "adapter_failed", error: "adapter_failed: after it published",
      contextSnapshot: { issueId: f.issueId, wakeCommentId: named[19], wakeCommentIds: named.slice(10, 20) },
      createdAt: f.at(610_000), finishedAt: f.at(612_000) }).returning({ id: heartbeatRuns.id });
    const [publishedReply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: published!.id, body: "Published accepted result.", createdAt: f.at(611_000) }).returning({ id: issueComments.id });
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: publishedReply!.id } } })
      .where(eq(heartbeatRuns.id, published!.id));
    await acceptedResults(f.companyId, [{ id: published!.id, issueId: f.issueId, contractId: targetContract }]);
    const companyIds = [f.companyId];
    const noise = await db.insert(companies).values(Array.from({ length: 40 }, (_, i) => ({ name: `Noise ${i}`, issuePrefix: `N${randomUUID().slice(0, 7)}` }))).returning({ id: companies.id });
    companyIds.push(...noise.map(row => row.id));
    for (const companyId of companyIds) {
      const agentId = companyId === f.companyId ? f.agentId
        : (await db.insert(agents).values({ companyId, name: "Noise agent", adapterType: "paperclip_runner", status: "active" }).returning({ id: agents.id }))[0]!.id;
      const tasks = await db.insert(issues).values(Array.from({ length: companyId === f.companyId ? 60 : 25 }, (_, i) => ({ companyId, title: `Noise task ${i}`,
        status: "in_progress", assigneeAgentId: agentId }))).returning({ id: issues.id });
      for (const batch of chunks(tasks, 5)) {
        const contracts = new Map<string, string>();
        for (const t of batch) contracts.set(t.id, await contract(companyId, t.id));
        const comments = await db.insert(issueComments).values(batch.flatMap(t => Array.from({ length: 36 }, (_, i) => ({ companyId, issueId: t.id,
          authorType: (i % 6 === 5 ? "agent" : "user") as "agent" | "user", ...(i % 6 === 5 ? { authorAgentId: agentId } : { authorUserId: "board" }), body: `Noise ${i}`,
          createdAt: f.at(i * 1_000) })))).returning({ id: issueComments.id, issueId: issueComments.issueId, authorType: issueComments.authorType });
        const runs = await db.insert(heartbeatRuns).values(batch.flatMap(t => { const own = comments.filter(c => c.issueId === t.id && c.authorType === "user").map(c => c.id);
          return Array.from({ length: 10 }, (_, i) => ({ companyId, agentId, status: i % 3 === 0 ? "failed" : "succeeded", runtimeMode: "native",
            ...(i % 2 === 0 ? { nativeIssueId: t.id, completionContractId: contracts.get(t.id)! } : {}), contextSnapshot: { issueId: t.id, wakeCommentId: own[i * 3], wakeCommentIds: own.slice(i * 3, i * 3 + 3) },
            createdAt: f.at(100_000 + i * 1_000), finishedAt: f.at(101_000 + i * 1_000) })); })).returning({ id: heartbeatRuns.id, issueId: sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
            nativeIssueId: heartbeatRuns.nativeIssueId });
        await acceptedResults(companyId, runs.filter(r => r.nativeIssueId).map(r => ({ id: r.id, issueId: r.issueId, contractId: contracts.get(r.issueId)! })));
        await db.insert(issueThreadInteractions).values(batch.flatMap(t => runs.filter(r => r.issueId === t.id).slice(0, 2).map(r => ({ companyId, issueId: t.id,
          sourceRunId: r.id, kind: "ask_user_questions", status: "pending", createdByAgentId: agentId, continuationPolicy: "none",
          payload: { version: 1, questions: [] } as never }))));
        await db.insert(activityLog).values(batch.flatMap(t => Array.from({ length: 8 }, (_, i) => ({ companyId, actorType: "system", actorId: "noise",
          action: i === 0 ? "issue.created" : "issue.updated", entityType: "issue", entityId: t.id }))));
      }
    }
    await db.execute(sql`analyze`);
    const sizes = [...await db.execute(sql`select relname, n_live_tup::int as rows from pg_stat_user_tables
      where relname in ('issue_comments', 'heartbeat_runs', 'issue_thread_interactions', 'activity_log', 'issues', 'native_run_results', 'native_run_finalizations') order by relname`)];
    const page = failedOwnPersonMessagePageSqlForExplain({ companyId: f.companyId, issueId: f.issueId, limit: 201 });
    const plan = [...await db.execute(sql`explain (analyze, buffers, costs off, timing off) ${page}`)].map(row => String((row as Record<string, unknown>)["QUERY PLAN"]));
    const membership = await f.read();
    expect(membership.members.map(member => member.messageId)).toEqual(named);
    expect(membership.members.filter(member => member.answered).map(member => member.messageId),
      "the ten the succeeded run answered and the ten the failed run's published accepted result answered").toEqual(named.slice(0, 20));
    if (process.env.MEMBERSHIP_EXPLAIN_OUT) writeFileSync(process.env.MEMBERSHIP_EXPLAIN_OUT, [
      "readTaskFailedOwnPersonMessageMembership: one page (limit 201) on a seeded database, after ANALYZE",
      `table rows: ${JSON.stringify(sizes)}`, `members: ${membership.members.length}, exhausted: ${membership.exhausted}`, "", ...plan, ""].join("\n"));
    const seqScans = plan.filter(line => /Seq Scan on (issue_comments|heartbeat_runs|issue_thread_interactions|activity_log|native_run_results|native_run_finalizations|issues)\b/.test(line));
    expect(seqScans, plan.join("\n")).toEqual([]);
    for (const index of ["heartbeat_runs_company_ctx_issue_created_idx", "heartbeat_runs_pkey", "issue_comments_company_issue_created_at_idx",
      "native_run_results_company_issue_run_id_uq on native_run_results", "native_run_finalizations_pkey"]) expect(plan.some(line => line.includes(index)), `${index}\n${plan.join("\n")}`).toBe(true);
  }, 240_000);
});
