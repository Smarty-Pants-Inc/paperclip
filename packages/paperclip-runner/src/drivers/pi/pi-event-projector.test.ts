import { createHash } from "node:crypto";
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

// Keep reason: L17 crosses the native receipt -> closed PRP boundary; errors
// must remain visible without borrowing the provider's turn-settlement authority.
describe("Pi compaction lifecycle and warning projection (L17)", () => {
  it("projects the recorded Pi 1.5.2 compaction as a context item and one typed compaction", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "compaction-turn" });
    const native: Record<string, unknown>[] = fixture("compaction-1.5.2.jsonl").trim().split("\n").map(line => JSON.parse(line));
    const events = native.filter(event => ["compaction_start", "compaction_end"].includes(String(event.type))).flatMap(event => projector.project(event));
    const items = events.filter(event => event.payload.kind === "contextCompaction");
    expect(items).toMatchObject([
      { eventType: "item.started", payload: { kind: "contextCompaction", text: expect.stringMatching(/compacting/i) } },
      { eventType: "item.completed", itemId: items[0]?.itemId, payload: { kind: "contextCompaction" } },
    ]);
    expect(events.filter(event => event.eventType === "context.compacted")).toMatchObject([
      { itemId: items[0]?.itemId, payload: { compactionId: items[0]?.itemId, reason: "context_window", preTokens: 3903, postTokens: 1841, sameSession: true } },
    ]);
    for (const event of events.map(envelope)) expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
    expect(JSON.stringify(events)).not.toContain("firstKeptEntryId");
  });

  it("gives successive compactions different IDs, preserves their reason and accepts an end-only receipt", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "t".repeat(240) });
    const events: PiProjectedEvent[] = [];
    for (const reason of ["manual", "overflow"]) {
      events.push(...projector.project({ type: "compaction_start", reason }));
      events.push(...projector.project({ type: "compaction_end", result: { tokensBefore: 90, estimatedTokensAfter: 30 }, aborted: false }));
    }
    events.push(...projector.project({ type: "compaction_end", reason: "threshold", result: { tokensBefore: -1, estimatedTokensAfter: "30" } }));
    const compacted = events.filter(event => event.eventType === "context.compacted");
    expect(compacted.map(event => event.payload.reason)).toEqual(["manual", "context_window", "context_window"]);
    expect(new Set(compacted.map(event => event.itemId)).size).toBe(3);
    expect(compacted[2].payload).toMatchObject({ preTokens: null, postTokens: null });
    for (const event of events.map(envelope)) expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
  });

  it("surfaces a redacted, bounded compaction error as a warning and leaves final turn authority alone", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const started = projector.project({ type: "compaction_start", reason: "threshold" });
    const events = projector.project({ type: "compaction_end", reason: "threshold", aborted: false, errorMessage: `Summarizer unavailable; token=compaction-secret ${"\\\"🌍".repeat(90000)}` });
    const warning = events.find(event => event.payload.kind === "warning");
    expect(events.find(event => event.payload.kind === "contextCompaction")).toMatchObject({ eventType: "item.completed", itemId: started.find(event => event.payload.kind === "contextCompaction")?.itemId });
    expect(warning).toMatchObject({ eventType: "item.completed", payload: { kind: "warning", severity: "warning", code: "pi_compaction_failed", text: expect.stringContaining("Summarizer unavailable") } });
    expect(JSON.stringify(events)).not.toContain("compaction-secret");
    expect(events.some(event => event.eventType === "context.compacted" || event.eventType.startsWith("turn.") || event.eventType === "run.terminal")).toBe(false);
    for (const event of events.map(envelope)) expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
    const finalEvents = projector.project(final({ usage }));
    expect(finalEvents.find(event => event.payload.kind === "agentMessage")).toMatchObject({ eventType: "item.completed", payload: { text: "final" } });
    expect(finalEvents.find(event => event.payload.kind === "usage")?.payload.usage).toMatchObject({ runDeltaComplete: false });
    const replay = [...started, ...events, ...finalEvents].map(envelope);
    const seed = createSessionSnapshotFromMetadata({
      fixtureName: "pi-compaction-warning", identity: { schema: "paperclip.prp.identity.v1", companyId: "synthetic-peer", issueId: "native-pi", runId: "run", environmentLeaseId: "loopback-only", runnerInstanceId: "capture", normalizedSessionId: "pi-session", driverSessionId: "native-session" },
      capabilities: { schema: "paperclip.prp.capabilities.v1", sessionReusePolicy: "reuse_per_issue", driver: { kind: "pi_rpc", version: "1.5.2" }, steer: false, interrupt: true, resume: false, runtimeRequests: false, structuredResult: false, typedEvents: true },
    });
    const snapshot = reduceSessionEvents(seed, replay);
    expect(snapshot.integrity).toBe("complete");
    expect(buildTranscript(snapshot, replay)).toContainEqual(expect.objectContaining({ kind: "item", role: "system", item: expect.objectContaining({ kind: "warning", status: "completed", text: warning!.payload.text }) }));
    expect(snapshot.terminal).toBeNull();
  });

  it.each([null, 42, []])("does not invent compaction success from malformed result %j", result => {
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project({ type: "compaction_end", result });
    expect(events.some(event => event.eventType === "context.compacted" || event.eventType.startsWith("turn."))).toBe(false);
    expect(events.find(event => event.payload.kind === "contextCompaction" && event.eventType === "item.completed")?.payload.text).toContain("did not complete");
  });

  it("closes an aborted compaction item without inventing success or an error", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const events = [...projector.project({ type: "compaction_start", reason: "manual" }), ...projector.project({ type: "compaction_end", reason: "manual", aborted: true })];
    expect(events.filter(event => event.payload.kind === "contextCompaction").map(event => event.eventType)).toEqual(["item.started", "item.completed"]);
    expect(events.some(event => event.eventType === "context.compacted" || event.payload.kind === "warning")).toBe(false);
  });
});

