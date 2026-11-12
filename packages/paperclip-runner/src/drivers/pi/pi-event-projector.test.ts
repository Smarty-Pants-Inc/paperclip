import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTranscript } from "../../browser/transcript-model.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import { createSessionSnapshotFromMetadata, reduceSessionEvents } from "../../reducer/session-reducer.js";
import { createPiEventProjector, type PiProjectedEvent } from "./pi-event-projector.js";

const fixture = (name: string) => readFileSync(new URL(`../../../test-fixtures/pi-rpc/${name}`, import.meta.url), "utf8");
const wire: Record<string, unknown>[] = fixture("baseline-1.5.2.jsonl").trim().split("\n").map(line => JSON.parse(line));
function realProjection() {
  let turn = 0, projector = createPiEventProjector({ runId: "pi-capture", turnId: "turn-0" });
  return wire.flatMap(event => {
    if (event.type === "agent_start") projector = createPiEventProjector({ runId: "pi-capture", turnId: `turn-${++turn}` });
    return projector.project(event);
  });
}
const final = (extra: Record<string, unknown> = {}) => ({ type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 1, responseId: "reply-1", stopReason: "stop", content: [{ type: "text", text: "final" }], ...extra } });
const update = (type: string, extra: Record<string, unknown> = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });
const usage = { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, reasoning: 2, cost: { total: 0.02, totalFromProvider: false } };
const envelope = (event: PiProjectedEvent, index: number): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: `pi-event-${index + 1}`, sourceSeq: index + 1,
  sourceInstanceId: "pi-capture", sourceKind: "runner", normalizedSessionId: "pi-session", schemaVersion: 1, priority: 1,
  emittedAt: "2026-11-12T05:24:25.000Z", ...event,
});

describe("real Pi 1.5.2 RPC -> canonical events -> existing reducer/transcript", () => {
  it("matches the recorded wire golden and every closed PRP schema", () => {
    const actual = realProjection();
    expect(actual).toEqual(JSON.parse(fixture("baseline-1.5.2.normalized.json")));
    for (const event of actual.map(envelope)) expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
  });
  it("preserves Unicode text, exact bash arguments/output/failure and unique final replies", () => {
    const events = realProjection().map(envelope);
    const seed = createSessionSnapshotFromMetadata({
      fixtureName: "real-pi-rpc", identity: { schema: "paperclip.prp.identity.v1", companyId: "synthetic-peer", issueId: "native-pi", runId: "pi-capture", environmentLeaseId: "loopback-only", runnerInstanceId: "capture", normalizedSessionId: "pi-session", driverSessionId: "native-session" },
      capabilities: { schema: "paperclip.prp.capabilities.v1", sessionReusePolicy: "reuse_per_issue", driver: { kind: "pi_rpc", version: "1.5.2" }, steer: false, interrupt: true, resume: false, runtimeRequests: false, structuredResult: false, typedEvents: true },
    });
    const snapshot = reduceSessionEvents(seed, events);
    expect(snapshot.integrity).toBe("complete");
    const entries = buildTranscript(snapshot, events);
    const assistants = entries.filter(entry => entry.kind === "item" && entry.role === "assistant");
    expect(assistants.map(entry => entry.kind === "item" && entry.item.text)).toEqual(["Hello 🌍\u2028line", "Tool succeeded.", "Tool failure was observed."]);
    const tools = entries.filter(entry => entry.kind === "item" && entry.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolName: "bash", input: JSON.stringify({ command: "printf 'pi-native-tool-ok\\n'" }), output: "pi-native-tool-ok\n", failure: null, item: { status: "completed" } });
    expect(tools[1]).toMatchObject({ toolName: "bash", input: JSON.stringify({ command: "printf 'pi-native-tool-error\\n' >&2; exit 7" }), failure: expect.stringContaining("code 7"), item: { status: "failed" } });
    expect(events.filter(event => event.eventType === "tool.execution.completed").map(event => event.payload.exitCode)).toEqual([0, 7]);
    const receipts = events.filter(event => event.payload.kind === "usage");
    expect(receipts).toHaveLength(5);
    expect(receipts.at(-1)?.payload.usage).toMatchObject({ total: { inputTokens: 23, outputTokens: 6, cachedInputTokens: 4, cacheWriteTokens: 0, totalTokens: 33 }, runDeltaComplete: true, costProvenance: "catalog_estimate" });
    expect(JSON.stringify(receipts)).not.toContain('"costUsd"');
  });
});

