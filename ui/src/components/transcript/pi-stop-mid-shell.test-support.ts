import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { projectPiRecording } from "../../../../packages/paperclip-runner/test-support/pi-rpc-golden";

/** Real Pi projector output, persisted as the server stores run events. */
export function persistedPiWire(wire: Record<string, unknown>[], fenced = false): HeartbeatRunEvent[] {
  return projectPiRecording(wire, fenced).map((event, index) => ({
    id: index + 1, companyId: "controlled-peer", runId: event.runId, agentId: "capture", seq: index + 1,
    eventType: event.eventType, stream: "system", level: "info", color: null, message: null,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `pi-${index + 1}`, sourceSeq: index + 1, sourceInstanceId: "pi-capture", sourceKind: "runner", priority: 1, normalizedSessionId: "pi-session", emittedAt: "2026-11-12T06:18:00.000Z", ...event } },
    createdAt: new Date("2026-11-12T06:18:00.000Z"),
  }));
}

export const PI_STOP_COMMAND = "for i in 1 2 3; do echo STEP$i-74584f; sleep 30; done";

/**
 * A Stop while Pi's bash tool streams: Pi's native wire (tool_execution_update
 * carries a cumulative partialResult snapshot, as pi-coding-agent's bash tool
 * emits it), then abort settles without tool_execution_end. Real projector
 * output (item.delta / tool.execution.progressed) feeds the app's consumer.
 */
export function piStopMidShellWire(snapshots: string[]): Record<string, unknown>[] {
  const command = PI_STOP_COMMAND;
  const call = { type: "toolCall", id: "stop-shell", name: "bash", arguments: { command } };
  const assistant = { role: "assistant", content: [call], api: "openai-completions", provider: "paperclip", model: "m", responseId: "resp-stop-shell", timestamp: 1794464777816, stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return [
    { type: "agent_start" }, { type: "turn_start" },
    { type: "message_start", message: { ...assistant, content: [] } },
    { type: "message_end", message: assistant },
    { type: "tool_execution_start", toolCallId: "stop-shell", toolName: "bash", args: { command } },
    { type: "tool_execution_update", toolCallId: "stop-shell", toolName: "bash", args: { command }, partialResult: { content: [], details: undefined } },
    ...snapshots.map(text => ({ type: "tool_execution_update", toolCallId: "stop-shell", toolName: "bash", args: { command }, partialResult: { content: [{ type: "text", text }], details: {} } })),
    { type: "agent_end", messages: [] },
    { type: "agent_settled", aborted: true },
  ];
}
export function piStoppedRunEvents(snapshots: string[]): HeartbeatRunEvent[] {
  const rows = persistedPiWire(piStopMidShellWire(snapshots));
  const last = rows.at(-1)!;
  const base = last.payload!.prpEvent as Record<string, unknown>;
  rows.push({ ...last, id: last.id + 1, seq: last.seq + 1, eventType: "run.terminal", payload: { prpEvent: { ...base, sourceEventId: "governed-driver-terminal", sourceSeq: last.seq + 1, eventType: "run.terminal", payload: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "yielded" } } } });
  return rows;
}
