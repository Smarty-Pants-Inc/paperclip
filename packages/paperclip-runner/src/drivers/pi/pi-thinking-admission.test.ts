// Keep: regression from clamp withdrawal (1b''); native readback is an
// admission trust boundary. Never replace Pi's configured cap with host policy.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { admitPiRpcSession, PI_NATIVE_THINKING_LEVELS, resolvePiNativeConfig } from "./pi-native-config.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";

const model = { provider: "neutral", id: "nested/model" };
const selected = (level: string) => resolvePiNativeConfig({ provider: "pi_rpc", model: "neutral/nested/model", piRpcThinkingLevel: level });
function port(effective: unknown, available: unknown = PI_NATIVE_THINKING_LEVELS, effectiveModel = model) {
  const commands: Array<Record<string, unknown>> = [];
  return { commands, request: async (command: { type: string; [key: string]: unknown }) => {
    commands.push(command);
    return command.type === "get_state" ? { sessionId: "native", model: effectiveModel, thinkingLevel: effective, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : command.type === "set_model" ? model : command.type === "get_available_thinking_levels" ? { levels: available } : undefined;
  } };
}
it("requests valid max even when unavailable, admitting Pi's xhigh with one bounded diagnostic", async () => {
  const native = port("xhigh", PI_NATIVE_THINKING_LEVELS.filter(level => level !== "max"));
  const identity = await admitPiRpcSession(native, selected("max"));
  expect(native.commands).toContainEqual({ type: "set_thinking_level", level: "max" });
  expect(identity).toEqual({ model: "neutral/nested/model", providerSessionId: "native", piRpcThinkingLevel: "xhigh",
    diagnostic: { code: "pi_thinking_lowered_by_config", requested: "max", effective: "xhigh" } });
});
it("admits exact xhigh with no lowering diagnostic", async () => {
  expect(await admitPiRpcSession(port("xhigh", ["xhigh"]), selected("xhigh"))).toEqual({ model: "neutral/nested/model", providerSessionId: "native", piRpcThinkingLevel: "xhigh" });
});
it.each([undefined, null, "ultra", "max"])("refuses missing, invalid or higher effective level %j", async effective => {
  const native = port(effective);
  await expect(admitPiRpcSession(native, selected("xhigh"))).rejects.toMatchObject({ code: "pi_thinking_mismatch" });
  expect(native.commands.some(command => command.type === "prompt")).toBe(false);
});
it("refuses an effective level absent from Pi's available levels", async () => {
  await expect(admitPiRpcSession(port("high", ["xhigh"]), selected("max"))).rejects.toMatchObject({ code: "pi_thinking_mismatch" });
});
it("still refuses an effective model mismatch", async () => {
  await expect(admitPiRpcSession(port("xhigh", ["xhigh"], { ...model, id: "wrong" }), selected("max"))).rejects.toMatchObject({ code: "pi_model_mismatch" });
});
it("refuses an invalid request before any native operation", async () => {
  const native = port("xhigh");
  await expect(admitPiRpcSession(native, { ...selected("max"), piRpcThinkingLevel: "ultra" as never })).rejects.toMatchObject({ code: "pi_thinking_invalid" });
  expect(native.commands).toEqual([]);
});
it.each([undefined, [], ["ultra"], Array(8).fill("off")])("refuses malformed/empty native availability %j", async available => {
  const native = port("xhigh", available === undefined ? null : available);
  await expect(admitPiRpcSession(native, selected("max"))).rejects.toThrow(/thinking/);
});

it("the driver records effective effort in readback/run events and emits only one lowering diagnostic across readmissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-thinking-admit-"));
  const native = port("xhigh", ["off", "xhigh"]);
  const closed = Promise.withResolvers<void>();
  const transport = { pid: 42, exited: false,
    request: async (type: string, params: PiRpcRecord = {}) => ({ data: type === "prompt" ? { disposition: "started" } : await native.request({ type, ...params }) }),
    events: async function* (): AsyncIterable<PiRpcRecord> { await closed.promise; },
    async close() { this.exited = true; closed.resolve(); },
  };
  const session = await new PiRpcDriver({ model: "neutral/nested/model", piRpcThinkingLevel: "max", runtimeDirectory: join(root, "sessions"),
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport,
  }).openSession({ runId: "run", normalizedSessionId: "session", workingDirectory: root });
  try {
    const events = session.events()[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ eventType: "session.started", payload: { context: { model: "neutral/nested/model", piRpcThinkingLevel: "xhigh" } } });
    const diagnostic = (await events.next()).value;
    expect(diagnostic).toMatchObject({ eventType: "harness.diagnostic", payload: { code: "pi_thinking_lowered_by_config", requested: "max", effective: "xhigh" } });
    expect(JSON.stringify(diagnostic.payload).length).toBeLessThan(256);
    await session.attachRun!({ runId: "run-2" });
    expect(await session.snapshot()).toMatchObject({ piRpcThinkingLevel: "xhigh" });
    await session.startTurn({ message: { role: "user", text: "work" } });
    // A duplicate diagnostic would occupy this slot after attach.
    expect((await events.next()).value).toMatchObject({ eventType: "turn.started", runId: "run-2", payload: { context: { piRpcThinkingLevel: "xhigh" } } });
    expect(native.commands.filter(command => command.type === "set_thinking_level")).toEqual([{ type: "set_thinking_level", level: "max" }, { type: "set_thinking_level", level: "max" }]);
  } finally { await session.close({ reason: "thinking admission test complete" }); }
});
