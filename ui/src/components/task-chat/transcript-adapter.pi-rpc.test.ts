import { describe, expect, it } from "vitest";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import { expectedReplies, expectedUsage, interruptedTerminal, piPersisted, piRpcGoldens } from "../transcript/fixtures/pi-rpc-goldens";
import { transcriptToTaskChatItems } from "./transcript-adapter";

const itemsFor = (name: string) => transcriptToTaskChatItems(nativeRunEventsToTranscript(piPersisted(piRpcGoldens[name])), { runId: "pi-capture", agentName: "Pi", running: false });
describe("recorded Pi goldens through the task-chat view model (canonical, provider-neutral)", () => {
  for (const [name, events] of Object.entries(piRpcGoldens)) {
    it(`${name}: exact final replies, separate thinking, known usage and no invented children`, () => {
      const transcript = nativeRunEventsToTranscript(piPersisted(events));
      const items = transcriptToTaskChatItems(transcript, { runId: "pi-capture", running: false });
      const messages = items.filter(item => item.kind === "message");
      expect(messages.map(item => item.text)).toEqual(expectedReplies(events).length ? expectedReplies(events) : name === "abort" ? ["Tool f"] : []);
      if (expectedReplies(events).length) {
        // Queue's replies have identical prose. Compare identities as well so
        // reversing them cannot pass a text-only assertion.
        expect(messages.map(item => {
          const entry = transcript[item.transcriptIndex!];
          return entry.kind === "assistant" ? entry.itemId : undefined;
        })).toEqual(events.filter(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage").map(event => event.itemId));
      }
      expect(items.some(item => item.kind === "subagent_group")).toBe(false);
      const thinking = events.filter(event => event.eventType === "item.completed" && event.payload.kind === "reasoning").map(event => event.payload.text);
      if (thinking.length) expect(items.filter(item => item.kind === "thinking").map(item => item.lines.join("\n"))).toEqual(thinking);
      const usage = items.filter(item => item.kind === "usage");
      if (events.some(event => event.eventType === "usage.reported")) {
        expect(usage.at(-1)?.usage.inputTokens).toBe(expectedUsage(events, "inputTokens"));
        expect(usage.at(-1)?.usage.outputTokens).toBe(expectedUsage(events, "outputTokens"));
        expect(usage.at(-1)?.usage.used).toBe(expectedUsage(events, "inputTokens") + expectedUsage(events, "outputTokens") + expectedUsage(events, "cacheReadTokens"));
        expect(usage.at(-1)?.usage.costUsd).toBeUndefined();
        expect(usage.at(-1)?.detail).toContain("unknown");
      } else expect(usage).toEqual([]);
    });
  }
  it("baseline: exact Bash command/output and failure on its own call", () => {
    const tools = itemsFor("baseline").filter(item => item.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ target: "printf 'pi-native-tool-ok\\n'", status: "completed", detail: expect.stringContaining("pi-native-tool-ok") });
    expect(tools[1]).toMatchObject({ target: "printf 'pi-native-tool-error\\n' >&2; exit 7", status: "failed", detail: expect.stringContaining("code 7") });
    expect(tools[0].id).not.toBe(tools[1].id);
  });
  it("compaction notice and driver-governed stopped turn survive conversion", () => {
    expect(itemsFor("compaction")).toContainEqual(expect.objectContaining({ kind: "marker", variant: "context_compacted" }));
    expect(itemsFor("compaction").filter(item => item.kind === "usage").at(-1)?.detail).toContain("Additional usage unknown");
    const items = transcriptToTaskChatItems(nativeRunEventsToTranscript(piPersisted([...piRpcGoldens.abort, interruptedTerminal])), { runId: "pi-capture", running: false });
    expect(items).toContainEqual(expect.objectContaining({ kind: "protocol", surface: "run_terminal", turnState: "interrupted", runState: "cancelled" }));
    expect(itemsFor("abort").some(item => item.kind === "protocol" && item.surface === "run_terminal")).toBe(false);
  });
  it("subagent usage remains explicitly unknown; extension output remains quarantined", () => {
    expect(itemsFor("subagent").filter(item => item.kind === "usage").at(-1)?.detail).toContain("Child usage unknown");
    expect(itemsFor("extension")).toEqual([]);
  });
  it("keeps canonical reasoning separate from a completed reply (synthetic boundary)", () => {
    const transcript = nativeRunEventsToTranscript(piPersisted([
      { eventType: "item.delta", itemId: "thought", payload: { kind: "reasoning", channel: "detail", text: "Think" } },
      { eventType: "item.completed", itemId: "thought", payload: { kind: "reasoning", channel: "detail", text: "Think carefully" } },
      { eventType: "item.completed", itemId: "reply", payload: { kind: "agentMessage", channel: "final", text: "Answer" } },
    ]));
    const items = transcriptToTaskChatItems(transcript, { runId: "thinking-boundary", running: false });
    expect(items.filter(item => item.kind === "thinking").map(item => item.lines.join("\n"))).toEqual(["Think carefully"]);
    expect(items.filter(item => item.kind === "message").map(item => item.text)).toEqual(["Answer"]);
  });
  it("missing usage stays unknown rather than a free zero-token run", () => {
    const transcript = nativeRunEventsToTranscript(piPersisted([{ eventType: "usage.reported", payload: { runDeltaAvailable: true, runDelta: {} } }]));
    const items = transcriptToTaskChatItems(transcript, { runId: "missing", running: false });
    expect(items).toContainEqual(expect.objectContaining({ kind: "usage", label: "Usage unknown", usage: expect.not.objectContaining({ inputTokens: 0, outputTokens: 0 }) }));
  });
});
