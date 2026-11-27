import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { budgetNativeFreshFallback, buildNativeExecutionInput } from "./native-execution-input.js";
import { commandEnvelopeBytes, NATIVE_TURN_KNOWN_MAX_BYTES } from "./native-turn-budget.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";

describe("C73 failed write continuation rows", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    try { await server?.close(); }
    finally {
      if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
    }
  });
  const receiptId = (callId: string) => createHash("sha256").update(callId).digest("hex");
  async function evidence(name: string, value: unknown) {
    const directory = process.env.C73_EVIDENCE_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
  }
  // Real HTTP/embedded PostgreSQL, production continuation builder and budgeter.
  async function prepare(fixture: Awaited<ReturnType<typeof server.fixture>>) {
    const continuation = await buildExecutionContinuation({ db: server.db, companyId: fixture.companyId,
      issueId: fixture.issueId, agentId: fixture.agentId, context: {}, summary: null, exposeLowTrustRaw: false });
    const [issue] = await server.db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const wake = { reason: "issue_commented", executionContinuation: continuation };
    const params: Parameters<typeof buildNativeExecutionInput>[0] = {
      companyId: fixture.companyId, agentId: fixture.agentId, runId: randomUUID(), issue,
      taskPrompt: issue.description ?? "Continue", wakePayload: wake,
      workspace: { id: fixture.projectWorkspaceId, cwd: fixture.workspace, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider: "codex", runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Continue", criteria: [{ id: "output", requirement: "Continue" }] } },
    };
    return { continuation, input: buildNativeExecutionInput(params), wake, params };
  }
  async function lockedFixture() {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const [peer] = await server.db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: fixture.blockerId, contextSnapshot: { issueId: fixture.blockerId } }).returning();
    await server.db.update(issues).set({ status: "in_progress", executionRunId: peer.id }).where(eq(issues.id, fixture.blockerId));
    return fixture;
  }
  it("folds 210 identical real 409s and admits all 27 real write ids", async () => {
    const fixture = await lockedFixture();
    const operationId = "PATCH /api/issues/{id}";
    const args = { operationId, pathParams: { id: fixture.blockerId }, body: { priority: "high" } };
    let refusal: unknown;
    for (let i = 0; i < 210; i++) {
      const result = await fixture.authority.execute({ tool: "call_api", callId: `failed-${i}`, arguments: args });
      expect(result).toMatchObject({ ok: false, status: 409 });
      if (i === 0) refusal = result;
      else expect(result).toEqual(refusal);
    }
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) {
      const result = await fixture.authority.execute({ tool: "call_api", callId: `saved-${i}`, arguments: {
        operationId: "POST /api/issues/{id}/comments", pathParams: { id: fixture.issueId }, body: { body: `Saved ${i}: ${"w".repeat(1800)}` },
      } }) as { ok: boolean; status: number; data: { id: string } };
      expect(result).toMatchObject({ ok: true, status: 201 });
      ids.push(result.data.id);
    }
    await server.db.update(issues).set({ description: "Continue the saved work. " + "d".repeat(70000) }).where(eq(issues.id, fixture.issueId));
    const [storedBefore] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const calls = await server.db.select().from(activityLog).where(and(eq(activityLog.runId, fixture.runId), eq(activityLog.action, "runner.api_called")));
    const failedCalls = calls.filter(row => (row.details as Record<string, unknown>).status === 409).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const { continuation, input, wake, params } = await prepare(fixture);
    const raw = { ...continuation, completedActions: Object.entries(storedBefore.resultJson!.apiToolReceipts as Record<string, { operationId: string; result: unknown }>).map(([id, value]) => ({ runId: fixture.runId, receiptId: id, operationId: value.operationId, result: value.result })) };
    const unbounded = buildNativeExecutionInput({ ...params, wakePayload: { ...wake, executionContinuation: raw } });
    const beforeBytes = commandEnvelopeBytes(buildNativeModelEnvelope(unbounded));
    console.info(JSON.stringify({ c73: "identical-409-before", beforeBytes, receiptBytes: Buffer.byteLength(JSON.stringify(raw.completedActions)), projectedActions: continuation.completedActions?.length }));
    await evidence("row-a-before.json", { beforeBytes, limit: NATIVE_TURN_KNOWN_MAX_BYTES, request: args, savedIds: ids, rawContinuation: raw, modelEnvelope: buildNativeModelEnvelope(unbounded) });
    expect(beforeBytes).toBeGreaterThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    const afterBytes = commandEnvelopeBytes(buildNativeModelEnvelope(input));
    console.info(JSON.stringify({ c73: "identical-409-after", beforeBytes, afterBytes, limit: NATIVE_TURN_KNOWN_MAX_BYTES, ids, retainedActions: retained.completedActions?.length }));
    await evidence("row-a-after.json", { beforeBytes, afterBytes, limit: NATIVE_TURN_KNOWN_MAX_BYTES, savedIds: ids, continuation: retained, modelEnvelope: buildNativeModelEnvelope(input) });
    expect(afterBytes).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
    const failures = retained.completedActions!.filter(row => row.operationId === operationId && typeof row.result !== "string");
    expect(failures).toHaveLength(2);
    expect(failures.map(row => row.receiptId)).toEqual([receiptId("failed-0"), receiptId("failed-209")]);
    const savedReceipts = storedBefore.resultJson!.apiToolReceipts as Record<string, { result: unknown }>;
    for (const row of failures) expect(row.result).toEqual(savedReceipts[row.receiptId]!.result);
    const summary = retained.completedActions!.find(row => typeof row.result === "string")!.result;
    expect(summary).toBe(`The same request failed 208 more times between ${failedCalls[0]!.createdAt.toISOString()} and ${failedCalls.at(-1)!.createdAt.toISOString()} (runs: ${fixture.runId}).`);
    const rendered = JSON.stringify(buildNativeModelEnvelope(input));
    for (const id of ids) expect(rendered).toContain(id);
    const [storedAfter] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(storedAfter.resultJson).toEqual(storedBefore.resultJson);
  }, 120_000);

  it("folds pre-upgrade receipts using their exact saved native inputs", async () => {
    const fixture = await lockedFixture();
    const args = { operationId: "PATCH /api/issues/{id}", pathParams: { id: fixture.blockerId }, body: { priority: "high" } };
    for (let i = 0; i < 5; i++) expect(await fixture.authority.execute({ tool: "call_api", callId: `legacy-${i}`, arguments: args })).toMatchObject({ status: 409 });
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const receipts = run.resultJson!.apiToolReceipts as Record<string, { digest: string; result: unknown }>;
    // The old activity rows do not carry receiptId. Native input events already
    // saved the call id, argument digest and path before this change existed.
    await server.db.update(activityLog).set({ details: sql`${activityLog.details} - 'receiptId'` }).where(eq(activityLog.runId, fixture.runId));
    const times = Array.from({ length: 5 }, (_, i) => new Date(Date.UTC(2026, 0, 1, 10, i)));
    await server.db.insert(heartbeatRunEvents).values(times.map((createdAt, i) => ({ companyId: fixture.companyId, agentId: fixture.agentId,
      runId: fixture.runId, seq: i, eventType: "semantic_tool.input", createdAt, payload: { semantic_tool: { operationId: "call_api", phase: "input",
        callId: `legacy-${i}`, input: args, content: { digest: `sha256:${receipts[receiptId(`legacy-${i}`)]!.digest}` } } } })));
    const { continuation, input, wake } = await prepare(fixture);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    expect(retained.completedActions).toEqual(continuation.completedActions);
    expect(retained.completedActions).toHaveLength(3);
    expect(retained.completedActions![0]).toMatchObject({ receiptId: receiptId("legacy-0"), result: receipts[receiptId("legacy-0")]!.result });
    expect(retained.completedActions![2]).toMatchObject({ receiptId: receiptId("legacy-4"), result: receipts[receiptId("legacy-4")]!.result });
    expect(retained.completedActions![1]!.result).toBe(`The same request failed 3 more times between ${times[0]!.toISOString()} and ${times[4]!.toISOString()} (runs: ${fixture.runId}).`);
    const [after] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(after.resultJson).toEqual(run.resultJson);
  });

  it("bounds run ids and keeps whole endpoint advice while separating targets, statuses and bodies", async () => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const operationId = "PATCH /api/issues/{id}", digest = createHash("sha256").update("same request").digest("hex");
    const result = { ok: false, status: 409, data: { error: "Full refusal" }, outcome: "not_applied", guidance: "Wait before retrying", retryAfter: "60" };
    const runIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const answer = { ...result, retryAfter: String(60 + i), guidance: `Wait before retrying ${i}` };
      const [run] = await server.db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.agentId, status: "failed",
        contextSnapshot: { issueId: fixture.issueId }, createdAt: new Date(Date.UTC(2026, 0, 1, 10, i)),
        resultJson: { apiToolReceipts: { repeated: { state: "completed", operationId, digest, result: answer } } } }).returning();
      runIds.push(run.id);
      await server.db.insert(activityLog).values({ companyId: fixture.companyId, agentId: fixture.agentId, runId: run.id, actorType: "agent", actorId: fixture.agentId,
        action: "runner.api_called", entityType: "issue", entityId: fixture.issueId, createdAt: run.createdAt,
        details: { receiptId: "repeated", operationId, requestFingerprint: digest, pathParams: { id: fixture.blockerId }, status: 409 } });
    }
    // Same digest alone cannot justify a fold when the resolved target, body
    // or status differs. Include a group with no binding evidence as well.
    const variants = [
      { ...result }, { ...result, status: 422 }, { ...result, data: { error: "Different answer" } },
    ];
    const variantReceipts = Object.fromEntries(variants.map((value, i) => [`variant-${i}`, { state: "completed", operationId, digest, result: value }]));
    Object.assign(variantReceipts, Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`unbound-${i}`, { state: "completed", operationId, digest, result }])));
    await server.db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: variantReceipts } }).where(eq(heartbeatRuns.id, fixture.runId));
    await server.db.insert(activityLog).values(variants.map((value, i) => ({ companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId,
      actorType: "agent", actorId: fixture.agentId, action: "runner.api_called", entityType: "issue", entityId: fixture.issueId,
      details: { receiptId: `variant-${i}`, operationId, requestFingerprint: digest, pathParams: { id: i === 0 ? fixture.issueId : fixture.blockerId }, status: value.status } })));
    const { continuation } = await prepare(fixture);
    const summaries = continuation.completedActions!.filter(row => typeof row.result === "string");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.result).toBe(`The same request failed 10 more times between 2026-01-01T10:00:00.000Z and 2026-01-01T10:11:00.000Z (runs: ${runIds.slice(0, 8).join(", ")}, +4 more).`);
    const endpoints = continuation.completedActions!.filter(row => row.receiptId === "repeated" && typeof row.result !== "string");
    expect(endpoints.map(row => row.runId)).toEqual([runIds[0], runIds[11]]);
    expect(endpoints.map(row => row.result)).toEqual([
      { ...result, retryAfter: "60", guidance: "Wait before retrying 0" },
      { ...result, retryAfter: "71", guidance: "Wait before retrying 11" },
    ]);
    for (const [id, original] of Object.entries(variantReceipts)) expect(continuation.completedActions!.find(row => row.receiptId === id)!.result).toEqual(original.result);
  });

  it("keeps an error-bearing saved-record body whole before budgeting", async () => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const result = { ok: true, status: 200, operationId: "POST /api/issues/{id}/comments",
      data: { id: randomUUID(), companyId: fixture.companyId, error: "Save refused", body: "whole error details ".repeat(1000) } };
    await server.db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: { candidate: { state: "completed", operationId: result.operationId, result } } } }).where(eq(heartbeatRuns.id, fixture.runId));
    const { continuation, input, wake } = await prepare(fixture);
    expect(continuation.completedActions![0]!.result).toEqual(result);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    expect(retained.completedActions![0]!.result).toEqual(result);
  });

  it.each([ ["null", null], ["message", "Reported error"] ] as const)("keeps repeated successful 2xx answers with a %s error field whole", async (_name, error) => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const operationId = "POST /api/companies/{companyId}/projects";
    const digest = createHash("sha256").update("same successful request").digest("hex");
    const result = { ok: true, status: 200, data: { id: fixture.projectId, error } };
    const receipts = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`success-${i}`, { state: "completed", operationId, digest, result }]));
    await server.db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, fixture.runId));
    await server.db.insert(activityLog).values(Array.from({ length: 3 }, (_, i) => ({ companyId: fixture.companyId, agentId: fixture.agentId,
      runId: fixture.runId, actorType: "agent", actorId: fixture.agentId, action: "runner.api_called", entityType: "issue", entityId: fixture.issueId,
      details: { receiptId: `success-${i}`, operationId, requestFingerprint: digest, pathParams: { companyId: fixture.companyId }, status: 200 } })));
    const { continuation, input, wake } = await prepare(fixture);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    expect(continuation.completedActions!.map(row => row.result)).toEqual([result, result, result]);
    expect(retained.completedActions).toEqual(continuation.completedActions);
  });

  it.each([
    ["2xx body error", { ok: true, status: 200, data: { id: "candidate", error: "Not a successful save" } }],
    ["2xx null body error", { ok: true, status: 200, data: { id: "candidate", error: null } }],
    ["absent status", { ok: true, data: { id: "candidate" } }],
    ["nested id only", { ok: true, status: 201, data: { nested: { id: "not-the-resource" } } }],
  ])("keeps a persisted %s answer whole through the real budgeter", async (_name, candidate) => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    const result = { ...candidate, padding: "x".repeat(310000) };
    const receipts = {
      candidate: { state: "completed", operationId: "POST /api/companies/{companyId}/projects", result },
      saver: { state: "completed", operationId: "POST /api/companies/{companyId}/projects",
        result: { ok: true, status: 201, data: { id: randomUUID(), body: "s".repeat(60000) } } },
    };
    await server.db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: receipts } }).where(eq(heartbeatRuns.id, fixture.runId));
    const { continuation, input, wake } = await prepare(fixture);
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeGreaterThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    expect(retained.completedActions!.find(row => row.receiptId === "candidate")!.result).toEqual(result);
    expect(retained.completedActions!.find(row => row.receiptId === "saver")!.result).toMatchObject({ resultOmittedForSize: true });
    expect(retained.messages).toEqual(continuation.messages);
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeLessThanOrEqual(NATIVE_TURN_KNOWN_MAX_BYTES);
    const [saved] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(saved.resultJson).toEqual({ apiToolReceipts: receipts });
  });

  it("keeps 50 distinct request bodies despite identical real 409 answers", async () => {
    const fixture = await lockedFixture();
    const results: unknown[] = [], inputs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i++) {
      const args = { operationId: "PATCH /api/issues/{id}", pathParams: { id: fixture.blockerId }, body: { description: `Different request ${i}` } };
      inputs.push(args);
      const result = await fixture.authority.execute({ tool: "call_api", callId: `distinct-${i}`, arguments: args });
      expect(result).toMatchObject({ ok: false, status: 409 });
      results.push(result);
    }
    expect(results.every(value => JSON.stringify(value) === JSON.stringify(results[0]))).toBe(true);
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    const receipts = run.resultJson!.apiToolReceipts as Record<string, { digest: string; result: unknown }>;
    const savedInputs = inputs.map((input, i) => ({ companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId,
      seq: i, eventType: "semantic_tool.input", payload: { semantic_tool: { operationId: "call_api", phase: "input", callId: `distinct-${i}`,
        input, content: { digest: `sha256:${receipts[receiptId(`distinct-${i}`)]!.digest}` } } } }));
    await server.db.insert(heartbeatRunEvents).values(savedInputs);
    const { continuation, input, wake } = await prepare(fixture);
    const retained = budgetNativeFreshFallback(input, wake, { lastRunAt: null, readCommentIds: [] })!;
    expect(retained.completedActions).toHaveLength(50);
    expect(retained.completedActions).toEqual(continuation.completedActions);
    expect(new Set(Object.values(receipts).map(row => row.digest)).size).toBe(50);
    for (let i = 0; i < 50; i++) expect(retained.completedActions!.find(row => row.receiptId === receiptId(`distinct-${i}`))!.result).toEqual(receipts[receiptId(`distinct-${i}`)]!.result);
    const events = await server.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, fixture.runId)).orderBy(heartbeatRunEvents.seq);
    expect(events.map(row => row.payload)).toEqual(savedInputs.map(row => row.payload));
    const [after] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
    expect(after.resultJson).toEqual(run.resultJson);
    await evidence("row-b-distinct-bodies.json", { requests: inputs, savedInputEvents: events.map(row => row.payload), receipts, continuation: retained });
    console.info(JSON.stringify({ c73: "distinct-bodies", requests: 50, distinctDigests: 50, retained: retained.completedActions!.length }));
  }, 60_000);
});
