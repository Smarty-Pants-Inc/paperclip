import { createPiEventProjector } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.js";
import { createPiRpcAppServerProxy } from "../../../../packages/paperclip-runner/src/cli/pi-rpc-app-server-proxy.js";
import type { HarnessDriver } from "../../../../packages/paperclip-runner/src/contracts/harness-driver.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";

/** Replay native usage through the actual projector and Codex facade. The
 * normalized receiver below uses Rust's last-presence rule, not facade.runDelta:
 * a partial final notification therefore reproduces the production zero delta. */
export async function piUsageFacadeEvents(native: Record<string, unknown>[], runId: string, sourceInstanceId: string,
  terminal = "turn.completed"): Promise<PrpEvent[]> {
  const turnId = "recorded-turn", normalizedSessionId = "recorded-session";
  const projector = createPiEventProjector({ runId, turnId });
  // The usage-only capture deliberately removed message identities; supply
  // stable replay identities without changing any accounting measurements.
  const projected = native.flatMap((event, index) => projector.project(event.type === "message_end"
    ? { ...event, message: { ...(event.message as Record<string, unknown>), responseId: `replay-message-${index}` } } : event));
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const frames: Array<Record<string, any>> = [];
  let drained!: () => void;
  const finished = new Promise<void>(resolve => { drained = resolve; });
  const session = {
    ids: () => ({ driverSessionId: normalizedSessionId }),
    async *events() {
      await started;
      yield { eventType: "turn.started", runId, turnId, payload: {} };
      for (const event of projected) yield { ...event, runId, turnId };
      yield { eventType: terminal, runId, turnId, payload: {} };
      drained();
    },
    startTurn: async () => { start(); return { turnId }; },
    close: async () => { start(); },
  };
  const proxy = createPiRpcAppServerProxy({
    stdout: { write: chunk => { frames.push(JSON.parse(chunk)); return true; }, once: () => undefined },
    environment: { PAPERCLIP_RUN_ID: runId, PAPERCLIP_NORMALIZED_SESSION_ID: normalizedSessionId },
    createDriver: () => ({ descriptor: () => ({ kind: "pi_rpc", displayName: "Pi RPC replay", version: "test", capabilities: {} }),
      openSession: async () => session } as unknown as HarnessDriver),
  });
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    proxy.acceptLine(JSON.stringify({ id, method, params }));
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.id === id)) {
      if (Date.now() > deadline) throw new Error(`facade request timed out: ${method}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const frame = frames.find(frame => frame.id === id)!;
    if (frame.error) throw new Error(JSON.stringify(frame.error));
  };
  try {
    await request(1, "thread/start", { cwd: "/workspace", model: "paperclip/faux" });
    await request(2, "turn/start", { input: [{ type: "text", text: "replay" }] });
    await finished;
  } finally { await proxy.close(); }
  let seq = 0;
  const event = (eventType: string, payload: Record<string, unknown> = {}): PrpEvent => ({
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", priority: 0,
    sourceInstanceId, sourceEventId: `replay-${++seq}`, sourceSeq: seq, runId, turnId,
    normalizedSessionId, emittedAt: "2026-11-13T08:18:09.000Z", eventType, payload,
  } as PrpEvent);
  return [event("turn.started"), ...frames.filter(frame => frame.method === "thread/tokenUsage/updated").map(frame => {
    const params = frame.params, last = params.tokenUsage.last;
    return event("usage.reported", { ...params, runDeltaAvailable: last !== undefined,
      runDelta: last ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  }), event(terminal)];
}