describe("large native tool output projection (synthetic incident regression)", () => {
  it("digests the real 403238-byte custom entry for display without losing the turn", () => {
    const raw = fixture("tool-context-guard-full.json");
    const input = JSON.parse(raw);
    const before = JSON.stringify(input);
    expect(Buffer.byteLength(before)).toBe(403238);
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const events = projector.project(input);
    expect(events).toMatchObject([{ eventType: "harness.diagnostic", payload: { code: "pi_native_activity", providerMethod: "entry_appended" }, debug: { piProjection: { truncated: true, recordBytes: 403238, recordSha256: createHash("sha256").update(before).digest("hex") } } }]);
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(2048);
    expect(JSON.stringify(input)).toBe(before);
    expect(projector.project(final())[0].eventType).toBe("item.completed");
  });
  it("preserves a safe small escaped record exactly instead of applying a blanket JSON text cap", () => {
    const body = "\\".repeat(50000);
    const input = { type: "tool_execution_end", toolCallId: "ordinary", toolName: "bash", isError: false, result: { content: [{ type: "text", text: body }] } };
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(input);
    expect(events.find(event => event.eventType === "item.completed")?.payload).toMatchObject({ text: body, output: body });
    expect(events.at(-1)?.payload).toMatchObject({ output: body, outputTruncated: false, outputBytes: 50000 });
    for (const event of events) {
      expect(event.debug).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    }
  });
  it("P0-1 bounds oversized argument records without mutating executable arguments", () => {
    const args = { command: "\"\\\n".repeat(300000), nested: { enabled: true, count: 3 } };
    const input = { type: "tool_execution_start", toolCallId: "typed", toolName: "bash", args };
    const serialized = JSON.stringify(input);
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const events = projector.project(input);
    expect(events[0]).toMatchObject({ eventType: "item.started", payload: { toolName: "bash", input: expect.stringContaining("[Pi projection truncated]") }, debug: { piProjection: { truncated: true } } });
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(input)).toBe(serialized);
    expect(projector.project({ type: "tool_execution_end", toolCallId: "typed", toolName: "bash", result: {} })[0].eventType).toBe("item.completed");
    expect(projector.project(final({ content: [{ type: "text", text: "semantic".repeat(100000) }] }))[0]).toMatchObject({ eventType: "item.completed", payload: { text: expect.stringContaining("[Pi projection truncated]") } });
    expect(() => projector.project({ type: "message_end", message: { role: "toolResult", toolCallId: "receipt", toolName: "bash", content: [], usage: { opaque: "receipt".repeat(100000) } } })).not.toThrow();
  });
  it("projects an accumulated >4MiB tool update without copying full native output", () => {
    const input = { type: "tool_execution_update", toolCallId: "streamed", toolName: "bash", partialResult: { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 1) }] } };
    const serialized = JSON.stringify(input);
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(input);
    expect(events.at(-1)).toMatchObject({ payload: { output: expect.stringMatching(/^\[Pi tool output truncated/) }, debug: { piProjection: { truncated: true, recordSha256: createHash("sha256").update(serialized).digest("hex") } } });
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(input)).toBe(serialized);
  });
  it.each([false, true])("bounds escaped output and retains error status %s", isError => {
    const input = { type: "tool_execution_end", toolCallId: 0, toolName: "bash", isError, result: { content: [{ type: "text", text: "\u0000\\\"🌍".repeat(100000) }], structuredContent: { exit_code: isError ? 7 : 0 } } };
    const serialized = JSON.stringify(input);
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(input);
    expect(events.some(event => event.eventType === (isError ? "item.failed" : "item.completed"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ payload: { status: isError ? "failed" : "completed", outputTruncated: true }, debug: { piProjection: { recordSha256: createHash("sha256").update(serialized).digest("hex") } } });
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(input)).toBe(serialized);
  });
  it.each(["tool_execution_end", "message_end"])("bounds %s without changing the native result or terminal ownership", type => {
    const result = { role: "toolResult", toolCallId: "large-tool", toolName: "bash", isError: false, content: [{ type: "text", text: "final output\n".repeat(4000) }], details: { fullOutput: "find-result\n".repeat(110000) }, structuredContent: { fullOutput: "structured\n".repeat(110000), exit_code: 0 } };
    const input = type === "message_end" ? { type, message: result } : { type, toolCallId: result.toolCallId, toolName: result.toolName, result, isError: false };
    const serialized = JSON.stringify(input);
    const original = structuredClone(input);
    const projector = createPiEventProjector({ runId: "owned-run", turnId: "owned-turn" });
    const started = projector.project({ type: "tool_execution_start", toolCallId: "large-tool", toolName: "bash", args: { command: "find synthetic" } });
    const events = projector.project(input);
    expect(input).toEqual(original);
    expect(JSON.stringify(input)).toBe(serialized);
    expect(events.map(event => event.eventType)).toEqual(["item.completed", "tool.execution.completed"]);
    for (const event of events) {
      expect(event).toMatchObject({ runId: "owned-run", turnId: "owned-turn", itemId: started[0].itemId, debug: { piProjection: { truncated: true, recordBytes: Buffer.byteLength(serialized), recordSha256: createHash("sha256").update(serialized).digest("hex") } } });
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(256 * 1024);
      expect(validatePrpEvent(envelope(event, 0))).toMatchObject({ ok: true });
    }
    expect(events[0].payload.output).toBe(result.content[0].text);
    expect(events[1].payload).toMatchObject({ status: "completed", exitCode: 0, name: "find synthetic", output: result.content[0].text });
    expect(JSON.stringify(events)).not.toContain("fullOutput");
    expect(projector.project(input)).toEqual([]);
  });
});

