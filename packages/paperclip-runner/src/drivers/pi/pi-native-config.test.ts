import { describe, expect, it } from "vitest";
import { admitPiRpcSession, PI_NATIVE_THINKING_LEVELS, resolvePiNativeConfig, validatePiNativeConfig } from "./pi-native-config.js";

const config = { provider: "pi_rpc", model: "neutral/vendor/model-not-in-catalog", piRpcThinkingLevel: "high" };
const model = { provider: "neutral", id: "vendor/model-not-in-catalog" };
const state = { sessionId: "native-session", model, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
const reply = (type: string, effective: object = state) => type === "get_state" ? { isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...effective } : type === "set_model" ? model : type === "get_available_thinking_levels" ? { levels: [...PI_NATIVE_THINKING_LEVELS] } : undefined;
describe("native Pi configuration and admission (playbook 6.1/6.2)", () => {
  it("preserves a saved explicit nested noncatalog model and native acknowledgment", async () => {
    const saved = resolvePiNativeConfig(JSON.parse(JSON.stringify(config)));
    expect(saved).toEqual(config);
    const commands: unknown[] = [];
    const identity = await admitPiRpcSession({ request: async command => { commands.push(command); return reply(command.type); } }, saved);
    expect(identity).toMatchObject({ model: config.model, providerSessionId: "native-session", piRpcThinkingLevel: "high" });
    expect(commands).toEqual([{ type: "get_state" }, { type: "set_model", provider: "neutral", modelId: model.id }, { type: "get_available_thinking_levels" }, { type: "set_thinking_level", level: "high" }, { type: "get_state" }]);
  });
  it("composes validation without stripping the selected connection/target", () => {
    const saved = { ...config, executionEnvironmentId: "selected-target", connectionId: "selected-connection", env: { PAPERCLIP_PI_PROVIDERS: "managed-route-is-owned-by-existing-broker" } };
    expect(validatePiNativeConfig(saved)).toEqual({ ok: true, config: saved, issues: [] });
    expect(validatePiNativeConfig({ ...saved, model: "default" })).toMatchObject({ ok: false, config: null, issues: [{ code: "pi_model_required", path: "model" }] });
  });
  it.each(PI_NATIVE_THINKING_LEVELS)("round trips native thinking %s", level => {
    expect(resolvePiNativeConfig({ ...config, piRpcThinkingLevel: level }).piRpcThinkingLevel).toBe(level);
  });
  it.each([undefined, "", " ", "auto", "default", "neutral/", "/model", "neutral/ model", " neutral/model", "neutral/model\n"])("rejects ambiguous model %j", model => {
    expect(() => resolvePiNativeConfig({ ...config, model })).toThrow(/explicit.*provider\/model/i);
  });
  it.each(["ultra", "HIGH", null, 1])("rejects invalid thinking %j", piRpcThinkingLevel => {
    expect(() => resolvePiNativeConfig({ ...config, piRpcThinkingLevel })).toThrow(/thinking/i);
  });
  it("does not reinterpret legacy ACPX or another provider as native Pi", () => {
    expect(() => resolvePiNativeConfig({ provider: "acpx", acpxAgent: "pi", model: config.model })).toThrow(/provider/i);
    expect(() => resolvePiNativeConfig({ ...config, piThinkingLevel: "high" })).toThrow(/legacy/);
  });
  it.each([
    { sessionId: "s", model: { provider: "neutral", id: "other" }, thinkingLevel: "high" },
    { sessionId: "s", model: { provider: "other", id: model.id }, thinkingLevel: "high" },
    { sessionId: "s", model, thinkingLevel: "xhigh" },
    { sessionId: "s", thinkingLevel: "high" },
    { model, thinkingLevel: "high" },
  ])("rejects missing or changed effective identity before prompt", async effective => {
    const commands: string[] = [];
    await expect(admitPiRpcSession({ request: async command => { commands.push(command.type); return reply(command.type, effective); } }, resolvePiNativeConfig(config))).rejects.toThrow(/Pi.*(model|thinking|session)/);
    expect(commands).not.toContain("prompt");
  });
  it("fails closed on a wrong set_model receipt even if later state would match", async () => {
    const commands: string[] = [];
    await expect(admitPiRpcSession({ request: async command => { commands.push(command.type); return command.type === "get_state" ? state : { provider: "neutral", id: "other" }; } }, resolvePiNativeConfig(config))).rejects.toThrow(/model/);
    expect(commands).toEqual(["get_state", "set_model"]);
  });
  it("does not swallow provider rejection, fall back or prompt", async () => {
    const commands: string[] = [];
    await expect(admitPiRpcSession({ request: async command => { commands.push(command.type); throw new Error("model unavailable"); } }, resolvePiNativeConfig(config))).rejects.toThrow("model unavailable");
    expect(commands).toEqual(["get_state"]);
  });
  it("repeats selection after reconnect/load and cannot spend a prior acknowledgment", async () => {
    let calls = 0;
    const port = { request: async (command: { type: string }) => { if (++calls > 5) throw new Error("reconnect refused"); return reply(command.type); } };
    await admitPiRpcSession(port, resolvePiNativeConfig(config));
    await expect(admitPiRpcSession(port, resolvePiNativeConfig(config))).rejects.toThrow("reconnect refused");
    expect(calls).toBe(6);
  });
});
