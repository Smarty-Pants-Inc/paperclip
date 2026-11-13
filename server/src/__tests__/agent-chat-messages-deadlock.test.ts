import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, issueComments, type Db } from "@paperclipai/db";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { sendAgentChatMessage } from "../services/agent-chat-messages.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

// Prod Image A 12:29Z: the chat-reply transaction deadlocked (40P01) against a
// concurrent agent-run write that already held a share lock on the agent row
// (assertAgentInteraction lock:true, agent-interaction-policy.ts:63, from
// issue-thread-interactions.ts assertInteractionRunWriteAllowed) and then ran the
// real assertAgentRunWriteAllowed FOR SHARE read of the same heartbeat run.
(support.supported ? describe : describe.skip)("agent chat message vs concurrent run write (deadlock)", () => {
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

  it("delivers exactly one chat message when a concurrent run write holds the agent row", async () => {
    const f = await server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true });
    const input = { body: "Deadlock probe reply", idempotencyKey: `deadlock-${randomUUID()}` };
    let releaseOther!: () => void;
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
    let otherHoldsAgent!: () => void;
    const otherReady = new Promise<void>(resolve => { otherHoldsAgent = resolve; });
    // Transaction B: agent row FOR SHARE (agent-interaction-policy.ts:63), then the real Stop recheck.
    const other = server.db.transaction(async tx => {
      await tx.execute(sql`select id from agents where id = ${f.agentId} for share`);
      otherHoldsAgent();
      await otherGate;
      await assertAgentRunWriteAllowed(tx as unknown as Db, f.companyId, { agentId: f.agentId, runId: f.runId });
      return "other-committed";
    });
    await otherReady;
    // Transaction A: the real chat reply.
    const chat = sendAgentChatMessage(server.db, f, input).then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    // Let A reach its run lock (and, on the base, block on the agent row).
    const deadline = Date.now() + 3_000;
    let chatBlocked = false;
    let waiting: string[] = [];
    let chatSettled = false;
    void chat.then(() => { chatSettled = true; });
    while (Date.now() < deadline && !chatSettled) {
      const rows = await server.db.execute<{ q: string }>(sql`select left(query, 60) || ' … ' || right(query, 60) as q from pg_stat_activity
        where wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      waiting = rows.map(row => row.q);
      if (waiting.some(q => q.includes('inner join "agents"') || q.includes('"heartbeat_runs"."id"'))) { chatBlocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    releaseOther();
    const [chatResult, otherResult] = await Promise.all([chat, other.then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))]);
    const describeError = (error: unknown) => {
      const e = error as { code?: string; cause?: { code?: string }; message?: string };
      return `${e?.cause?.code ?? e?.code ?? "?"} ${String(e?.cause && (e.cause as Error).message || e?.message).slice(0, 200)}`;
    };
    console.log("[deadlock-probe]", JSON.stringify({ chatBlockedBeforeOtherRan: chatBlocked, waiting,
      chat: chatResult.ok ? "ok" : describeError(chatResult.error),
      other: otherResult.ok ? "ok" : describeError(otherResult.error) }));
    expect(chatResult.ok ? "ok" : describeError(chatResult.error)).toBe("ok");
    expect(otherResult.ok ? "ok" : describeError(otherResult.error)).toBe("ok");
    const rows = await server.db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, f.companyId), eq(issueComments.authorAgentId, f.agentId),
      eq(issueComments.body, input.body)));
    expect(rows).toHaveLength(1);
    expect(chatResult.ok && chatResult.value?.commentId).toBe(rows[0]!.id);
    void agents;
  }, 30_000);
});
