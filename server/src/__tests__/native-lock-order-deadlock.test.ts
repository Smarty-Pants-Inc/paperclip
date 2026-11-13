import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { documentRevisions, issueComments, type Db } from "@paperclipai/db";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { assertAgentInteraction } from "../services/agent-interaction-policy.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

// RFL native repro (VERDICT-chatdeadlock F1/F2): a Pi agent's native
// send_chat_message runs the shared native lock helper
// (#lockAuthorizedMutationContext). On a5a1a8f2 its joined query took plain
// FOR UPDATE on heartbeat_runs, issues AND agents: run first, then the agent row
// FOR UPDATE. Run writers that hold the agent row in SHARE/KEY SHARE mode
// (assertAgentInteraction lock:true, document_revisions FK insert) and then read
// the run (assertAgentRunWriteAllowed FOR SHARE, FK key-share on
// created_by_run_id) form the opposite order, and Postgres kills one with 40P01.
(support.supported ? describe : describe.skip)("native lock order vs concurrent run writes (deadlock family)", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const settle = <T>(promise: Promise<T>) => promise.then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const describeError = (error: unknown) => {
    const e = error as { code?: string; cause?: { code?: string; message?: string }; message?: string };
    return `${e?.cause?.code ?? e?.code ?? "?"} ${String(e?.cause?.message || e?.message).slice(0, 160)}`;
  };
  const deadlocks = async () => {
    await server.db.execute(sql`select pg_stat_clear_snapshot()`);
    const [row] = await server.db.execute<{ n: string }>(sql`select deadlocks::text as n from pg_stat_database where datname = current_database()`);
    return Number(row!.n);
  };

  it("two native sends + a document_revisions write + assertAgentRunWriteAllowed: one reply each, document commits, no 40P01", async () => {
    const f = await server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true });
    // Wait out deadlocks counted by earlier work, then take the baseline.
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const deadlocksBefore = await deadlocks();
    // Counts 40P01/40001 that a bounded retry absorbed (absent on the base,
    // whose chat path has its own private retry).
    const retryStats = await import("../services/transaction-retry.js").then(m => m.transactionRetryStats, () => null);
    const retriedBefore = retryStats?.retried ?? 0;
    const sends = [1, 2].map(n => ({ body: `Native deadlock probe ${n} ${randomUUID()}`, idempotencyKey: `native-deadlock-${n}-${randomUUID()}` }));
    const docBody = `Plan written during chat ${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let otherReady!: () => void, docReady!: () => void;
    const otherHolds = new Promise<void>(resolve => { otherReady = resolve; });
    const docHolds = new Promise<void>(resolve => { docReady = resolve; });

    // B: real assertAgentInteraction(lock:true) share-locks the agent row, then
    // the real assertAgentRunWriteAllowed share-locks the run. A short
    // deadlock_timeout makes B the detector, so on the old order B is the
    // writer that loses with 40P01 (the RFL observation) instead of the chat,
    // whose own bounded retry would hide it.
    const other = settle(server.db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '200ms'`);
      await assertAgentInteraction(tx as unknown as Db, { companyId: f.companyId, actorAgentId: f.agentId, operation: "edit", lock: true });
      otherReady();
      await gate;
      await assertAgentRunWriteAllowed(tx as unknown as Db, f.companyId, { agentId: f.agentId, runId: f.runId });
      return "other-committed";
    }));
    // D: a document write by the same run on another task. Its interaction
    // check share-locks the agent row; the document_revisions insert then
    // key-shares the run (created_by_run_id FK), then the Stop recheck.
    const doc = settle(server.db.transaction(async tx => {
      await assertAgentInteraction(tx as unknown as Db, { companyId: f.companyId, actorAgentId: f.agentId, operation: "edit", issueId: f.blockerId, lock: true });
      docReady();
      await gate;
      const write = await documentService(tx as unknown as Db).upsertIssueDocument({ issueId: f.blockerId, key: "plan", title: "Plan",
        format: "markdown", body: docBody, createdByAgentId: f.agentId, createdByRunId: f.runId });
      await assertAgentRunWriteAllowed(tx as unknown as Db, f.companyId, { agentId: f.agentId, runId: f.runId });
      return write.document.id;
    }));
    await Promise.all([otherHolds, docHolds]);

    // A1, A2: two real native sends through the real native authority.
    const chats = sends.map(input => settle(f.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() })));
    let chatsSettled = false;
    void Promise.all(chats).then(() => { chatsSettled = true; });
    let nativeJoinWaiting = false;
    let waiting: string[] = [];
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !chatsSettled) {
      const rows = await server.db.execute<{ q: string; full: string }>(sql`select left(query, 70) || ' … ' || right(query, 40) as q, query as full
        from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      waiting = rows.map(row => row.q);
      // On the old order the native helper's joined run/issue/agent lock waits
      // here (pg_stat_activity truncates that long statement, so match its head).
      if (rows.some(row => row.full.startsWith('select "heartbeat_runs"."id", "heartbeat_runs"."company_id"'))) { nativeJoinWaiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    release();
    const [chat1, chat2] = await Promise.all(chats);
    const [otherResult, docResult] = await Promise.all([other, doc]);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const deadlocksDetected = (await deadlocks()) - deadlocksBefore;
    const retriedDeadlocks = retryStats ? retryStats.retried - retriedBefore : "n/a (base)";
    const outcome = (r: { ok: true } | { ok: false; error: unknown }) => r.ok ? "ok" : describeError((r as { error: unknown }).error);
    console.log("[native-deadlock-probe]", JSON.stringify({ nativeJoinWaiting, waiting,
      chat1: outcome(chat1), chat2: outcome(chat2), assertAgentRunWriteAllowed: outcome(otherResult), documentWrite: outcome(docResult),
      pgStatDeadlocksDuringTest: deadlocksDetected, retriedDeadlocks }));

    expect({ chat1: outcome(chat1), chat2: outcome(chat2), assertAgentRunWriteAllowed: outcome(otherResult), documentWrite: outcome(docResult) })
      .toEqual({ chat1: "ok", chat2: "ok", assertAgentRunWriteAllowed: "ok", documentWrite: "ok" });
    for (const [index, input] of sends.entries()) {
      const rows = await server.db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, f.companyId), eq(issueComments.authorAgentId, f.agentId), eq(issueComments.body, input.body)));
      expect(rows).toHaveLength(1);
      const result = [chat1, chat2][index]!;
      expect(result.ok && (result.value as { commentId?: string })?.commentId).toBe(rows[0]!.id);
    }
    const revisions = await server.db.select({ id: documentRevisions.id }).from(documentRevisions).where(and(
      eq(documentRevisions.companyId, f.companyId), eq(documentRevisions.createdByRunId, f.runId), eq(documentRevisions.body, docBody)));
    expect(revisions).toHaveLength(1);
    expect(retriedDeadlocks).toBe(0);
    expect(deadlocksDetected).toBe(0);
  }, 30_000);
});
