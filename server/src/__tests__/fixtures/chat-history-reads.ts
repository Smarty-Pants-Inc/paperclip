import type { HeartbeatRunEvent } from "@paperclipai/shared";

// Synthetic, two-turn stream: B starts ten seconds after A finishes, in the
// same session. Both the SQL retention test and the page consume these rows.
export const historyReadRunA = "10000000-0000-4000-8000-000000000001";
export const historyReadRunB = "10000000-0000-4000-8000-000000000002";
export const historyReadAt = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

export function chatHistoryReadEvents(runId: string): HeartbeatRunEvent[] {
  const isB = runId === historyReadRunB;
  const turnId = isB ? "turn-b" : "turn-a";
  function event(seq: number, second: number, eventType: string, itemId: string | undefined,
    payload: Record<string, unknown>): HeartbeatRunEvent {
    return { id: seq, companyId: "10000000-0000-4000-8000-000000000003", runId,
      agentId: "10000000-0000-4000-8000-000000000004", seq, eventType,
      stream: "system", level: "info", color: null, message: null,
      createdAt: new Date(historyReadAt(second)), payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner",
        sourceInstanceId: "fixture-runner", sourceEventId: `${turnId}:${seq}`, sourceSeq: seq,
        runId, turnId, itemId, normalizedSessionId: "shared-session", eventType,
        emittedAt: historyReadAt(second), payload,
      } } };
  }
  const message = (seq: number, second: number, itemId: string, kind: string, text: string) =>
    event(seq, second, "item.completed", itemId, { kind, item: { id: itemId, type: kind, text },
      ...(kind === "agentMessage" ? { channel: "final" } : {}) });
  return isB ? [
    event(1, 31, "lifecycle", undefined, { diagnostic: true }),
    event(2, 32, "item.started", "b-input", { kind: "user_message", item: { id: "b-input", type: "user_message", text: "" } }),
    event(3, 32, "item.completed", "b-input", { item: { id: "b-input" } }),
    message(4, 33, "b-reason-before", "reasoning", "B reasoning before read."),
    event(5, 34, "item.completed", "b-progress", { kind: "agentMessage", channel: "progress", text: "B opening line." }),
    event(6, 35, "item.started", "b-tool", { kind: "tool_use", item: { id: "b-tool", type: "tool_use", name: "read", input: { path: "b-fixture.ts" } } }),
    event(7, 37, "item.completed", "turn-b:steer:steer-b", { kind: "steering_acknowledgement" }),
    event(8, 38, "item.started", "b-steer-input", { item: { id: "b-steer-input", type: "userMessage", text: "" } }),
    event(9, 38, "item.completed", "b-steer-input", {}),
    message(10, 39, "b-reason-after", "reasoning", "B reasoning after read."),
    message(11, 40, "b-final", "agentMessage", "B final answer."),
  ] : [
    event(1, 0, "item.started", "a-input", { kind: "userMessage", item: { id: "a-input", type: "userMessage", text: "" } }),
    message(2, 1, "a-reason", "reasoning", "A reasoning."),
    event(3, 2, "item.started", "a-tool", { kind: "tool_use", item: { id: "a-tool", type: "tool_use", name: "read", input: { path: "a-fixture.ts" } } }),
    event(4, 3, "item.completed", "a-tool", { kind: "tool_result", item: { id: "a-tool", type: "tool_result", tool_use_id: "a-tool", result: "ok" } }),
    message(5, 20, "a-final", "agentMessage", "A final answer."),
    event(6, 21, "turn.completed", undefined, {}),
  ];
}

// Expected compact response contract, checked against PostgreSQL by the server
// test. These are response fixtures, not a reimplementation of the SQL filter.
export function compactChatHistoryReadEvents(runId: string): HeartbeatRunEvent[] {
  return chatHistoryReadEvents(runId).filter(event => event.eventType !== "lifecycle");
}

// A continuous heartbeat can answer A, then take the message starting B as
// a steer in the SAME PRP turn. This is distinct from two heartbeat runs.
export function continuousChatHistoryReadEvents(compact: boolean, opening: boolean, steer: boolean): HeartbeatRunEvent[] {
  const a = chatHistoryReadEvents(historyReadRunA).filter(event => event.eventType !== "turn.completed");
  const b = chatHistoryReadEvents(historyReadRunB);
  const ack: HeartbeatRunEvent = { ...b[6]!, seq: 4, createdAt: new Date(historyReadAt(31)), payload: {
    prpEvent: { ...(b[6]!.payload!.prpEvent as object), itemId: "turn-a:steer:request-b", emittedAt: historyReadAt(31) },
  } };
  const combined = [...a, ack, ...b].map((event, index) => ({ ...event, id: index + 1, seq: index + 1, runId: historyReadRunA,
    payload: { prpEvent: { ...(event.payload!.prpEvent as object), runId: historyReadRunA, turnId: "turn-a",
      sourceSeq: index + 1, sourceEventId: `continuous:${index + 1}` } },
  }));
  return combined.filter(event => {
    const id = (event.payload.prpEvent as Record<string, unknown>).itemId;
    return (opening || id !== "a-input") &&
      // Keep ACKs in every read-omission case: acknowledgement is not a read.
      (steer || !["b-input", "b-steer-input"].includes(String(id))) &&
      (!compact || event.eventType !== "lifecycle");
  });
}

export function omitHistoryReads(events: HeartbeatRunEvent[], opening: boolean, steer: boolean): HeartbeatRunEvent[] {
  return events.filter(event => {
    const envelope = event.payload!.prpEvent as Record<string, unknown>;
    const id = envelope.itemId;
    return (opening || (id !== "a-input" && id !== "b-input")) &&
      (steer || id !== "b-steer-input");
  });
}
