import { describe, expect, it } from "vitest";
import { admitPiRpcSession, resolvePiNativeConfig } from "./pi-native-config.js";
import { createPiEventProjector } from "./pi-event-projector.js";

const selection = { provider: "pi_rpc", model: "neutral/exact/model", piRpcThinkingLevel: "high" };
const model = { provider: "neutral", id: "exact/model" };
const state = { sessionId: "s", model, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
describe("binding challenger admission corrections", () => {
  it("uses the new persisted key, preserving all seven exact native values", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(resolvePiNativeConfig({ ...selection, piRpcThinkingLevel: level })).toEqual({ ...selection, piRpcThinkingLevel: level });
    }
    expect(() => resolvePiNativeConfig({ ...selection, provider: "pi" })).toThrow();
  });
  it.each(["create", "load", "reconnect", "run.attach", "claim"])("reads live state and read-backs thinking after %s", async () => {
    const commands: string[] = [];
    await expect(admitPiRpcSession({ request: async command => {
      commands.push(command.type);
      if (command.type === "get_state") return state;
      if (command.type === "set_model") return model;
      if (command.type === "get_available_thinking_levels") return { levels: ["off", "high"] };
      // Deliberately no data: native set response is NOT acknowledgment.
      return undefined;
    } }, resolvePiNativeConfig(selection))).resolves.toMatchObject({ piRpcThinkingLevel: "high" });
    expect(commands).toEqual(["get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state"]);
  });
  it("refuses unsupported thinking before setting it", async () => {
    const commands: string[] = [];
    await expect(admitPiRpcSession({ request: async command => {
      commands.push(command.type);
      return command.type === "get_state" ? state : command.type === "set_model" ? model : { levels: ["off"] };
    } }, resolvePiNativeConfig(selection))).rejects.toThrow(/thinking/);
    expect(commands).not.toContain("set_thinking_level");
  });
  it("refuses active or queued work at attach/claim", async () => {
    for (const live of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }]) {
      const commands: string[] = [];
      await expect(admitPiRpcSession({ request: async command => { commands.push(command.type); return { ...state, ...live }; } }, resolvePiNativeConfig(selection))).rejects.toThrow(/busy/);
      expect(commands).toEqual(["get_state"]);
    }
  });
  it("does not treat set_thinking_level success as effective acknowledgment", async () => {
    let reads = 0;
    await expect(admitPiRpcSession({ request: async command => command.type === "get_state" ? { ...state, thinkingLevel: ++reads === 1 ? "high" : "off" } : command.type === "set_model" ? model : command.type === "get_available_thinking_levels" ? { levels: ["high"] } : { thinkingLevel: "high" } }, resolvePiNativeConfig(selection))).rejects.toThrow(/thinking/);
  });
});

describe("binding projector corrections", () => {
  it("emits bounded unknown-type diagnostics without leaking arbitrary payload", () => {
    const projector = createPiEventProjector({ turnId: "t" });
    const events = Array.from({ length: 100 }, (_, i) => projector.project({ type: `unknown-${i}`, secret: "do-not-copy" })).flat();
    expect(events.length).toBeGreaterThan(0); expect(events.length).toBeLessThanOrEqual(17);
    expect(events.every(event => event.eventType === "harness.diagnostic")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("do-not-copy");
  });
  it("emits app context.compacted only for a successful native receipt", () => {
    const projector = createPiEventProjector({ turnId: "t" });
    expect(projector.project({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 100, estimatedTokensAfter: 20 } })).toContainEqual(expect.objectContaining({ eventType: "context.compacted", payload: expect.objectContaining({ schema: "paperclip.context.compacted.v1", preTokens: 100, postTokens: 20 }) }));
    expect(projector.project({ type: "compaction_end", aborted: true }).some(event => event.eventType === "context.compacted")).toBe(false);
  });
  it("marks child usage unknown and total accounting incomplete on subagent calls", () => {
    const projector = createPiEventProjector({ turnId: "t" });
    projector.project({ type: "tool_execution_start", toolCallId: "c", toolName: "subagent", args: {} });
    const events = projector.project({ type: "message_end", message: { role: "assistant", provider: "neutral", model: "m", responseId: "r", stopReason: "stop", content: [], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
    expect(events.find(event => event.eventType === "usage.reported")?.payload).toMatchObject({ childUsage: "unknown", accountingComplete: false });
  });
});