describe("synthetic boundary cases (not claimed as native capture)", () => {
  it("projects distinct queued user messages with the same native timestamp once under their captured origin", () => {
    const origin = { runId: "original-run", turnId: "original-turn" };
    const projector = createPiEventProjector(origin);
    const receipts = ["steering-marker", "followup-marker"].map(body => ({ type: "message_end", message: { role: "user", timestamp: 42, content: [{ type: "text", text: body }] } }));
    origin.runId = "new-run"; origin.turnId = "new-turn";
    const events = receipts.flatMap(receipt => projector.project(receipt));
    expect(events.map(event => event.payload.text)).toEqual(["steering-marker", "followup-marker"]);
    expect(new Set(events.map(event => event.itemId)).size).toBe(2);
    for (const event of events) expect(event).toMatchObject({ eventType: "item.completed", runId: "original-run", turnId: "original-turn", payload: { kind: "userMessage" } });
    expect(receipts.flatMap(receipt => projector.project(receipt))).toEqual([]);
  });
  it("replaces streamed partials with final authoritative receipts, not another delta", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    projector.project(update("text_start"));
    projector.project(update("text_delta", { delta: "part" }));
    expect(projector.project(update("text_end", { content: "part" }))).toEqual([]);
    const emitted = projector.project(final({ content: [{ type: "text", text: "authoritative" }] }));
    expect(emitted).toMatchObject([{ eventType: "item.completed", itemId: "t:pi-message:1:block:0", payload: { text: "authoritative", channel: "final" } }]);
    expect(projector.project(final({ content: [{ type: "text", text: "authoritative" }] }))).toEqual([]);
  });
  it("supports final-only text and keeps reasoning separate without signatures", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t", includeThinking: true });
    const events = projector.project(final({ content: [{ type: "thinking", thinking: "reason", thinkingSignature: "private-signature" }, { type: "text", text: "answer" }] }));
    expect(events.map(event => event.payload.kind)).toEqual(["reasoning", "agentMessage"]);
    expect(events[0].payload.channel).toBe("detail");
    expect(JSON.stringify(events)).not.toContain("signature");
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ content: [{ type: "thinking", thinking: "private" }] }))).toEqual([]);
  });
  it("supports interleaved block indexes, including zero, without merging their text", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t", includeThinking: true });
    const events = [update("thinking_delta", { contentIndex: 1, delta: "why" }), update("text_delta", { delta: "hello" }), final({ content: [{ type: "text", text: "hello!" }, { type: "thinking", thinking: "why?" }] })].flatMap(event => projector.project(event));
    expect(events.filter(event => event.eventType === "item.completed").map(event => [event.itemId, event.payload.text])).toEqual([["t:pi-message:1:block:0", "hello!"], ["t:pi-message:1:block:1", "why?"]]);
  });
  it("deduplicates message/turn/agent summaries and counts reasoning inside output only once", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    const receipt = final({ usage });
    const events = [receipt, receipt, { type: "turn_end", message: receipt.message }, { type: "agent_end", messages: [receipt.message] }].flatMap(event => projector.project(event));
    expect(events.filter(event => event.payload.kind === "usage")).toHaveLength(1);
    expect(events.at(-1)?.payload.usage).toMatchObject({ total: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 2 }, estimatedCostUsd: 0.02 });
  });
  it("does not replace absent usage/cost with zero or call partial totals complete", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    expect(projector.project(final()).some(event => event.payload.kind === "usage")).toBe(false);
    const events = projector.project(final({ responseId: "reply-2", timestamp: 2, usage: { input: 4 } }));
    expect(events.at(-1)?.payload.usage).toMatchObject({ total: { inputTokens: 4 }, runDeltaComplete: false, costProvenance: "unknown", costComplete: false });
    expect(JSON.stringify(events)).not.toContain("estimatedCostUsd");
    expect(JSON.stringify(events)).not.toContain("outputTokens");
  });
  it.each(["compaction_start", "compaction_end", "summarization_retry_attempt_start"])("marks accounting incomplete rather than hiding %s work", type => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" }); projector.project(final({ usage }));
    const events = projector.project({ type, result: { usage } });
    expect(events[0].payload.usage).toMatchObject({ source: "pi_summarization_unaccounted", total: { inputTokens: 11, totalTokens: 16 }, runDeltaComplete: false, costComplete: false });
    expect(projector.project(final({ responseId: "reply-2", usage })).at(-1)?.payload.usage).toMatchObject({ runDeltaComplete: false, costComplete: false });
  });
  it("does not treat default zero usage on a failed native call as complete billing", () => {
    const events = createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }));
    expect(events.at(-1)?.payload.usage).toMatchObject({ total: { totalTokens: 0 }, runDeltaComplete: false, costComplete: false });
  });
  it("keeps provider-reported cost distinct from a catalog estimate and labels nested tool work", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    projector.project(final({ usage }));
    const nested = { type: "message_end", message: { role: "toolResult", toolCallId: "nested", toolName: "not-a-child-contract", content: [], usage: { ...usage, cost: { total: 0.03, totalFromProvider: true } } } };
    const events = projector.project(nested);
    expect(events.at(-1)?.payload.usage).toMatchObject({ total: { inputTokens: 22, outputTokens: 6 }, estimatedCostUsd: 0.02, providerReportedCostUsd: 0.03, costProvenance: "provider_reported", scope: "nested_tool_message" });
    expect(projector.project(nested)).toEqual([]);
    expect(events.some(event => event.eventType.startsWith("delegation."))).toBe(false);
  });
  it.each([0, "0", "a/b:☃", "x".repeat(1000)])("correlates exact tool identity %j, including terminal-only results", id => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    const start = projector.project({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
    const finish = { type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "done" }], isError: false } };
    const end = projector.project(finish);
    expect(start[0].payload.input).toBe("{}");
    expect(start[0].itemId).toBe(end[0].itemId);
    expect(start[0].itemId!.length).toBeLessThan(240);
    expect(end[0]).toMatchObject({ eventType: "item.completed", payload: { output: "done" } });
    expect(projector.project(finish)).toEqual([]);
  });
  it("keeps all item IDs inside the canonical limit for a maximum-length turn ID", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "x".repeat(240) });
    for (const event of [...projector.project(final({ usage })), ...projector.project({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: {} })]) {
      expect(event.itemId!.length).toBeLessThanOrEqual(240);
      expect(validatePrpEvent(envelope(event, 0))).toMatchObject({ ok: true });
    }
  });
  it("scopes canonical execution and usage identities to the admitted Runner turn", () => {
    const turns = ["turn-a", "turn-b"].map(turnId => {
      const projector = createPiEventProjector({ runId: "pi-capture", turnId });
      const receipt = projector.project(final({ usage })).find(event => event.payload.kind === "usage")!;
      const tool = projector.project({ type: "tool_execution_start", toolCallId: "same-native-id", toolName: "bash", args: {} }).find(event => event.eventType === "tool.execution.started")!;
      return { receipt: (receipt.payload.usage as Record<string, unknown>).receiptId, execution: tool.payload.executionId };
    });
    expect(turns[0].receipt).not.toBe(turns[1].receipt);
    expect(turns[0].execution).not.toBe(turns[1].execution);
  });
  it("never conflates numeric zero with string zero", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    const events = [0, "0"].flatMap(id => projector.project({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} }));
    expect(new Set(events.filter(event => event.eventType === "item.started").map(event => event.itemId)).size).toBe(2);
  });
  it("does not append cumulative tool snapshots or turn file paths into artifacts", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    const events = ["a", "ab"].flatMap(output => projector.project({ type: "tool_execution_update", toolCallId: "id", toolName: "bash", partialResult: { content: [{ type: "text", text: output }], details: { fullOutputPath: "/tmp/untrusted" } } }));
    expect(events.filter(event => event.eventType === "item.delta").map(event => event.payload.output)).toEqual(["a", "ab"]);
    expect(events.some(event => typeof event.payload.text === "string")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("/tmp/untrusted");
    expect(events.some(event => event.eventType.startsWith("artifact."))).toBe(false);
  });
  it.each(["stop", "aborted"])("does not leave a streamed item running when the %s final receipt omits it", stopReason => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" });
    const partial = projector.project(update("text_delta", { delta: "unconfirmed partial" }));
    const events = projector.project(final({ stopReason, content: [] }));
    expect(events).toMatchObject([{ eventType: "item.failed", itemId: partial[0].itemId, payload: { text: "" } }]);
  });
  it.each(["error", "aborted"])("retains native %s as item failure, never turn settlement", stopReason => {
    const events = createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ stopReason, errorMessage: "native failure" }));
    expect(events[0]).toMatchObject({ eventType: "item.failed", payload: { message: "native failure" } });
    expect(events.some(event => event.eventType.startsWith("turn.") || event.eventType === "run.terminal")).toBe(false);
  });
  it("redacts sensitive parents before flattening tool input while retaining ordinary arguments", () => {
    const events = createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "tool_execution_start", toolCallId: "sensitive", toolName: "custom", args: { ordinary: { value: 42 }, credentials: { endpoint: "sensitive-parent-value" }, authorization: "Bearer synthetic-bearer", command: "echo token=synthetic-token" } });
    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain("sensitive-parent-value"); expect(rendered).not.toContain("synthetic-bearer"); expect(rendered).not.toContain("synthetic-token");
    expect(events[0].payload.item).toMatchObject({ arguments: { ordinary: { value: 42 }, credentials: "[REDACTED]" } });
  });
  it("rejects deep objects and non-numeric indexes rather than coercing identity", () => {
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(update("text_delta", { contentIndex: "0", delta: "wrong index" }))).toThrow(/index_invalid/);
    let deep: unknown = "leaf"; for (let index = 0; index < 40; index++) deep = { next: deep };
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "unknown", deep })).toThrow(/depth_limit/);
  });
  it("rejects missing IDs, changed receipts and bounds instead of silently approving truncation", () => {
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "tool_execution_start", toolName: "bash" })).toThrow(/id_missing/);
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ responseId: undefined, timestamp: undefined }))).toThrow(/identity_missing/);
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(update("text_delta", { delta: "x".repeat(65537) }))).toThrow(/text_limit/);
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "unknown", body: "x".repeat(262145) })).toThrow(/record_limit/);
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" }); projector.project(final());
    expect(() => projector.project(final({ content: [] }))).toThrow(/conflicting_receipt/);
  });
});
