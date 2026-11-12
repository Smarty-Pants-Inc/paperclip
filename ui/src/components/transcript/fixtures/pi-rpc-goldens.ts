import type { HeartbeatRunEvent } from "@paperclipai/shared";
import baseline from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/baseline-1.5.2.normalized.json";
import abort from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/abort-1.5.2.normalized.json";
import compaction from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/compaction-1.5.2.normalized.json";
import extension from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/extension-1.5.2.normalized.json";
import queue from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/queue-1.5.2.normalized.json";
import retry from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/retry-1.5.2.normalized.json";
import subagent from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/subagent-1.5.2.normalized.json";
import unsupportedThinking from "../../../../../packages/paperclip-runner/test-fixtures/pi-rpc/unsupported-thinking-1.5.2.normalized.json";

export interface RecordedEvent { eventType: string; itemId?: string; turnId?: string; payload: Record<string, unknown> }
// Real Pi 1.5.2 RPC against the owner's controlled HTTP peer, not Paul's live work.
// The extension golden is deliberately fenced: no admitted turn, no assistant text.
export const piRpcGoldens: Record<string, RecordedEvent[]> = { baseline, abort, compaction, extension, queue, retry, subagent, "unsupported-thinking": unsupportedThinking };
export const captureTs = "2026-11-12T06:18:00.000Z";
export function piEnvelope(event: RecordedEvent, index: number) {
  return { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `pi-${index + 1}`, sourceSeq: index + 1, sourceInstanceId: "pi-capture", sourceKind: "runner", priority: 1, runId: "pi-capture", normalizedSessionId: "pi-session", emittedAt: captureTs, ...event };
}
export function piPersisted(events: readonly RecordedEvent[]): HeartbeatRunEvent[] {
  return events.map((event, index) => ({ id: index + 1, companyId: "controlled-peer", runId: "pi-capture", agentId: "capture", seq: index + 1, eventType: event.eventType, stream: "system", level: "info", color: null, message: null, payload: { prpEvent: piEnvelope(event, index) }, createdAt: new Date(captureTs) }));
}
// Explicit simulated DRIVER authority, never inferred from agent_end or prose.
export const interruptedTerminal: RecordedEvent = { eventType: "run.terminal", turnId: "turn-1", payload: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "yielded" } };
export function expectedReplies(events: readonly RecordedEvent[]) {
  return events.filter(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage").map(event => event.payload.text);
}
export function expectedUsage(events: readonly RecordedEvent[], field: string) {
  return events.filter(event => event.eventType === "usage.reported").reduce((sum, event) => sum + Number((event.payload.runDelta as Record<string, number>)[field]), 0);
}
