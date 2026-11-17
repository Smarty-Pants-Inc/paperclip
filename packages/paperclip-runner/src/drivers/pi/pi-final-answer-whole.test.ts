import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCodeProxyItemNotification, openCodeProxyToolNotification } from "../../cli/opencode-proxy-events.js";
import { FakeCodexTransport, makeDriver, collectUntilTerminal, WORKSPACE, result } from "../codex/codex-app-server-driver.test-support.js";
import { redactProviderDiagnostic } from "../diagnostic-redaction.js";

// Keep: gate-1 run 5184ca23 lost its final at the facade's retained-payload
// boundary. Exercise the production projector -> facade mapper -> real Codex
// notification pump, not just the (already passing) projector snapshot.
async function facadeCompletion(answer: string, kind = "agentMessage", spillDirectory?: string) {
  const projected = createPiEventProjector({ runId: "run", turnId: "turn-1", includeThinking: true, spillDirectory }).project({
    type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", responseId: "reply-1", stopReason: "stop",
      content: [kind === "reasoning" ? { type: "thinking", thinking: answer } : { type: "text", text: answer }] },
  }).find(event => event.eventType === "item.completed" && event.payload.kind === kind)!;
  const payload = kind === "agentMessage" ? { ...projected.payload, item: { phase: "final_answer" } } : projected.payload;
  return emitCompletion(openCodeProxyItemNotification({ eventType: "item.completed", threadId: "thread-1", turnId: "turn-1", itemId: "answer", payload }).params);
}
async function emitCompletion(params: Record<string, unknown>) {
  return (await emitNotifications([{ method: "item/completed", params }])).filter(event => event.eventType === "item.completed" && event.itemId === "answer");
}
async function emitNotifications(notifications: { method: string; params: Record<string, unknown> }[]) {
  const transport = new FakeCodexTransport();
  const session = await makeDriver([transport], { driverIdentity: { kind: "pi_rpc" } }).openSession({ runId: "run", normalizedSessionId: "session", workingDirectory: WORKSPACE });
  try {
    await session.startTurn({ message: { role: "user", text: "Answer whole." } });
    for (const notification of notifications) transport.push(notification.method, notification.params);
    transport.push("paperclip/runResult", { threadId: "thread-1", turnId: "turn-1", result });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    return await collectUntilTerminal(session.events());
  } finally { await session.close({ reason: "fixture complete" }); }
}

