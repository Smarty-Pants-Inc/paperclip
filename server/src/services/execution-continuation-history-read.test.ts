import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import type { NativeContinuationReadState } from "./native-runtime/native-turn-budget.js";
import * as queuedCommentDelivery from "./queued-comment-delivery.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_EXECUTION_CONTINUATION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuation history PostgreSQL projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      database = { connectionString: externalUrl, cleanup: async () => {} };
    } else database = await startEmbeddedPostgresTestDatabase("continuation-history-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(result: unknown) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "History", issuePrefix: `H${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue", status: "in_progress", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", errorCode: "adapter_failed",
      contextSnapshot: { issueId }, createdAt: new Date("2020-01-01T00:00:00Z"), resultJson: result as Record<string, unknown> | null }).returning();
    return { companyId, agentId, issueId, run };
  }

  async function invoke(f: Awaited<ReturnType<typeof fixture>>, fullResult: boolean, context: Record<string, unknown> = {}) {
    const reads: Array<Array<Record<string, unknown>>> = [];
    const recorded = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<Db["select"]>) => {
        const historyRead = Object.hasOwn(fields[0] ?? {}, "retryOfRunId");
        const builder = historyRead && fullResult
          ? target.select({ ...fields[0], result: heartbeatRuns.resultJson }) : target.select(...fields);
        const from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          if (historyRead) query.execute = async (...executeArgs: Parameters<typeof execute>) => {
            const rows = await execute(...executeArgs); reads.push(rows); return rows;
          };
          return query;
        }) as typeof builder.from;
        return builder;
      };
    }});
    const result = await buildExecutionContinuation({ db: recorded, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, context, summary: null, exposeLowTrustRaw: false });
    return { result, reads };
  }

  async function compare(f: Awaited<ReturnType<typeof fixture>>, context: Record<string, unknown> = {}) {
    const before = await invoke(f, true, context), after = await invoke(f, false, context);
    expect(after.result).toEqual(before.result);
    expect(after.reads).toHaveLength(1);
    expect(after.reads[0].map(({ result: _result, ...fields }) => fields)).toEqual(before.reads[0].map(({ result: _result, ...fields }) => fields));
    return { before, after };
  }

  it("keeps every completed receipt, its full result, missing values and receipt order", async () => {
    const payload = randomBytes(128 * 1024).toString("base64");
    const result = { nativeResult: { output: payload }, conversationContinuation: "continue_conversation_v1", apiToolReceipts: {
      "10": { state: "completed", operationId: "ten", result: null, unusedRequest: payload },
      "2": { state: "completed", operationId: "two", result: { nested: [payload, false, null] } },
      missing: { state: "completed", operationId: "" },
      pending: { state: "started", operationId: "pending", result: payload },
      invalid: { state: "completed", operationId: 42, result: payload },
      array: ["completed", "operation"],
      scalar: "completed", number: 42, null: null,
    } };
    const f = await fixture(result), { before, after } = await compare(f);
    assert.ok(after.result.completedActions);
    expect(after.result.completedActions.map(receipt => receipt.receiptId)).toEqual(["2", "10", "missing"]);
    expect(after.result.completedActions[0].result).toEqual(result.apiToolReceipts["2"].result);
    expect(after.result.completedActions[1].result).toBeNull();
    expect(after.result.completedActions[2].result).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(after.reads))).toBeLessThan(Buffer.byteLength(JSON.stringify(before.reads)) / 2);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].resultJson).toEqual(result);
  });

  // Agreed regression coverage: exercise the real history-read SQL and guard
  // against hiding an unread revision while bounding its candidate IDs.
  async function readStateFixture(accepted = true) {
    const f = await fixture(null), nativeSessionId = randomUUID(), providerSessionId = "retained-provider";
    const comments = Array.from({ length: 300 }, (_, index) => ({
      id: randomUUID(), companyId: f.companyId, issueId: f.issueId,
      authorType: "user" as const, authorUserId: "local-board", body: `Request ${index}`,
      createdAt: new Date(Date.UTC(2019, 0, 1, 0, index)), updatedAt: new Date(Date.UTC(2019, 0, 1, 0, index)),
    }));
    await db.insert(issueComments).values(comments);
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, context: {}, summary: null, exposeLowTrustRaw: false });
    const ids = comments.map(comment => comment.id), legacyIds = ids.slice(290, 292);
    // Include overlaps with both the snapshot and legacy reads to exercise union semantics.
    const historyIds = [ids[10], ids[290], ...ids.slice(292, 295)];
    await db.update(heartbeatRuns).set({ nativeSessionId, nextEventSeq: accepted ? 2 : 1, finishedAt: new Date("2020-01-02T00:00:00Z"),
      contextSnapshot: { issueId: f.issueId, executionContinuation: { ...envelope,
        messages: accepted ? envelope.messages.slice(0, 290) : [],
        coverage: { ...envelope.coverage, nativeSessionId, providerSessionId,
          omitted: [{ id: ids[295], updatedAt: comments[295].updatedAt.toISOString() }] } },
        nativeContinuationReadState: { lastRunAt: "2020-01-01T00:00:00Z", readCommentIds: legacyIds } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: f.run.id,
      seq: 0, eventType: "session.started", payload: { prpEvent: { payload: { providerSessionId } } } });
    if (accepted) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
      runId: f.run.id, seq: 1, eventType: "turn.accepted" });
    await queuedCommentDelivery.recordTaskHistoryRead(db, { companyId: f.companyId, agentId: f.agentId,
      runId: f.run.id, comments: comments.filter(comment => historyIds.includes(comment.id)) });
    return { ...f, nativeSessionId, providerSessionId, comments, ids, legacyIds, historyIds, envelope };
  }

  async function nativeRead(f: Awaited<ReturnType<typeof readStateFixture>>) {
    const query = vi.spyOn(queuedCommentDelivery, "readByEarlierTurnCommentIds");
    let state: NativeContinuationReadState | undefined;
    try {
      const result = await buildExecutionContinuation({ db, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, previousContextRunId: f.run.id, runId: randomUUID(),
        nativeSessionId: f.nativeSessionId, nativeProviderSessionId: f.providerSessionId,
        context: {}, summary: null, exposeLowTrustRaw: false, onNativeReadState: value => { state = value; } });
      assert.ok(state);
      return { result, state, queriedIds: query.mock.calls.map(([, input]) => input.commentIds) };
    } finally { query.mockRestore(); }
  }

  it("EQUAL SET: queries only unmarked IDs in a 300-message accepted continuation", async () => {
    const f = await readStateFixture(), { state, queriedIds } = await nativeRead(f);
    // Explicit old union: 290 unchanged + two legacy + three history-only + one omitted.
    expect(new Set(state.readCommentIds)).toEqual(new Set(f.ids.slice(0, 296)));
    expect(state.readCommentIds).toHaveLength(296);
    expect(queriedIds, "query receives only the unmarked ids").toEqual([
      [...f.ids.slice(292, 295), ...f.ids.slice(296)],
    ]);
  });

  it("NEVER-OK: keeps a never-read message unread and delivered in the resume delta", async () => {
    const f = await readStateFixture(), { result, state } = await nativeRead(f);
    const unreadId = f.ids[296];
    expect(state.readCommentIds).not.toContain(unreadId);
    expect(result.messages.map(message => message.id)).toContain(unreadId);
    expect(result.resumeDelta?.messages.map(message => message.id)).toContain(unreadId);
  });

  it("queries every non-legacy message when the prior turn was not accepted", async () => {
    const f = await readStateFixture(false), { state, queriedIds } = await nativeRead(f);
    expect(new Set(state.readCommentIds)).toEqual(new Set([...f.legacyIds, ...f.historyIds]));
    expect(queriedIds, "query receives only the unmarked ids").toEqual([
      f.ids.filter(id => !f.legacyIds.includes(id)),
    ]);
  });

  it("queries an older message edited since the prior accepted turn instead of marking it read", async () => {
    const f = await readStateFixture(), editedId = f.ids[0];
    await db.update(issueComments).set({ updatedAt: new Date("2020-01-03T00:00:00Z") }).where(eq(issueComments.id, editedId));
    const { result, state, queriedIds } = await nativeRead(f);
    expect(queriedIds.flat()).toContain(editedId);
    expect(new Set(state.readCommentIds)).toEqual(new Set(f.ids.slice(1, 296)));
    expect(state.readCommentIds).not.toContain(editedId);
    expect(result.resumeDelta?.messages.map(message => message.id)).toContain(editedId);
  });

  it("skips the history-read query when every message was delivered unchanged", async () => {
    const f = await readStateFixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId,
      executionContinuation: { ...f.envelope, coverage: { ...f.envelope.coverage,
        nativeSessionId: f.nativeSessionId, providerSessionId: f.providerSessionId } },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    const { state, queriedIds } = await nativeRead(f);
    expect(new Set(state.readCommentIds)).toEqual(new Set(f.ids));
    expect(queriedIds, "query receives only the unmarked ids (none)").toEqual([]);
  });

  const recovery = { schema: "paperclip.workspace-restore-recovery.v1" };
  it.each([
    { value: null, interrupted: false }, { value: [], interrupted: false }, { value: "scalar", interrupted: false }, { value: 42, interrupted: false },
    { value: {}, interrupted: false }, { value: { conversationContinuation: "continue_conversation_v1", apiToolReceipts: [1, 2] }, interrupted: true },
    { value: { conversationContinuation: 42, apiToolReceipts: "malformed" }, interrupted: false },
    ...["restore_permission_denied", "restore_lock_timeout", "restore_unsafe_archive", "restore_failed"].map(workspaceRestoreFailure => ({
      value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure, workspaceRestoreRecovery: recovery }, interrupted: false,
    })),
    { value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_unsafe_archive" }, interrupted: false },
    { value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "custom", workspaceRestoreRecovery: recovery }, interrupted: true },
    ...[null, [], "schema", { schema: 42 }, { schema: "other" }].map(workspaceRestoreRecovery => ({
      value: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery }, interrupted: true,
    })),
  ])("keeps continuation/recovery decisions for typed legacy JSON $value", async ({ value, interrupted }) => {
    const f = await fixture(value), { after } = await compare(f);
    expect(after.result.interruptedRunId).toBe(interrupted ? f.run.id : undefined);
    expect(after.result.completedActions).toEqual([]);
  });

  it("keeps full ordered history and source-agent scope without cross-company or cross-task receipts", async () => {
    const completed = (operationId: string) => ({ apiToolReceipts: { saved: { state: "completed", operationId, result: { operationId } } } });
    const f = await fixture({ ...completed("first"), conversationContinuation: "continue_conversation_v1" });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Previous owner", adapterType: "paperclip_runner" });
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherAgentId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId }, resultJson: completed("other-agent"), createdAt: new Date("2020-01-01T00:01:00Z") }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "cancelled", errorCode: "execution_reconciliation_required",
      contextSnapshot: { issueId: f.issueId }, resultJson: completed("cancelled"), createdAt: new Date("2020-01-01T00:02:00Z") });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      contextSnapshot: { issueId: randomUUID() }, resultJson: completed("foreign-task") });
    const foreign = await fixture(completed("foreign-company"));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, foreign.run.id));
    const ordinary = await compare(f);
    assert.ok(ordinary.after.result.completedActions);
    expect(ordinary.after.result.completedActions.map(receipt => receipt.operationId)).toEqual(["first", "cancelled"]);
    expect(ordinary.after.result.interruptedRunId).toBe(f.run.id);
    const resumed = await compare(f, { previousRunId: source.id });
    assert.ok(resumed.after.result.completedActions);
    expect(resumed.after.result.completedActions.map(receipt => receipt.operationId)).toEqual(["first", "other-agent", "cancelled"]);
    expect(resumed.after.result.interruptedRunId).toBeUndefined();
  });
});
