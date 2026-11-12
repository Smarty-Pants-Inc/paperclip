import { describe, expect, it, vi } from "vitest";
import type { HarnessDriver, HarnessSession } from "../../contracts/harness-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { PiEnvironmentProbeCleanupError, probePiNativeEnvironment } from "./pi-environment-probe.js";

const config = { provider: "pi_rpc" as const, model: "neutral/noncatalog-model", piRpcThinkingLevel: "off" as const };
const event = (eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}, extra: Partial<PrpEvent> = {}): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: "test", sourceSeq: 1, sourceInstanceId: "stub", sourceKind: "runner", runId: "probe-run", normalizedSessionId: "probe-session", turnId: "probe-turn", eventType, schemaVersion: 1, priority: 1, emittedAt: "2026-11-12T00:00:00.000Z", payload, ...extra,
});
const reply = () => event("item.completed", { kind: "agentMessage", channel: "final", text: "hello" });
const terminal = () => event("turn.completed", { turnId: "probe-turn" });
function stub(options: { events?: PrpEvent[]; first?: PrpEvent; cleanupError?: Error; hang?: boolean; ids?: { driverSessionId: string; providerSessionId?: string }; abort?: AbortController } = {}) {
  const ready = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  let subscribed = false;
  const close = vi.fn(async () => { closed.resolve(); ready.resolve(); if (options.cleanupError) throw options.cleanupError; });
  const startTurn = vi.fn(async () => {
    expect(subscribed).toBe(true);
    ready.resolve(); options.abort?.abort(new Error("user cancelled"));
    return { turnId: "probe-turn" };
  });
  const session: HarnessSession = {
    ids: () => options.ids ?? { driverSessionId: "driver-session", providerSessionId: "native-session" },
    events: async function* () {
      subscribed = true;
      yield options.first ?? event("session.started", { context: { model: config.model, piRpcThinkingLevel: config.piRpcThinkingLevel } });
      await ready.promise;
      if (options.hang) await closed.promise;
      else for (const value of options.events ?? [reply(), terminal()]) yield value;
    },
    startTurn, close,
    snapshot: async () => { throw new Error("probe must not persist an idle setup session"); },
  };
  const openSession = vi.fn(async () => session);
  return { driver: { openSession } as Pick<HarnessDriver, "openSession">, session, openSession, startTurn, close };
}
const probe = (driver: Pick<HarnessDriver, "openSession">, overrides: Partial<Parameters<typeof probePiNativeEnvironment>[0]> = {}) => probePiNativeEnvironment({ driver, config, runId: "probe-run", normalizedSessionId: "probe-session", workingDirectory: "/prepared/selected-remote-target", timeoutMs: 1000, cleanupTimeoutMs: 100, ...overrides });

