import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { freshContinuationChain, freshContinuationDescendsFrom } from "./fresh-continuation-chain.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("fresh-continuation person-turn boundary", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("fresh-continuation-chain-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const root = randomUUID(), first = randomUUID(), second = randomUUID(), person = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chain boundary", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Capped task", assigneeAgentId: agentId, status: "blocked" });
    for (const [id, parent] of [[root, null], [first, root], [second, first], [person, second]] as const) {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, status: "failed", retryOfRunId: parent,
        contextSnapshot: { issueId, previousRunId: parent, wakeReason: "issue_commented" } });
    }
    for (const sourceRunId of [root, first]) await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "resolved", cause: "fresh_continuation", fingerprint: sourceRunId,
      nextAction: "Continue", evidence: { freshContinuation: { sourceRunId } } });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "A new person turn", metadata: { version: 1, sections: [],
        inputOrigin: { kind: "human_session", userId, admittedRunId: person } } }).returning();
    const explicit = { previousRunId: second, commentId: message!.id };
    const context = { issueId, previousRunId: second, wakeReason: "issue_commented", wakeCommentId: message!.id };
    const input = { companyId, issueId, runId: person };
    async function wake(actorType = "user", actorId = userId, marker = false) {
      const [row] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", reason: "issue_commented",
        requestedByActorType: actorType, requestedByActorId: actorId, runId: person, status: "failed" }).returning();
      await db.update(heartbeatRuns).set({ wakeupRequestId: row!.id,
        contextSnapshot: { ...context, ...(marker ? { explicitUserContinuation: explicit } : {}) } }).where(eq(heartbeatRuns.id, person));
    }
    return { companyId, agentId, issueId, userId, root, first, second, person, messageId: message!.id, explicit, context, input, wake };
  }

  it.each([false, true])("an actual user wake starts a fresh chain (explicit marker: %s), and its descendants keep the new budget", async marker => {
    const f = await fixture();
    await f.wake("user", f.userId, marker);
    expect(await freshContinuationChain(db, f.input)).toEqual({ rootRunId: f.person, attempts: 0 });
    expect(await freshContinuationDescendsFrom(db, { ...f.input, ancestorRunId: f.root })).toBe(false);
    const next = randomUUID();
    await db.insert(heartbeatRuns).values({ id: next, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "failed", retryOfRunId: f.person, contextSnapshot: { ...f.context, previousRunId: f.person,
        explicitUserContinuation: f.explicit } });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "resolved", cause: "fresh_continuation", fingerprint: next, nextAction: "Continue",
      evidence: { freshContinuation: { sourceRunId: f.person } } });
    expect(await freshContinuationChain(db, { ...f.input, runId: next })).toEqual({ rootRunId: f.person, attempts: 1 });
    expect(await freshContinuationDescendsFrom(db, { ...f.input, runId: next, ancestorRunId: f.person })).toBe(true);
    expect(await freshContinuationDescendsFrom(db, { ...f.input, runId: next, ancestorRunId: f.second })).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.person)))[0]!.retryOfRunId).toBe(f.second);
  });

  it.each(["reason_only", "marker_only", "system_wake", "wrong_comment_author", "wrong_wake_run"])("%s is not authority to reset an automatic budget", async shape => {
    const f = await fixture();
    if (shape === "marker_only") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.context, explicitUserContinuation: f.explicit } })
      .where(eq(heartbeatRuns.id, f.person));
    if (shape === "system_wake") await f.wake("system", f.userId, true);
    if (shape === "wrong_comment_author") await f.wake("user", randomUUID());
    if (shape === "wrong_wake_run") {
      await f.wake();
      await db.update(agentWakeupRequests).set({ runId: f.second }).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.runId, f.person)));
    }
    expect(await freshContinuationChain(db, f.input)).toEqual({ rootRunId: f.root, attempts: 2 });
  });

  it.each([false, true])("a durable explicit admission receipt resets the budget, not its automatic retry (automatic: %s)", async automatic => {
    const f = await fixture();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "resolved", cause: automatic ? "explicit_user_continuation_retry" : "native_continuation_requires_reconciliation",
      fingerprint: f.person, nextAction: "Continue", evidence: { explicitUserContinuation: { ...f.explicit, runId: f.person,
        actorId: f.userId, ...(automatic ? { automaticRetry: { sourceRunId: f.second } } : {}) } } });
    expect(await freshContinuationChain(db, f.input)).toEqual(automatic
      ? { rootRunId: f.root, attempts: 2 } : { rootRunId: f.person, attempts: 0 });
  });

  it.each(["missing_origin", "already_admitted", "agent_comment"])("%s cannot borrow reset authority from a user-labelled wake", async shape => {
    const f = await fixture();
    await f.wake("user", f.userId, true);
    await db.update(issueComments).set(shape === "agent_comment" ? { createdByRunId: f.root }
      : { metadata: shape === "missing_origin" ? null : { version: 1, sections: [],
        inputOrigin: { kind: "human_session", userId: f.userId, admittedRunId: f.second } } })
      .where(eq(issueComments.id, f.messageId));
    expect(await freshContinuationChain(db, f.input)).toEqual({ rootRunId: f.root, attempts: 2 });
  });

  it("company/task scope, malformed parents and cyclic legacy lineage remain bounded", async () => {
    const f = await fixture();
    expect(await freshContinuationDescendsFrom(db, { ...f.input, companyId: randomUUID(), ancestorRunId: f.root })).toBe(false);
    expect(await freshContinuationDescendsFrom(db, { ...f.input, issueId: randomUUID(), ancestorRunId: f.root })).toBe(false);
    await db.update(heartbeatRuns).set({ retryOfRunId: null, contextSnapshot: { issueId: f.issueId, previousRunId: "not-a-uuid" } })
      .where(eq(heartbeatRuns.id, f.person));
    expect(await freshContinuationChain(db, f.input)).toEqual({ rootRunId: f.person, attempts: 0 });
    await db.update(heartbeatRuns).set({ retryOfRunId: f.second }).where(eq(heartbeatRuns.id, f.person));
    await db.update(heartbeatRuns).set({ retryOfRunId: f.person }).where(eq(heartbeatRuns.id, f.root));
    expect((await freshContinuationChain(db, f.input)).attempts).toBe(2);
  });
});