describe("PACK retained final text across the Pi facade", () => {
  it.each([40_000, 66 * 1024, 100 * 1024])("retains a %i-byte final once and byte-equal in item.completed", async size => {
    const answer = "x".repeat(size - 8) + "THE_END!";
    const events = await facadeCompletion(answer);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.kind).toBe("agentMessage");
    expect(events[0]!.payload.channel).toBe("final");
    expect(Buffer.from(String(events[0]!.payload.text))).toEqual(Buffer.from(answer));
    expect(JSON.stringify(events[0]!.payload).split("THE_END!")).toHaveLength(2);
    expect(events[0]!.payload.item).not.toHaveProperty("text");
    expect(events[0]!.payload).not.toHaveProperty("truncated");
  });
  it("retains 40,000 Unicode/escaped characters through the facade, not just the projector", async () => {
    const unit = "Line \"quoted\" 🦀 naïve\n";
    const answer = Array.from(unit.repeat(2500)).slice(0, 40_000).join("");
    const [event] = await facadeCompletion(answer);
    expect(Array.from(answer)).toHaveLength(40_000);
    expect(Buffer.from(String(event!.payload.text))).toEqual(Buffer.from(answer));
  });
  it("keeps a near-budget inline answer inside the existing 256 KiB record limit", async () => {
    const answer = "x".repeat(249 * 1024);
    const [event] = await facadeCompletion(answer);
    expect(event!.payload.text).toBe(answer);
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
  });
  it("retains reasoning once through the same completion boundary", async () => {
    const answer = "r".repeat(100 * 1024);
    const [event] = await facadeCompletion(answer, "reasoning");
    expect(event!.payload.text).toBe(answer);
    expect(event!.payload.item).not.toHaveProperty("text");
  });
  it("extracts native reasoning summary parts once while bounding other item fields", async () => {
    const answer = "r".repeat(66 * 1024);
    const [event] = await emitCompletion({ threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "reasoning", summary: [{ text: answer }], extra: "m".repeat(40_000) } });
    expect(event!.payload.text).toBe(answer);
    expect(event!.payload.item).not.toHaveProperty("summary");
    expect(String((event!.payload.item as Record<string, unknown>).extra).length).toBeLessThan(40_000);
  });
  it("keeps n5e's plain line, labelled excerpt and full redacted text above 250 KiB", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pack-n5e-"));
    try {
      const answer = "a".repeat(50 * 1024) + "\nAuthorization: Bearer pack-spill-fixture\n" + "a".repeat(210 * 1024);
      const safeAnswer = redactProviderDiagnostic(answer);
      const [event] = await facadeCompletion(answer, "agentMessage", directory);
      expect(event!.payload.text).toMatch(/^This answer is longer than one message/);
      expect(event!.payload.text).toContain("Excerpt (the start of the answer, not the whole answer):");
      expect(event!.payload).not.toHaveProperty("truncated");
      const full = event!.payload.fullText as { path: string; bytes: number };
      expect(full.bytes).toBe(Buffer.byteLength(safeAnswer));
      expect(await readFile(full.path, "utf8")).toBe(safeAnswer);
      expect(JSON.stringify(event)).not.toContain("pack-spill-fixture");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("redacts an Authorization Bearer fixture after 50 KB without losing surrounding text", async () => {
    const answer = "x".repeat(50 * 1024) + "\nAuthorization: Bearer pack-secret-fixture\nend";
    const [event] = await facadeCompletion(answer);
    expect(event!.payload.text).toBe(redactProviderDiagnostic(answer));
    expect(JSON.stringify(event)).not.toContain("pack-secret-fixture");
    // Also prove redaction at the retained-payload boundary, without trusting
    // the upstream projector to have done it first.
    const [raw] = await emitCompletion({ threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: answer } });
    expect(raw!.payload.text).toBe(redactProviderDiagnostic(answer));
    expect(JSON.stringify(raw)).not.toContain("pack-secret-fixture");
  });
  it("bounds oversized metadata inside the item without replacing the message", async () => {
    const [event] = await emitCompletion({ threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: "whole answer", a: "x".repeat(32 * 1024), b: "y".repeat(32 * 1024), c: "z".repeat(32 * 1024) } });
    expect(event!.payload.text).toBe("whole answer");
    expect(event!.payload.kind).toBe("agentMessage");
    expect(event!.payload).not.toHaveProperty("truncated");
    expect(event!.payload.item).toMatchObject({ truncated: true, byteSize: expect.any(Number) });
  });
  it("NEGATIVE: still bounds a non-message payload above 64 KiB", async () => {
    const [event] = await emitCompletion({ threadId: "thread-1", turnId: "turn-1", item: { id: "answer", type: "custom", text: "x".repeat(66 * 1024) } });
    expect(event!.payload).toMatchObject({ truncated: true, byteSize: expect.any(Number) });
    expect(event!.payload).not.toHaveProperty("text");
  });
});

// Keep: rf-2 found the generic 32 KiB bound still cut individual streamed pages.
// Exercise projector -> production facade mapper -> notification pump, including
// reasoning (which must use a supported native delta method, not item/delta).
async function facadeDelta(answer: string, kind = "agentMessage") {
  const projector = createPiEventProjector({ runId: "run", turnId: "turn-1", includeThinking: true });
  const projected = projector.project({ type: "message_update", assistantMessageEvent: {
    type: kind === "reasoning" ? "thinking_delta" : "text_delta", contentIndex: 0, delta: answer,
  } });
  return (await emitNotifications(projected.filter(event => event.eventType === "item.delta").map(event =>
    openCodeProxyItemNotification({ eventType: "item.delta", threadId: "thread-1", turnId: "turn-1", itemId: event.itemId, payload: event.payload }),
  ))).filter(event => event.eventType === "item.delta");
}

