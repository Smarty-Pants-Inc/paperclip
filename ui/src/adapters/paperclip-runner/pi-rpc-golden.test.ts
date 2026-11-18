import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { paperclipRunnerUIAdapter } from "./index";
import { buildTranscript } from "../transcript";
import { normalizeTranscript } from "../../components/transcript/RunTranscriptView";
import { transcriptToTaskChatItems } from "../../components/task-chat/transcript-adapter";
import { captureTs, expectedReplies, expectedUsage, interruptedTerminal, piEnvelope, piRpcGoldens, type RecordedEvent } from "../../components/transcript/fixtures/pi-rpc-goldens";

function replay(events: readonly RecordedEvent[]): TranscriptEntry[] {
  const parser = paperclipRunnerUIAdapter.createStdoutParser!();
  return events.flatMap((event, index) => parser.parseLine(JSON.stringify({ type: "paperclip.prp.event", event: piEnvelope(event, index) }), captureTs));
}
function replies(entries: TranscriptEntry[]) {
  return transcriptToTaskChatItems(entries, { runId: "log", running: false }).filter(item => item.kind === "message").map(item => item.text);
}
describe("every recorded Pi golden through the stateful run-log fallback", () => {
  for (const [name, events] of Object.entries(piRpcGoldens)) {
    it(`${name}: exact replies once and totals from message deltas, not cumulative snapshots`, () => {
      const entries = replay(events);
      const expected = expectedReplies(events).length ? expectedReplies(events) : name === "abort" ? ["Tool f"] : [];
      expect(replies(entries)).toEqual(expected);
      // Exercise the same log-buffer builder and nice renderer as the run log,
      // not only a flatMap stand-in. Final receipts upgrade unknown channels.
      const built = buildTranscript([{ ts: captureTs, stream: "stdout", chunk: events.map((event, index) => JSON.stringify({ type: "paperclip.prp.event", event: piEnvelope(event, index) })).join("\n") + "\n" }], paperclipRunnerUIAdapter);
      expect(normalizeTranscript(built, false).filter(block => block.type === "message").map(block => block.text)).toEqual(expected);
      if (expectedReplies(events).length) {
        const messages = transcriptToTaskChatItems(built, { runId: "log", running: false }).filter(item => item.kind === "message");
        expect(messages.every(item => item.channel === "final" && !item.interstitial)).toBe(true);
        expect(messages.map(item => {
          const entry = built[item.transcriptIndex!];
          return entry.kind === "assistant" ? entry.itemId : undefined;
        })).toEqual(events.filter(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage").map(event => event.itemId));
      }
      const usage = entries.filter(entry => entry.kind === "result");
      if (events.some(event => event.eventType === "usage.reported")) {
        expect(usage.reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(expectedUsage(events, "inputTokens"));
        expect(usage.reduce((sum, entry) => sum + entry.outputTokens, 0)).toBe(expectedUsage(events, "outputTokens"));
        expect(usage.reduce((sum, entry) => sum + entry.cachedTokens, 0)).toBe(expectedUsage(events, "cacheReadTokens"));
        expect(usage.every(entry => Number.isNaN(entry.costUsd))).toBe(true);
      } else expect(usage).toEqual([]);
      expect(entries.some(entry => entry.kind === "provider_activity" && entry.family === "delegation")).toBe(false);
    });
  }
  it("baseline keeps reasoning out of replies and correlates Bash output/errors", () => {
    const entries = replay(piRpcGoldens.baseline);
    // Completion can update a call whose arguments arrived after item.started.
    const calls = entries.filter((entry): entry is Extract<TranscriptEntry, { kind: "tool_call" }> => entry.kind === "tool_call" && Object.keys(entry.input as object).length > 0);
    const results = entries.filter(entry => entry.kind === "tool_result" && !entry.delta);
    expect(calls).toHaveLength(2);
    expect(transcriptToTaskChatItems(entries, { runId: "log", running: false }).filter(item => item.kind === "tool")).toHaveLength(2);
    expect(calls[0].input).toEqual({ command: "printf 'pi-native-tool-ok\\n'" });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolUseId: calls[0].toolUseId, content: expect.stringContaining("pi-native-tool-ok"), isError: false });
    expect(results[1]).toMatchObject({ toolUseId: calls[1].toolUseId, content: expect.stringContaining("code 7"), isError: true });
    const thoughts = entries.filter((entry): entry is Extract<TranscriptEntry, { kind: "thinking" }> => entry.kind === "thinking" && Boolean(entry.text)).map(entry => entry.text).join("");
    // The immutable normalized captures opted OUT of thinking. Do not invent it.
    expect(thoughts).toBe("");
    const withThinking = replay([
      { eventType: "item.delta", itemId: "reason", payload: { kind: "reasoning", channel: "detail", text: "Reason" } },
      { eventType: "item.completed", itemId: "reason", payload: { kind: "reasoning", channel: "detail", text: "Reason exactly" } },
      { eventType: "item.completed", itemId: "answer", payload: { kind: "agentMessage", channel: "final", text: "Answer" } },
    ]);
    const items = transcriptToTaskChatItems(withThinking, { runId: "thinking-boundary", running: false });
    expect(items.filter(item => item.kind === "thinking").map(item => item.lines.join("\\n"))).toEqual(["Reason exactly"]);
    expect(replies(withThinking)).toEqual(["Answer"]);
  });
  it("notices compaction, respects governed interruption and renders fenced-extension diagnostic", () => {
    expect(replay(piRpcGoldens.compaction)).toContainEqual(expect.objectContaining({ kind: "provider_activity", eventType: "context.compacted" }));
    expect(replay([...piRpcGoldens.abort, interruptedTerminal])).toContainEqual(expect.objectContaining({ kind: "run_terminal", turnState: "interrupted" }));
    expect(replay(piRpcGoldens.abort).some(entry => entry.kind === "run_terminal")).toBe(false);
    expect(replay(piRpcGoldens.extension)).toEqual([expect.objectContaining({ kind: "system", text: expect.stringContaining("fenced") })]);
    expect(replay(piRpcGoldens.subagent).filter(entry => entry.kind === "result").at(-1)?.text).toContain("Child usage unknown");
  });
  it("reconciles an authoritative final suffix after deltas (synthetic dropped-delta boundary)", () => {
    const events: RecordedEvent[] = [
      { eventType: "item.delta", itemId: "reply", payload: { kind: "agentMessage", channel: "final", text: "Hello " } },
      { eventType: "item.completed", itemId: "reply", payload: { kind: "agentMessage", channel: "final", text: "Hello 🌍!" } },
    ];
    expect(replies(replay(events))).toEqual(["Hello 🌍!"]);
    events[1].payload.text = "Corrected final";
    expect(replies(replay(events))).toEqual(["Corrected final"]);
  });
  it("missing usage is unknown and per-log state resets", () => {
    const entries = replay([{ eventType: "usage.reported", payload: { runDeltaAvailable: true, runDelta: {} } }]);
    expect(entries).toContainEqual(expect.objectContaining({ kind: "result", inputTokens: NaN, outputTokens: NaN, cachedTokens: NaN, costUsd: NaN }));
    const parser = paperclipRunnerUIAdapter.createStdoutParser!();
    const line = JSON.stringify({ type: "paperclip.prp.event", event: { eventType: "item.completed", itemId: "same-id", payload: { kind: "agentMessage", text: "final" } } });
    expect(parser.parseLine(line, captureTs)).toHaveLength(1);
    parser.reset();
    expect(parser.parseLine(line, captureTs)).toHaveLength(1);
  });
});
