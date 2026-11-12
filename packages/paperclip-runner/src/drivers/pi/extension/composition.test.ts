import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { installPiBindExtension, installPiSubagentComposition, type PiBindApi, type PiBindContext } from "./index.js";
import { SESSION_LIVENESS_KEY, type LivenessRegistry } from "./subagents/lifecycle.js";

// Trust boundary: exercise the real required-extension registry and host Stop/park
// hooks. A registration in another bundled copy must not disappear or survive reload.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it.each([false, true])("requires child evidence for configured tools, including hidden ones (configured=%s)", async configured => {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const prior = globals[SESSION_LIVENESS_KEY]; delete globals[SESSION_LIVENESS_KEY];
  cleanups.push(() => { if (prior === undefined) delete globals[SESSION_LIVENESS_KEY]; else globals[SESSION_LIVENESS_KEY] = prior; });
  const root = await mkdtemp(join(tmpdir(), "pi-empty-composition-")); await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map<string, Array<(event: any, ctx: PiBindContext) => any>>();
  const bus = new EventEmitter();
  const events = { on(name: string, fn: (data: unknown) => void) { bus.on(name, fn); return () => { bus.off(name, fn); }; }, emit(name: string, data: unknown) { bus.emit(name, data); } };
  const ctx: PiBindContext = { sessionManager: { getSessionId: () => "native-empty" }, isIdle: () => true, hasPendingMessages: () => false, abort: vi.fn() };
  const pi: PiBindApi = { events, on(event: string, fn: any) { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list); return () => {}; },
    registerTool() {}, registerProvider() {}, unregisterProvider() {}, getActiveTools: () => [],
    getAllTools: () => configured ? [{ name: "subagent", exposure: "hidden" }] : [], setActiveTools() {} };
  events.on("subagents:rpc:v1:request", (raw: any) => events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: true, data: {} }));
  const composition = installPiSubagentComposition(pi); cleanups.push(composition.dispose);
  const control = installPiBindExtension(pi, { socketPath: join(root, "bind.sock"), initial: { schema: 1, sessionId: "host-empty", epoch: 1, runId: "run", model: "paperclip/faux", thinkingLevel: "off", instructions: "", tools: [] } });
  cleanups.push(control.close);
  for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
  expect(await control.dispatch({ schema: 1, type: "stop_children", nonce: "stop", sessionId: "host-empty" })).toMatchObject({
    settled: [], uncertain: configured ? ["async-snapshot-unavailable", "session-liveness"] : [],
  });
  expect(ctx.abort).toHaveBeenCalledOnce();
  expect(await control.dispatch({ schema: 1, type: "park_ready", nonce: "park", sessionId: "host-empty" })).toMatchObject(configured ? { ready: false } : { ready: true, reasons: [] });
});
it("composes before the settings package starts, awaits settlement, and releases registration on reload", async () => {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const prior = globals[SESSION_LIVENESS_KEY]; delete globals[SESSION_LIVENESS_KEY];
  cleanups.push(() => { if (prior === undefined) delete globals[SESSION_LIVENESS_KEY]; else globals[SESSION_LIVENESS_KEY] = prior; });
  const root = await mkdtemp(join(tmpdir(), "pi-composition-")); await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map<string, Array<(event: any, ctx: PiBindContext) => any>>();
  const bus = new EventEmitter();
  const events = { on(name: string, fn: (data: unknown) => void) { bus.on(name, fn); return () => { bus.off(name, fn); }; }, emit(name: string, data: unknown) { bus.emit(name, data); } };
  let idle = true, abortSettled = false;
  const ctx: PiBindContext = { sessionManager: { getSessionId: () => "native-session" }, isIdle: () => idle, hasPendingMessages: () => false,
    abort: vi.fn(() => { setImmediate(() => { idle = true; abortSettled = true; void emit("agent_settled"); }); }) };
  const pi: PiBindApi = { events, on(event: string, fn: any) { const list = handlers.get(event) ?? []; list.push(fn); handlers.set(event, list); return () => {}; },
    registerTool() {}, registerProvider() {}, unregisterProvider() {}, getActiveTools: () => [], setActiveTools() {} };
  async function emit(name: string) { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); }
  const bridgePath = fileURLToPath(new URL("./subagents/child-bridge.ts", import.meta.url));
  const composition = installPiSubagentComposition(pi, bridgePath); cleanups.push(composition.dispose);
  pi.on("session_start", () => {
    const registry = globals[SESSION_LIVENESS_KEY] as LivenessRegistry;
    expect(registry.version).toBe(1);
    cleanups.push(registry.register({ name: "pi-subagents", sessionId: "native-session", isActive: () => false }));
  });
  events.on("subagents:rpc:v1:request", (raw: any) => events.emit(`subagents:rpc:v1:reply:${raw.requestId}`, { version: 1, requestId: raw.requestId, success: true,
    data: { asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } } } }));
  const control = installPiBindExtension(pi, { socketPath: join(root, "bind.sock"), initial: { schema: 1, sessionId: "host-session", epoch: 1, runId: "run", model: "paperclip/faux", thinkingLevel: "xhigh", instructions: "", tools: [] } });
  cleanups.push(control.close);
  await emit("session_start");
  const duplicate = () => registerRequiredChildExtensions({ sessionId: "native-session", extensions: [{ id: "duplicate", path: bridgePath }] });
  expect(duplicate).toThrow(/already registered/);
  expect(await control.dispatch({ schema: 1, type: "park_ready", nonce: "park", sessionId: "host-session" })).toMatchObject({ ready: true });
  idle = false;
  expect(await control.dispatch({ schema: 1, type: "stop_children", nonce: "stop", sessionId: "host-session" })).toMatchObject({ settled: [], uncertain: [] });
  expect(ctx.abort).toHaveBeenCalledOnce(); expect(abortSettled).toBe(true);
  await emit("session_shutdown");
  duplicate().dispose();
  // Reload can install a fresh seam only after the old lifecycle was disposed.
  installPiSubagentComposition(pi, bridgePath).dispose();
});
