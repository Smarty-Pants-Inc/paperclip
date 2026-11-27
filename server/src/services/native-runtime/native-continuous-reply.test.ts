import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "../../__tests__/helpers/full-database-response-capture.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { recoverContinuousNativeReplies } from "./native-continuous-reply.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_CONTINUOUS_REPLY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuous native reply recovery projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-continuous-reply-");
    db = createDb(external ?? temporary!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("reads only final message items among many completed tool items and preserves ordered idempotent publication", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reply projection", issuePrefix: "RP" });
    // Unset continuity is continuous for Pi, just like an explicit setting.
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Recover replies", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      nativeSessionId: sessionId, status: "succeeded", runtimeMode: "native", contextSnapshot: {} });
    const bulk = "unread-tool-payload🙂".repeat(10_000);
    const completed = (seq: number, kind: string, channel: string, text: string) => ({ companyId, agentId, runId, seq,
      eventType: "item.completed", payload: { ignoredEnvelope: bulk, prpEvent: { runId, normalizedSessionId: sessionId,
        itemId: `item-${seq}`, sourceEventId: `source-${seq}`, turnId: "turn", ignoredEvent: bulk,
        payload: { kind, channel, text, answers: [], ignoredPayload: bulk } } } });
    await db.insert(heartbeatRunEvents).values([
      ...Array.from({ length: 64 }, (_, i) => completed(i + 1, "toolCall", "final", bulk)),
      completed(65, "agentMessage", "analysis", bulk),
      completed(66, "agentMessage", "unknown", bulk),
      completed(67, "agentMessage", "final", "First recovered reply."),
      completed(68, "assistant_message", "final", "Second recovered reply."),
    ]);
    const before = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq));
    const evidence: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => evidence.push(event));
    installDatabaseResponseCapture(db, { heartbeatRunEvents, heartbeatRuns }, capture);
    try {
      await recoverContinuousNativeReplies(db, { id: runId, companyId });
      await recoverContinuousNativeReplies(db, { id: runId, companyId });
    } finally { capture.flush(); }
    const reads = evidence.filter(event => event.event === "paperclip.test_db_response_capture.entry.v1" &&
      event.operation === "select" && event.table === "heartbeat_run_events");
    const rows = reads.reduce((sum, event) => sum + Number(event.rows), 0);
    const bytes = reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0);
    console.info("continuous-reply-projection", JSON.stringify({ seededRows: before.length,
      seededPayloadBytes: Buffer.byteLength(JSON.stringify(before)), selectedEventRows: rows, selectedEventBytes: bytes }));
    expect(rows).toBe(4); // Two final messages per replay, not 68 completed items.
    expect(bytes).toBeLessThan(10_000);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq))).toEqual(before);
    const comments = await db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId)))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    expect(comments.map(comment => comment.body)).toEqual(["First recovered reply.", "Second recovered reply."]);
    const [run] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(Object.keys(run.result?.continuousReplies as object)).toEqual(["item-67", "item-68"]);

    // Projection must not invent null for optional fields absent in older events.
    const optional = completed(69, "agentMessage", "final", "Optional receipt identity.");
    const { sourceEventId: _sourceEventId, ...withoutSource } = optional.payload.prpEvent;
    await db.insert(heartbeatRunEvents).values({ ...optional, payload: { prpEvent: withoutSource } });
    await recoverContinuousNativeReplies(db, { id: runId, companyId });
    const [replayed] = await db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((replayed.result?.continuousReplies as Record<string, unknown>)["item-69"]).not.toHaveProperty("sourceEventId");

    // Missing event session identity must not match a run whose session is null.
    const noSessionRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: noSessionRunId, companyId, agentId, nativeIssueId: issueId,
      nativeSessionId: null, status: "succeeded", runtimeMode: "native", contextSnapshot: {} });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: noSessionRunId, seq: 1, eventType: "item.completed",
      payload: { prpEvent: { runId: noSessionRunId, itemId: "missing-session",
        payload: { kind: "agentMessage", channel: "final", text: "Must not publish without session identity." } } } });
    await recoverContinuousNativeReplies(db, { id: noSessionRunId, companyId });
    expect(await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId)))
      .not.toContainEqual({ body: "Must not publish without session identity." });
  });
});