describe("ordinary native Pi setup hello through the run's configured driver", () => {
  it("opens the original target, subscribes before start, observes response + terminal and retires", async () => {
    const value = stub();
    await expect(probe(value.driver)).resolves.toEqual({ provider: "pi_rpc", providerDriver: "pi_rpc", effectiveModel: config.model, providerSessionId: "native-session", helloProbePassed: true });
    expect(value.openSession).toHaveBeenCalledWith(expect.objectContaining({ runId: "probe-run", normalizedSessionId: "probe-session", workingDirectory: "/prepared/selected-remote-target", signal: expect.any(AbortSignal) }));
    expect(value.startTurn).toHaveBeenCalledOnce();
    expect(value.startTurn.mock.calls[0]).toEqual([{ message: { role: "user", text: "Respond only with hello. Do not use tools or inspect files." }, model: config.model, piRpcThinkingLevel: config.piRpcThinkingLevel }]);
    expect(value.close).toHaveBeenCalledOnce();
  });
  it.each([
    ["acceptance only", []], ["terminal only", [terminal()]],
    ["empty reply", [event("item.completed", { kind: "agentMessage", text: " " }), terminal()]],
    ["wrong-turn reply", [event("item.completed", { kind: "agentMessage", text: "hello" }, { turnId: "old-turn" }), terminal()]],
    ["reasoning is not hello", [event("item.completed", { kind: "reasoning", text: "hello" }), terminal()]],
    ["progress is not a final hello", [event("item.completed", { kind: "agentMessage", channel: "progress", text: "working" }), terminal()]],
    ["native failure", [reply(), event("turn.failed")]], ["cancelled", [reply(), event("turn.cancelled")]],
    ["interrupted", [reply(), event("turn.interrupted")]], ["failed item", [event("item.failed", { kind: "agentMessage" }), terminal()]],
    ["tool", [event("item.started", { kind: "commandExecution" }), reply(), terminal()]],
    ["canonical tool", [event("tool.execution.started"), reply(), terminal()]],
    ["session failure", [event("session.failed")]],
    ["mismatched run", [event("item.completed", { kind: "agentMessage", text: "hello" }, { runId: "old-run" }), terminal()]],
    ["premature EOF", [reply()]],
  ])("cannot qualify %s", async (_name, events) => {
    const value = stub({ events: events as PrpEvent[] });
    await expect(probe(value.driver)).rejects.toThrow();
    expect(value.close).toHaveBeenCalledOnce();
  });
  it.each([
    event("session.started", { context: {} }),
    event("session.started", { context: { model: "fallback/model" } }),
    event("session.started", { context: { model: config.model } }, { normalizedSessionId: "wrong-session" }),
    event("harness.ready", { context: { model: config.model } }),
  ])("rejects wrong/missing admitted identity before sending prompt", async first => {
    const value = stub({ first });
    await expect(probe(value.driver)).rejects.toThrow(/model\/session/);
    expect(value.startTurn).not.toHaveBeenCalled(); expect(value.close).toHaveBeenCalledOnce();
  });
  it.each([undefined, "high"])("requires the selected thinking level in the admitted identity (%s)", async piRpcThinkingLevel => {
    const value = stub({ first: event("session.started", { context: { model: config.model, piRpcThinkingLevel } }) });
    await expect(probe(value.driver)).rejects.toThrow(/thinking/);
    expect(value.startTurn).not.toHaveBeenCalled(); expect(value.close).toHaveBeenCalledOnce();
  });
  it("requires the native session ID, not merely a driver/display identity", async () => {
    const value = stub({ ids: { driverSessionId: "driver-only" } });
    await expect(probe(value.driver)).rejects.toThrow(/session identity/);
    expect(value.startTurn).not.toHaveBeenCalled(); expect(value.close).toHaveBeenCalledOnce();
  });
  it("does not launch anything for invalid saved config", async () => {
    const value = stub();
    await expect(probe(value.driver, { config: { ...config, model: "auto" } })).rejects.toThrow(/explicit/);
    expect(value.openSession).not.toHaveBeenCalled();
  });
  it("does not exempt failed openSession or try a local alternate", async () => {
    const openSession = vi.fn(async () => { throw new Error("selected target unavailable"); });
    await expect(probe({ openSession })).rejects.toThrow("selected target unavailable");
    expect(openSession).toHaveBeenCalledOnce();
  });
  it("has a bounded hello deadline and closes the original session", async () => {
    const value = stub({ hang: true });
    await expect(probe(value.driver, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    expect(value.close).toHaveBeenCalledOnce();
  });
  it("respects cancellation rather than passing a turn already in the queue", async () => {
    const abort = new AbortController(); const value = stub({ abort });
    await expect(probe(value.driver, { signal: abort.signal })).rejects.toThrow("user cancelled");
    expect(value.close).toHaveBeenCalledOnce();
  });
  it("joins and closes a late openSession after cancellation before returning", async () => {
    const value = stub();
    const driver = { openSession: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return value.session; } };
    await expect(probe(driver, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
    expect(value.startTurn).not.toHaveBeenCalled(); expect(value.close).toHaveBeenCalledOnce();
  });
  it("cannot pass when retirement rejects, and retains the original failure cause", async () => {
    const cleanupError = new Error("remote process still alive");
    const value = stub({ events: [event("turn.failed")], cleanupError });
    const error = await probe(value.driver).catch(error => error);
    expect(error).toBeInstanceOf(PiEnvironmentProbeCleanupError);
    expect(error.cleanupError).toBe(cleanupError); expect(error.operationError).toBeInstanceOf(Error);
    expect(value.close).toHaveBeenCalledOnce();
  });
  it("cannot pass when retirement cannot be confirmed before its bound", async () => {
    const value = stub(); const release = Promise.withResolvers<void>();
    value.session.close = async () => release.promise;
    const error = await probe(value.driver, { cleanupTimeoutMs: 5 }).catch(error => error);
    expect(error).toMatchObject({ code: "pi_probe_cleanup_unconfirmed" });
    release.resolve(); await error.retired;
  });
  it("retains and retires an opener arriving after both observation deadlines", async () => {
    const value = stub(), release = Promise.withResolvers<HarnessSession>();
    const error = await probe({ openSession: () => release.promise }, { timeoutMs: 5, cleanupTimeoutMs: 5 }).catch(error => error);
    expect(error).toBeInstanceOf(PiEnvironmentProbeCleanupError);
    expect(error.retryCleanup()).toBe(error.retired);
    release.resolve(value.session); await error.retired;
    expect(value.close).toHaveBeenCalledOnce(); expect(value.startTurn).not.toHaveBeenCalled();
  });
  it("can retry rejected retirement on the SAME session without opening a second target", async () => {
    const value = stub(); let attempts = 0;
    value.session.close = async () => { if (++attempts === 1) throw new Error("retirement temporarily rejected"); };
    const error = await probe(value.driver).catch(error => error);
    expect(error).toBeInstanceOf(PiEnvironmentProbeCleanupError);
    await error.retryCleanup();
    expect(attempts).toBe(2); expect(value.openSession).toHaveBeenCalledOnce();
  });
});
