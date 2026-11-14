import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { conversationRunsForLastMessages } from "../services/agent-conversations.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
const suite = recoveryPostgresSupport.supported ? describe : describe.skip;
suite("RFL round 2 negative provenance and group selection", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startRecoveryPostgres("rfl-chatgap-provenance-"); db = createDb(temporary.connectionString); }, 240_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function seed(channel = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), messageId = randomUUID(), runId = randomUUID();
    const at = (h: number) => new Date(Date.now() - h * 3_600_000);
    await db.insert(companies).values({ id: companyId, name: "RFL provenance fixture", issuePrefix: `P${companyId.slice(0,7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Responsible agent", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "A person is owed an answer", status: "in_progress", assigneeAgentId: agentId,
      ...(channel ? { originKind: "chat_channel" } : { conversationAgentId: agentId, conversationUserId: "person-1", conversationState: "waiting" }),
      createdAt: at(6), updatedAt: at(3) });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorUserId: "person-1", authorType: "user", body: "Question", createdAt: at(5) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "succeeded", createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4), contextSnapshot: { issueId, wakeCommentId: messageId } });
    return { companyId, agentId, issueId, messageId, runId, at };
  }
  type F = Awaited<ReturnType<typeof seed>>;
  async function selected(f: F) {
    return (await recoveryService(db, { enqueueWakeup: async () => null }).assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).some(r => r.id === f.issueId);
  }
  async function carriers(f: F) { return conversationRunsForLastMessages(db, { companyId: f.companyId, issues: [{ issueId: f.issueId, agentId: f.agentId }] }); }
  function record(name: string, result: unknown) { appendFileSync(`${process.env.TASK_OUT}/provenance-attack-receipts.jsonl`, JSON.stringify({ name, result }) + "\n"); }
  it.each([false, true])("a copied receipt from another run (deleted=%s) does not answer the message", async deleted => {
    const f = await seed(); const old = randomUUID();
    const receipt = { schema: "paperclip.first-turn-queued-input.v1", runId: old, commentIds: [f.messageId], wakeupRequestIds: [], claimedAt: f.at(4.97).toISOString() };
    const context = { issueId: f.issueId, firstTurnQueuedInput: receipt };
    await db.insert(heartbeatRuns).values({ id: old, companyId: f.companyId, agentId: f.agentId, status: "failed", createdAt: f.at(4.99), startedAt: f.at(4.98), finishedAt: f.at(4.95), contextSnapshot: context });
    await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, authorType: "agent", createdByRunId: f.runId, body: "Unrelated response", createdAt: f.at(3) });
    if (deleted) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, old));
    const result = { selected: await selected(f), carriers: await carriers(f) }; record(`inherited-receipt-deleted-${deleted}`, result);
    expect(result.selected).toBe(true);
    expect(result.carriers.some(r => r.runId === f.runId)).toBe(false);
    expect(result.carriers.some(r => r.hasReply)).toBe(false);
  });
  it("deleting a reply's run leaves no valid answer provenance", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, authorType: "agent", createdByRunId: f.runId, body: "Reply whose source run is deleted", createdAt: f.at(3) });
    expect(await selected(f)).toBe(false);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const result = { selected: await selected(f), carriers: await carriers(f) }; record("deleted-response-run", result);
    expect(result).toEqual({ selected: true, carriers: [] });
  });
  it("group/channel selection tracks the last person, not another member's earlier answer", async () => {
    const f = await seed(true); const secondAgent = randomUUID(), firstReply = randomUUID(), secondMessage = randomUUID();
    await db.insert(agents).values({ id: secondAgent, companyId: f.companyId, name: "Other participant", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: firstReply, companyId: f.companyId, agentId: secondAgent, issueId: f.issueId, status: "succeeded", createdAt: f.at(4.5), finishedAt: f.at(4), contextSnapshot: { issueId: f.issueId, wakeCommentId: f.messageId } });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: secondAgent, authorType: "agent", createdByRunId: firstReply, body: "Answer to the first group member", createdAt: f.at(3) });
    await db.insert(issueComments).values({ id: secondMessage, companyId: f.companyId, issueId: f.issueId, authorUserId: "person-2", authorType: "user", body: "Different group member question", createdAt: f.at(2) });
    await db.update(heartbeatRuns).set({ createdAt: f.at(1.9), startedAt: f.at(1.8), finishedAt: f.at(0.8),
      contextSnapshot: { issueId: f.issueId, wakeCommentId: secondMessage } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await selected(f)).toBe(true);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, authorType: "agent", createdByRunId: f.runId, body: "Answer to the latest group member", createdAt: f.at(1) });
    const result = { selected: await selected(f), carriers: await carriers(f) }; record("group-two-people-two-agents-owner-answered", result);
    expect(result.selected).toBe(false);
    expect(result.carriers).toEqual([{ issueId: f.issueId, runId: f.runId, lastPersonCommentId: secondMessage, hasReply: true }]);
  });
  it("agent-to-agent channel containing only agent comments is outside person-facing discovery", async () => {
    const f = await seed(true);
    await db.update(issueComments).set({ authorUserId: null, authorType: "agent", authorAgentId: f.agentId, createdByRunId: f.runId }).where(eq(issueComments.id, f.messageId));
    const result = { selected: await selected(f), carriers: await carriers(f) }; record("agent-to-agent", result);
    expect(result).toEqual({ selected: false, carriers: [] });
  });
});
