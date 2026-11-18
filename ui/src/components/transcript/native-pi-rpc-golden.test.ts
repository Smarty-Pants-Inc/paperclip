import { readFileSync } from "node:fs";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { projectPiRecording } from "../../../../packages/paperclip-runner/test-support/pi-rpc-golden";
import { nativeRunEventsToTranscript } from "./native-run-events";

const fixture = (name: string) => readFileSync(new URL(`../../../../packages/paperclip-runner/test-fixtures/pi-rpc/${name}`, import.meta.url), "utf8");
function persisted(name: string): HeartbeatRunEvent[] {
  const wire = fixture(name).trim().split("\n").map(line => JSON.parse(line));
  return projectPiRecording(wire, name.startsWith("extension-")).map((event, index) => ({
    id: index + 1, companyId: "controlled-peer", runId: event.runId, agentId: "capture", seq: index + 1,
    eventType: event.eventType, stream: "system", level: "info", color: null, message: null,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `pi-${index + 1}`, sourceSeq: index + 1, sourceInstanceId: "pi-capture", sourceKind: "runner", priority: 1, normalizedSessionId: "pi-session", emittedAt: "2026-11-12T06:18:00.000Z", ...event } },
    createdAt: new Date("2026-11-12T06:18:00.000Z"),
  }));
}

describe("real native Pi RPC recordings through the app's native task-chat consumer", () => {
  it("preserves exact input and correlated tool errors, text and per-message usage", () => {
    const transcript = nativeRunEventsToTranscript(persisted("baseline-1.5.2.jsonl"));
    expect(transcript.filter(entry => entry.kind === "assistant").map(entry => entry.text)).toEqual(["Hello 🌍\u2028line", "Tool succeeded.", "Tool failure was observed."]);
    const calls = transcript.filter(entry => entry.kind === "tool_call");
    const results = transcript.filter(entry => entry.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect(results.map(entry => entry.isError)).toEqual([false, true]);
    for (const result of results) expect(calls.some(call => call.toolUseId === result.toolUseId)).toBe(true);
    expect(calls).toContainEqual(expect.objectContaining({ input: { command: "printf 'pi-native-tool-ok\\n'" } }));
    expect(calls).toContainEqual(expect.objectContaining({ input: { command: "printf 'pi-native-tool-error\\n' >&2; exit 7" } }));
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "result", subtype: "paperclip_runner_usage", inputTokens: 57, outputTokens: 15, cachedTokens: 10 }));
  });
  it("shows a real successful compaction, not a fabricated summary reply", () => {
    const transcript = nativeRunEventsToTranscript(persisted("compaction-1.5.2.jsonl"));
    expect(transcript).toContainEqual(expect.objectContaining({ kind: "provider_activity", eventType: "context.compacted", payload: expect.objectContaining({ preTokens: 3903, postTokens: expect.any(Number), sameSession: true }) }));
  });
  it("fences an extension-started turn without prompt authority", () => {
    expect(nativeRunEventsToTranscript(persisted("extension-1.5.2.jsonl")).some(entry => ["assistant", "tool_call", "tool_result", "result"].includes(entry.kind))).toBe(false);
  });
  it("requires the driver's governed terminal record rather than inferring Done from text", () => {
    const rows = persisted("abort-1.5.2.jsonl");
    expect(nativeRunEventsToTranscript(rows).some(entry => entry.kind === "run_terminal")).toBe(false);
    const last = rows.at(-1)!;
    const base = last.payload!.prpEvent as Record<string, unknown>;
    rows.push({ ...last, id: last.id + 1, seq: last.seq + 1, eventType: "run.terminal", payload: { prpEvent: { ...base, sourceEventId: "governed-driver-terminal", sourceSeq: last.seq + 1, eventType: "run.terminal", payload: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "yielded" } } } });
    expect(nativeRunEventsToTranscript(rows)).toContainEqual(expect.objectContaining({ kind: "run_terminal", turnState: "interrupted", runState: "cancelled", disposition: "yielded" }));
  });
});