describe("PACK retained streamed text across the Pi facade", () => {
  it.each([
    { kind: "agentMessage", size: 96 * 1024 },
    { kind: "reasoning", size: 40_000 },
    { kind: "agentMessage", size: 200 * 1024 },
  ])("retains a $size-byte $kind delta whole and in order across bounded pages", async ({ kind, size }) => {
    const answer = "0123456789".repeat(Math.ceil(size / 10)).slice(0, size - 8) + "THE_END!";
    const events = await facadeDelta(answer, kind);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(event => event.payload.text).join("")).toBe(answer);
    expect(events.every(event => event.payload.kind === kind)).toBe(true);
    if (size > 96 * 1024) expect(events.length).toBeGreaterThan(1);
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      expect(Buffer.byteLength(JSON.stringify(event.payload.text))).toBeLessThanOrEqual(96 * 1024);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
      expect(JSON.stringify(event)).not.toMatch(/truncated/i);
      expect(event.payload.update).not.toHaveProperty("delta");
      if (index > 0) expect(event.sourceSeq).toBeGreaterThan(events[index - 1]!.sourceSeq);
    }
  });
  it("keeps Unicode and escaped delta pages whole", async () => {
    const answer = "😀\\\"\n漢字".repeat(20_000);
    const events = await facadeDelta(answer);
    expect(events.map(event => event.payload.text).join("")).toBe(answer);
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
  });
  it("redacts a Bearer fixture after 40 KB both through projection and at the delta boundary", async () => {
    const answer = "x".repeat(40_000) + "\nAuthorization: Bearer pack-delta-fixture\nEND";
    const safe = redactProviderDiagnostic(answer);
    const projected = await facadeDelta(answer);
    expect(projected.map(event => event.payload.text).join("")).toBe(safe);
    const raw = (await emitNotifications([{ method: "item/agentMessage/delta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: answer,
    } }])).filter(event => event.eventType === "item.delta");
    expect(raw.map(event => event.payload.text).join("")).toBe(safe);
    expect(JSON.stringify([projected, raw])).not.toContain("pack-delta-fixture");
  });
  it.each(["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"])("pages an oversized native %s delta after whole-string redaction", async method => {
    // Put the credential across the page boundary; redacting each page later
    // would expose the suffix. The pump must also page non-projector inputs.
    const answer = "x".repeat(96 * 1024 - 20) + "\nAuthorization: Bearer pack-boundary-fixture\n" + "y".repeat(110 * 1024);
    const events = (await emitNotifications([{ method, params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: answer,
    } }])).filter(event => event.eventType === "item.delta");
    expect(events.length).toBeGreaterThan(1);
    expect(events.map(event => event.payload.text).join("")).toBe(redactProviderDiagnostic(answer));
    expect(JSON.stringify(events)).not.toContain("pack-boundary-fixture");
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event.payload.text))).toBeLessThanOrEqual(96 * 1024);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
      expect(event.payload.update).not.toHaveProperty("delta");
    }
  });
  it("NEGATIVE: non-prose delta kinds retain the existing bound", async () => {
    const events = (await emitNotifications([{ method: "item/plan/delta", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "plan", delta: "p".repeat(40_000),
    } }])).filter(event => event.eventType === "item.delta");
    expect(events).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(events[0]!.payload))).toBeLessThan(64 * 1024);
    expect(JSON.stringify(events)).not.toContain("p".repeat(40_000));
  });
  it("NEGATIVE: tool output stays bounded with a readable full-output spill, never a bare cut marker", async () => {
    const output = "x".repeat(40_000) + "\nAuthorization: Bearer pack-tool-fixture\nTOOL_END";
    const projector = createPiEventProjector({ runId: "run", turnId: "turn-1" });
    const projected = projector.project({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read",
      result: { content: [{ type: "text", text: output }] } });
    const activity = projected.find(event => event.eventType === "tool.execution.completed")!;
    const notification = openCodeProxyToolNotification({ eventType: activity.eventType, threadId: "thread-1", turnId: "turn-1", payload: activity.payload })!;
    const events = await emitNotifications([notification]);
    const event = events.find(event => event.eventType === "item.completed" && event.itemId === activity.payload.executionId)!;
    expect(event?.payload).toHaveProperty("item");
    const shown = String((event.payload.item as Record<string, unknown>).output);
    expect(shown).not.toContain("[truncated]");
    expect(shown.length).toBeLessThan(32 * 1024);
    const path = /\[Full output: (\/[^\s\]]+)/u.exec(shown)?.[1];
    expect(path).toBeTruthy();
    expect(await readFile(path!, "utf8")).toBe(redactProviderDiagnostic(output));
    expect(JSON.stringify(events)).not.toContain("pack-tool-fixture");
    expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThan(64 * 1024);
  });
});

// C4 (pack-n5), TypeScript half: a 40,000-character Pi final answer read from a
// raw Pi RPC JSONL record is projected whole (byte-equal), with no marker.
describe("C4 Pi final answer is projected whole", () => {
  it("projects a 40,000-character final answer byte-equal to the raw JSONL text", () => {
    const unit = "Line \"quoted\" 🦀 naïve\n";
    const answer = Array.from(unit.repeat(Math.ceil(40_000 / Array.from(unit).length))).slice(0, 40_000).join("");
    expect(Array.from(answer)).toHaveLength(40_000);
    const rawJsonl = JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 1,
      responseId: "reply-1", stopReason: "stop", content: [{ type: "text", text: answer }] } });
    const raw = JSON.parse(rawJsonl);
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(raw);
    const completed = events.find(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage");
    expect(completed?.payload.channel).toBe("final");
    const text = String(completed?.payload.text);
    expect(Buffer.from(text, "utf8").equals(Buffer.from(raw.message.content[0].text, "utf8"))).toBe(true);
    expect(text).not.toMatch(/truncated/i);
  });
});