// Keep reason: reproduced audit A P0-4; long real turns must outlive display caches.
describe("P0-4 turn-local projection state", () => {
  it("projects 1100 completed tools and suppresses late duplicates after eviction", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    let first: Record<string, unknown> | undefined;
    for (let i = 0; i < 1100; i++) {
      const toolCallId = `read-${i}`;
      projector.project({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: `${i}` } });
      const done = { type: "tool_execution_end", toolCallId, toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false };
      if (!i) first = done;
      expect(projector.project(done).map(event => event.eventType)).toEqual(["item.completed", "tool.execution.completed"]);
    }
    expect(projector.project(first)).toEqual([]);
    expect(projector.project(final())[0].eventType).toBe("item.completed");
  });
  it("degrades only the overflow item with 1025 simultaneously active tools", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    let overflow: PiProjectedEvent[] = [];
    for (let i = 0; i <= 1024; i++) overflow = projector.project({ type: "tool_execution_start", toolCallId: `open-${i}`, toolName: "read", args: { path: `${i}` } });
    expect(overflow.find(event => event.eventType === "harness.diagnostic")?.payload.code).toBe("pi_active_tool_projection_limit");
    const terminal = projector.project({ type: "tool_execution_end", toolCallId: "open-1024", toolName: "read", result: { content: [{ type: "text", text: "ok" }] } });
    expect(terminal.find(event => event.eventType === "tool.execution.completed")).toMatchObject({ itemId: overflow[0]?.itemId, payload: { status: "completed", name: "read" } });
    expect(projector.project(final())[0].eventType).toBe("item.completed");
  });
  it("marks accounting incomplete instead of failing when the 65536-receipt display cache fills", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    for (let i = 0; i < 65_536; i++) projector.project(final({ responseId: `receipt-${i}`, timestamp: i, content: [], usage }));
    const overflow = projector.project(final({ responseId: "overflow", usage }));
    expect(overflow.find(event => event.eventType === "harness.diagnostic")?.payload.code).toBe("pi_receipt_projection_limit");
    expect(overflow.find(event => event.payload.kind === "usage")?.payload.usage).toMatchObject({ runDeltaComplete: false, costComplete: false });
    expect(overflow.some(event => event.eventType === "item.completed" && event.payload.text === "final")).toBe(true);
    expect(projector.project(final({ responseId: "receipt-0", timestamp: 0, content: [], usage }))).toEqual([]);
  }, 20_000);
  it("deduplicates more than 4096 native receipts without retaining receipt bodies", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    let first: unknown;
    for (let i = 0; i < 4200; i++) {
      const receipt = final({ responseId: `receipt-${i}`, timestamp: i, content: [], usage });
      if (!i) first = receipt;
      expect(projector.project(receipt).filter(event => event.eventType === "usage.reported")).toHaveLength(1);
    }
    expect(projector.project(first)).toEqual([]);
    expect(projector.project(final({ responseId: "last" }))[0].eventType).toBe("item.completed");
  });
});

