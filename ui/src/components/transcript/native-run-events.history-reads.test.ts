import { describe, expect, it } from "vitest";
import { nativeRunEventsToTranscript } from "./native-run-events";
import { splitTranscriptAtAnchors, steeringDeliveryPoints } from "../task-chat/transcript-adapter";
import { chatHistoryReadEvents, compactChatHistoryReadEvents, continuousChatHistoryReadEvents, historyReadAt, historyReadRunA,
  historyReadRunB, omitHistoryReads } from "../../../../server/src/__tests__/fixtures/chat-history-reads";

describe("continuous heartbeat history read projection", () => {
  for (const compact of [false, true]) for (const opening of [false, true]) for (const steer of [false, true]) {
    it(`compact=${compact}, opening=${opening}, steer=${steer}`, () => {
      const entries = nativeRunEventsToTranscript(continuousChatHistoryReadEvents(compact, opening, steer));
      const delivery = steeringDeliveryPoints(entries);
      expect(delivery.byQuestion.has("request-b")).toBe(steer);
      expect(delivery.byQuestion.has("steer-b")).toBe(opening && steer);
      if (steer) expect(delivery.byQuestion.get("request-b")?.atMs)
        .toBe(Date.parse(historyReadAt(opening ? 32 : 38)));
      const reads = ["request-b", "steer-b"].map(id => delivery.byQuestion.get(id));
      const segments = splitTranscriptAtAnchors(entries, Date.parse(historyReadAt(0)),
        reads.map(read => read?.atMs ?? Infinity), undefined, reads.map(read => read?.afterEventSeq));
      const segmentOf = (id: string) => segments.findIndex(segment => segment.entries.some(entry => "itemId" in entry && entry.itemId === id));
      expect(segmentOf("a-final")).toBe(0);
      expect(segmentOf("b-reason-before")).toBe(opening && steer ? 1 : 0);
      expect(segmentOf("b-reason-after")).toBe(steer ? opening ? 2 : 1 : 0);
      expect(segmentOf("b-final")).toBe(steer ? opening ? 2 : 1 : 0);
    });
  }
});

describe("two-turn history read projection", () => {
  for (const compact of [false, true]) for (const opening of [false, true]) for (const steer of [false, true]) {
    it(`compact=${compact}, opening=${opening}, steer=${steer}`, () => {
      const source = compact ? compactChatHistoryReadEvents : chatHistoryReadEvents;
      const a = nativeRunEventsToTranscript(omitHistoryReads(source(historyReadRunA), opening, steer));
      const b = nativeRunEventsToTranscript(omitHistoryReads(source(historyReadRunB), opening, steer));
      expect(a.find(entry => entry.kind === "assistant")).toMatchObject({ text: "A final answer.", itemId: "a-final", eventSeq: 5 });
      const delivery = steeringDeliveryPoints(b);
      expect(delivery.opening?.afterEventSeq).toBe(opening ? 2 : steer ? 8 : undefined);
      expect(delivery.byQuestion.has("steer-b")).toBe(opening && steer);
      const read = delivery.byQuestion.get("steer-b");
      if (read) expect(read).toEqual({ atMs: Date.parse(historyReadAt(38)), afterEventSeq: 8 });
      const segments = splitTranscriptAtAnchors(b, Date.parse(historyReadAt(31)),
        [read?.atMs ?? Infinity], undefined, [read?.afterEventSeq]);
      const reasoning = segments.map(segment => segment.entries.filter(entry => entry.kind === "thinking").map(entry => entry.text));
      expect(reasoning).toEqual(opening && steer
        ? [["B reasoning before read."], ["B reasoning after read."]]
        : [["B reasoning before read.", "B reasoning after read."], []]);
      // A's authored final remains independent of a later turn's read evidence.
      expect(a.find(entry => entry.kind === "assistant")?.ts).toBe(historyReadAt(20));
    });
  }
});