// Keep reason: reproduced audit A P0-1, including an ordinary completed run's summary.
describe("P0-1 large records are display-only", () => {
  const results = Array.from({ length: 6 }, (_, i) => ({ role: "toolResult", toolCallId: `read-${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(50_000) }] }));
  it.each([
    { type: "agent_end", messages: results, willRetry: false },
    { type: "turn_end", message: final().message, toolResults: results },
    { type: "message_start", message: { ...results[0], content: [{ type: "image", data: "A".repeat(300_000), mimeType: "image/png" }] } },
    { type: "message_end", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "x".repeat(300_000) }] } },
    { type: "message_start", message: { role: "system", content: "x".repeat(300_000) } },
  ])("ignores unneeded bodies in oversized $type without breaking the next projection", input => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const before = JSON.stringify(input);
    // K4 adds consumed user receipts; they must be bounded, not discarded.
    const projected = projector.project(input);
    if (input.type === "message_end" && input.message?.role === "user") {
      expect(projected).toMatchObject([{ eventType: "item.completed", payload: { kind: "userMessage", text: expect.stringContaining("[Pi projection truncated]") } }]);
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(256 * 1024);
    } else expect(projected).toEqual([]);
    expect(projector.project(final())[0].eventType).toBe("item.completed");
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["message_end", "tool_execution_end"])("omits a 300KB image in %s but keeps identity and completion", type => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const started = projector.project({ type: "tool_execution_start", toolCallId: "image", toolName: "read", args: { path: "shot.png" } });
    const result = { role: "toolResult", toolCallId: "image", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "A".repeat(300_000), mimeType: "image/png" }] };
    const input = type === "message_end" ? { type, message: result } : { type, toolCallId: "image", toolName: "read", result, isError: false };
    const before = JSON.stringify(input);
    const events = projector.project(input);
    expect(events[0]).toMatchObject({ eventType: "item.completed", itemId: started[0].itemId, payload: { toolName: "read", output: expect.stringContaining("[Pi image omitted from projection]") }, debug: { piProjection: { truncated: true } } });
    expect(events.at(-1)?.payload.status).toBe("completed");
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(events)).not.toContain("A".repeat(1000));
    expect(JSON.stringify(input)).toBe(before);
    expect(projector.project(final())[0].eventType).toBe("item.completed");
  });
});

// Keep reason: reproduced audit A P0-3; display limits must not kill native work.
describe("P0-3 bounded display text and arguments", () => {
  it.each(["toolcall_end", "tool_execution_start"])("previews 70KB write arguments from %s and retains tool completion", type => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const args = { path: "big.txt", content: "y".repeat(70_000) };
    const input = type === "toolcall_end" ? update(type, { toolCall: { id: "write-large", name: "write", arguments: args } })
      : { type, toolCallId: "write-large", toolName: "write", args };
    const before = JSON.stringify(input);
    const events = projector.project(input);
    expect(events[0]).toMatchObject({ eventType: "item.started", payload: { toolName: "write", input: expect.stringContaining("[Pi projection truncated]") }, debug: { piProjection: { truncated: true } } });
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(envelope(event, 0)))).toBeLessThan(256 * 1024);
    const end = projector.project({ type: "tool_execution_end", toolCallId: "write-large", toolName: "write", result: { content: [{ type: "text", text: "ok" }] } });
    expect(end[0]).toMatchObject({ eventType: "item.completed", itemId: events[0].itemId, payload: { toolName: "write", output: "ok" } });
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["x", "🌍\\\"\n"])("previews oversized assistant final text without losing terminal status (%j)", alphabet => {
    const input = final({ content: [{ type: "text", text: alphabet.repeat(70_000 / alphabet.length) }] });
    const before = JSON.stringify(input);
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(input);
    expect(events[0]).toMatchObject({ eventType: "item.completed", payload: { text: expect.stringContaining("[Pi projection truncated]") }, debug: { piProjection: { truncated: true } } });
    expect(Buffer.byteLength(JSON.stringify(envelope(events[0], 0)))).toBeLessThan(256 * 1024);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("bounds cumulative streamed text and emits the truncation marker only once", () => {
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const events = Array.from({ length: 100 }, () => projector.project(update("text_delta", { delta: "x".repeat(2000) }))).flat();
    const streamed = events.filter(event => event.eventType === "item.delta").map(event => event.payload.text).join("");
    expect(streamed).toContain("[Pi projection truncated]");
    expect(streamed.match(/\[Pi projection truncated\]/g)).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(streamed))).toBeLessThanOrEqual(64 * 1024);
    expect(projector.project(final({ content: [{ type: "text", text: "x".repeat(200_000) }] }))[0]).toMatchObject({ eventType: "item.completed", payload: { text: expect.stringContaining("[Pi projection truncated]") } });
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
    expect(emitted).toMatchObject([
      { eventType: "item.completed", itemId: "t:pi-message:1:block:0", payload: { text: "authoritative", channel: "final" } },
      { eventType: "usage.reported", payload: { runDeltaAvailable: false, accountingComplete: false } },
    ]);
    expect(projector.project(final({ content: [{ type: "text", text: "authoritative" }] }))).toEqual([]);
  });
  it("supports final-only text and keeps reasoning separate without signatures", () => {
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t", includeThinking: true });
    const events = projector.project(final({ content: [{ type: "thinking", thinking: "reason", thinkingSignature: "private-signature" }, { type: "text", text: "answer" }] }));
    expect(events.filter(event => event.eventType === "item.completed").map(event => event.payload.kind)).toEqual(["reasoning", "agentMessage"]);
    expect(events[0].payload.channel).toBe("detail");
    expect(JSON.stringify(events)).not.toContain("signature");
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ content: [{ type: "thinking", thinking: "private" }] }))).toMatchObject([
      { eventType: "usage.reported", payload: { runDeltaAvailable: false, accountingComplete: false } },
    ]);
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
    const missing = projector.project(final());
    expect(missing.some(event => event.payload.kind === "usage")).toBe(false);
    expect(missing.find(event => event.eventType === "usage.reported")?.payload).toMatchObject({ runDeltaAvailable: false, runDelta: {}, accountingComplete: false });
    expect(validatePrpEvent(envelope(missing.at(-1)!, 0))).toMatchObject({ ok: true });
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
    expect(events).toMatchObject([
      { eventType: "item.failed", itemId: partial[0].itemId, payload: { text: "" } },
      { eventType: "usage.reported", payload: { runDeltaAvailable: false, accountingComplete: false } },
    ]);
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
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "tool_execution_start", toolCallId: "deep", toolName: "read", args: deep })).toThrow(/depth_limit/);
  });
  it("rejects missing IDs, changed receipts and bounds instead of silently approving truncation", () => {
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "tool_execution_start", toolName: "bash" })).toThrow(/id_missing/);
    expect(() => createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project(final({ responseId: undefined, timestamp: undefined }))).toThrow(/identity_missing/);
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "unknown", body: "x".repeat(262145) })[0]).toMatchObject({ eventType: "harness.diagnostic", payload: { code: "pi_unknown_event" } });
    const projector = createPiEventProjector({ runId: "pi-capture", turnId: "t" }); projector.project(final());
    expect(() => projector.project(final({ content: [] }))).toThrow(/conflicting_receipt/);
  });
});
