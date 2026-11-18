import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubagentBridge } from "./index.js";
import childBridge, { installChildBridge } from "./child-bridge.js";
import { consumeChildBridgeLease, createSubagentScope, type ChildBridgeSink } from "./host.js";
import { validateRoleTemplate } from "./role-template.js";
import { installSubagentSeam, installUnboundChildParent } from "./seam.js";
import { RunAuthority } from "../../pi-bind-protocol.js";

const roleText = "---\nname: reviewer\ntools: read\n---\nReview the real change.\n";
const origin = { epoch: 7, runId: "run-7", turnId: "parent-host-turn-7", callId: "outer-subagent-call" };
const closure = { langfuseExtensionPath: "/opt/pi-packages/langfuse-pi/index.js" };
const selection = (id = "s1") => ({ selectionId: id, roleId: "reviewer", roleDigest: validateRoleTemplate(roleText).digest, paretoChoice: "frontier", paretoRevision: "r1", complexity: "small", rationale: "review", budget: 1, model: "n/model:high" });
const catalog = () => ({ provider: "n", id: "model", family: "other" as const, thinkingLevels: ["high"] as const });
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

// Controlled IN-PROCESS child. Notification exceptions are swallowed, as in Pi 1.5.2;
// tool_call is therefore the fail-closed gate, not the notification callback alone.
class ControlledChild {
  handlers = new Map<string, Handler[]>();
  effects: string[] = [];
  notificationErrors: unknown[] = [];
  aborts = 0;
  level = "high";
  ctx = {
    model: { provider: "n", id: "model" },
    sessionManager: { getSessionId: () => this.id },
    abort: () => { this.aborts++; },
  } as unknown as ExtensionContext;
  api = {
    on: (event: string, handler: Handler) => { this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]); return () => {}; },
    getThinkingLevel: () => this.level,
  } as unknown as ExtensionAPI;
  constructor(readonly id: string) {}
  async emit(type: string, fields: Record<string, unknown> = {}, isolate = false) {
    let result: unknown;
    for (const handler of this.handlers.get(type) ?? []) {
      try { result = await handler({ type, ...fields }, this.ctx); }
      catch (error) { if (!isolate) throw error; this.notificationErrors.push(error); }
      if ((result as { block?: boolean } | undefined)?.block) break;
    }
    return result;
  }
  async call(toolCallId = "native-child-call") {
    const event = { toolCallId, toolName: "semantic_write", args: {} };
    await this.emit("tool_execution_start", event, true);
    const result = await this.emit("tool_call", { ...event, input: {} }) as { block?: boolean } | undefined;
    if (!result?.block) this.effects.push(toolCallId);
    await this.emit("tool_execution_end", { ...event, isError: !!result?.block }, true);
    return result;
  }
}
function host() {
  const events: Array<Record<string, unknown>> = [];
  const sink: ChildBridgeSink = {
    recordSelection: async receipt => { events.push({ type: "selection", ...receipt }); },
    childReady: async receipt => { events.push({ type: "ready", ...receipt }); },
    startTurn: async event => { events.push({ type: "turn", ...event }); return `host-child-turn-${events.length}`; },
    toolExecutionStart: async event => { events.push({ ...event }); return !event.revoked; },
    toolExecutionEnd: async event => { events.push({ ...event }); },
  };
  return { events, sink };
}
async function fixture() {
  const h = host();
  const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
  const prepared = await scope.prepare({ roleText, selection: selection() }, catalog);
  const child = new ControlledChild("child-session");
  let traceLoads = 0;
  await installChildBridge(child.api, consumeChildBridgeLease(prepared.options.extensionBindings), async path => {
    expect(path).toBe(closure.langfuseExtensionPath);
    traceLoads++;
  });
  await child.emit("session_start");
  await child.emit("turn_start", { turnIndex: 0 });
  return { ...h, scope, child, prepared, traceLoads };
}

describe("F087 mandatory in-process child bridge (trust boundary)", () => {
  it("admits an ordinary child without a pre-issued binding", async () => {
    vi.stubEnv("PI_SUBAGENT_EXTENSION_BINDINGS", "null");
    try {
      const child = new ControlledChild("ordinary-child");
      await childBridge(child.api);
      await child.emit("session_start");
      await child.emit("before_agent_start");
      await child.emit("turn_start", { turnIndex: 0 });
      await child.call();
      expect(child.effects).toEqual(["native-child-call"]);
      expect(child.aborts).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it("records one bounded unbound diagnostic per child, not per turn or tool", async () => {
    const child = new ControlledChild("diagnosed-child");
    await installChildBridge(child.api, undefined, async () => { throw new Error("SDK loads subagent-only tracing; do not load it twice"); });
    expect(await child.emit("before_agent_start")).toEqual({ message: { customType: "paperclip-unbound-child", content: "unbound child", display: false } });
    expect(await child.emit("before_agent_start")).toBeUndefined();
    await child.call("first"); await child.call("second");
    expect(child.effects).toEqual(["first", "second"]);
  });

  it.each(["stopped", "moved-on"])("fences an unbound child against its captured parent when %s", async state => {
    const authority = new RunAuthority();
    authority.bind(origin);
    const capturedParent = authority.beginTurn(origin);
    const seen: unknown[] = [];
    const off = installUnboundChildParent({ capture: () => authority.capture(), accept: captured => {
      seen.push(captured);
      return authority.accept(captured);
    } });
    try {
      const child = new ControlledChild("fenced-unbound");
      await installChildBridge(child.api, undefined);
      await child.call("before-stop");
      authority.end();
      if (state === "moved-on") {
        const next = { epoch: 8, runId: "run-8", turnId: "turn-8" };
        authority.bind(next); authority.beginTurn(next);
      }
      expect(await child.call("late-child-call")).toMatchObject({ block: true });
      expect(child.effects).toEqual(["before-stop"]);
      expect(seen).toEqual([capturedParent, capturedParent]);
    } finally { off(); }
  });

  it("refuses present malformed, consumed and revoked bindings rather than falling back", async () => {
    for (const value of [null, {}, { ticket: 1 }, { ticket: "not-issued" }]) {
      expect(() => consumeChildBridgeLease({ "paperclip.subagents/1": value })).toThrow(/binding|lease/i);
    }
    const f = await fixture();
    await f.scope.revoke();
    expect(() => consumeChildBridgeLease(f.prepared.options.extensionBindings)).toThrow(/missing|consumed|revoked/i);
    expect(await f.child.call("revoked-present")).toMatchObject({ block: true });
  });

  it("registers the public mandatory child extension and snapshots its path", async () => {
    const { registerRequiredChildExtensions } = await import("pi-subagents/required-child-extensions");
    let captured: unknown;
    const input = { sessionId: "public-api-parent", childBridgePath: import.meta.filename };
    const registration = registerSubagentBridge(input, request => {
      captured = request;
      return registerRequiredChildExtensions(request);
    });
    try {
      expect(captured).toEqual({ sessionId: input.sessionId, extensions: [{ id: "paperclip-child-bridge", path: import.meta.filename }], requireForAllRunners: true });
      expect(() => registerSubagentBridge(input)).toThrow();
    } finally { registration.dispose(); registration.dispose(); }
    registerSubagentBridge(input).dispose();
    expect(() => registerSubagentBridge({ ...input, childBridgePath: "/missing/required-extension.js" })).toThrow();
  });

  it("loads the admitted Langfuse extension and records SDK model/level readback", async () => {
    const f = await fixture();
    expect(f.traceLoads).toBe(1);
    expect(f.events.find(e => e.type === "ready")).toMatchObject({ origin, childSessionId: "child-session", effectiveModel: "n/model", effort: "high", selection: { complexity: "small", paretoChoice: "frontier" } });
    expect(f.prepared.model).toBe("n/model:high");
    await f.scope.revoke();
  });

  it("requires a fresh explicit selection and matching role digest before each child starts", async () => {
    const h = host();
    const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
    await expect(scope.prepare({ roleText, selection: undefined }, catalog)).rejects.toThrow(/selection/i);
    await expect(scope.prepare({ roleText, selection: { ...selection(), roleDigest: "wrong" } }, catalog)).rejects.toThrow(/digest/i);
    await expect(scope.prepare({ roleText: "---\nthinking: high\n---\nRole", selection: selection() }, catalog)).rejects.toThrow(/thinking/);
    expect(h.events).toEqual([]);
    const prepared = await scope.prepare({ roleText, selection: selection() }, catalog);
    consumeChildBridgeLease(prepared.options.extensionBindings);
    expect(() => consumeChildBridgeLease(prepared.options.extensionBindings)).toThrow(/missing|consumed/i);
    expect(consumeChildBridgeLease({})).toBeUndefined();
    await scope.revoke();
  });

  it("refuses mismatched SDK identity and missing tracing before any child prompt", async () => {
    for (const failure of ["clamp", "trace-load"]) {
      const h = host();
      const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
      const prepared = await scope.prepare({ roleText, selection: selection(failure) }, catalog);
      const child = new ControlledChild(failure);
      const install = () => installChildBridge(child.api, consumeChildBridgeLease(prepared.options.extensionBindings), async () => {
        if (failure === "trace-load") throw new Error("required tracing unavailable");
      });
      if (failure === "trace-load") await expect(install()).rejects.toThrow(/tracing/);
      else {
        await install();
        child.level = "low";
        await expect(child.emit("session_start")).rejects.toThrow(/effective/i);
      }
      expect(h.events.filter(e => e.type === "ready")).toEqual([]);
      expect(child.effects).toEqual([]);
      await scope.revoke();
    }
  });

  it("forwards the child native start and waits for host ACK before execution", async () => {
    const f = await fixture();
    let release!: () => void;
    const ack = new Promise<void>(resolve => { release = resolve; });
    const forward = f.sink.toolExecutionStart;
    f.sink.toolExecutionStart = async event => { await ack; return forward(event); };
    const call = f.child.call();
    await Promise.resolve();
    expect(f.child.effects).toEqual([]);
    release();
    await call;
    expect(f.events.find(e => e.type === "tool_execution_start")).toMatchObject({ origin, childSessionId: "child-session", childTurnId: expect.stringMatching(/^host-child-turn-/), toolCallId: "native-child-call", revoked: false });
    expect(f.child.effects).toEqual(["native-child-call"]);
    await f.scope.revoke();
  });

  it("outer subagent announcement does not authorize nested child semantics", async () => {
    const f = await fixture();
    const denied = await f.child.emit("tool_call", { toolCallId: "unannounced-child-call", toolName: "semantic_write", input: { origin, callId: origin.callId } }) as { block: boolean };
    expect(denied.block).toBe(true);
    expect(f.child.effects).toEqual([]);
    await f.scope.revoke();
  });

  it("fails closed when a notification error is swallowed and rejects duplicate effects", async () => {
    const f = await fixture();
    f.sink.toolExecutionStart = async () => { throw new Error("fd3 ledger unavailable"); };
    expect(await f.child.call("denied")).toMatchObject({ block: true });
    expect(f.child.effects).toEqual([]);
    expect(f.child.notificationErrors).toHaveLength(1);
    f.sink.toolExecutionStart = async () => true;
    await f.child.call("once");
    expect(await f.child.call("once")).toMatchObject({ block: true });
    expect(f.child.effects).toEqual(["once"]);
    await f.scope.revoke();
  });

  it("late child callback cannot borrow a newly committed parent epoch", async () => {
    const f = await fixture();
    await f.scope.revoke();
    const next = createSubagentScope({ origin: { ...origin, epoch: 8, runId: "run-8", turnId: "turn-8" }, closure, sink: f.sink, announce: () => true });
    expect(await f.child.call("late")).toMatchObject({ block: true });
    expect(f.events.find(e => e.toolCallId === "late" && e.type === "tool_execution_start")).toMatchObject({ origin, revoked: true });
    expect(f.child.effects).toEqual([]);
    await expect(f.scope.prepare({ roleText, selection: selection("late") }, catalog)).rejects.toThrow(/revoked/i);
    await next.revoke();
  });

  it("Stop revokes before aborting all attached SDK children and reports uncertainty honestly", async () => {
    const f = await fixture();
    const next = await f.scope.prepare({ roleText, selection: selection("s2") }, catalog);
    const grandchild = new ControlledChild("grandchild-session");
    await installChildBridge(grandchild.api, consumeChildBridgeLease(next.options.extensionBindings), async () => {});
    await grandchild.emit("session_start");
    const receipt = await f.scope.revoke();
    expect(f.child.aborts).toBe(1);
    expect(grandchild.aborts).toBe(1);
    expect(receipt.status).toBe("abort-requested");
    expect(receipt.unconfirmedChildSessions.sort()).toEqual(["child-session", "grandchild-session"]);
    expect(await f.child.call()).toMatchObject({ block: true });
    await f.child.emit("agent_settled", { outcome: "aborted" });
    await grandchild.emit("session_shutdown");
    expect(f.scope.stopReceipt()).toMatchObject({ status: "settled", unconfirmedChildSessions: [] });
    await f.scope.revoke();
    expect(f.child.aborts).toBe(1);
  });

  it("does not authorize a native start before the host has started a child turn", async () => {
    const h = host();
    const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
    const prepared = await scope.prepare({ roleText, selection: selection() }, catalog);
    const child = new ControlledChild("not-yet-started");
    await installChildBridge(child.api, consumeChildBridgeLease(prepared.options.extensionBindings), async () => {});
    await child.emit("session_start");
    expect(await child.call()).toMatchObject({ block: true });
    expect(child.effects).toEqual([]);
    await scope.revoke();
  });

  it("keeps failed abort and active shutdown uncertain instead of inventing Stop success", async () => {
    const f = await fixture();
    await f.scope.revoke();
    await f.child.emit("session_shutdown");
    expect(f.scope.stopReceipt()).toMatchObject({ status: "abort-requested", unconfirmedChildSessions: ["child-session"] });
    const h = host();
    const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
    const prepared = await scope.prepare({ roleText, selection: selection() }, catalog);
    const lease = consumeChildBridgeLease(prepared.options.extensionBindings);
    lease.attach("abort-failed", async () => { throw new Error("child abort unavailable"); });
    expect(await scope.revoke()).toMatchObject({ status: "uncertain", unconfirmedChildSessions: ["abort-failed"], errors: ["abort-failed: child abort unavailable"] });
  });

  it("routes in-process native starts through announce with the captured parent Origin", async () => {
    const h = host();
    const announced: unknown[] = [];
    let allowed = false;
    const off = installSubagentSeam({
      announce: (id, captured) => { announced.push([id, captured]); return allowed; },
      registerParkReadyContributor: () => () => {}, registerStopChildren: () => () => {},
    });
    const scope = createSubagentScope({ origin, closure, sink: h.sink });
    try {
      const prepared = await scope.prepare({ roleText, selection: selection() }, catalog);
      const child = new ControlledChild("announced-child");
      await installChildBridge(child.api, consumeChildBridgeLease(prepared.options.extensionBindings), async () => {});
      await child.emit("session_start"); await child.emit("turn_start", { turnIndex: 0 });
      expect(await child.call("denied-by-authority")).toMatchObject({ block: true });
      expect(h.events.filter(e => e.type === "tool_execution_start")).toEqual([]);
      allowed = true; await child.call("accepted-by-authority");
      expect(child.effects).toEqual(["accepted-by-authority"]);
      expect(announced).toEqual([["denied-by-authority", { epoch: origin.epoch, runId: origin.runId, turnId: origin.turnId }], ["accepted-by-authority", { epoch: origin.epoch, runId: origin.runId, turnId: origin.turnId }]]);
    } finally { await scope.revoke(); off(); }
  });

  it("admits explicit async preparation only with a socket-qualified fresh startup binding", async () => {
    const h = host();
    const scope = createSubagentScope({ origin, closure, sink: h.sink, sessionId: "parent-session" });
    try {
      const prepared = await scope.prepare({ roleText, selection: selection(), async: true }, catalog);
      expect(prepared.async).toBe(true);
      const binding = JSON.parse(JSON.stringify(prepared.options.extensionBindings));
      expect(binding["paperclip.subagents/1"].socket).toMatchObject({ schema: 1, sessionId: "parent-session", ownerPid: process.pid, origin, selection: { selectionId: "s1" } });
      // The original in-process association remains one-shot, even when async was requested.
      consumeChildBridgeLease(binding);
      expect(() => consumeChildBridgeLease(binding)).toThrow(/missing|consumed/i);
      expect(await scope.revoke()).toMatchObject({ status: "uncertain", unconfirmedAsyncSelections: ["s1"] });
    } finally { await scope.revoke(); }
    const unqualified = createSubagentScope({ origin, closure, sink: h.sink });
    await expect(unqualified.prepare({ roleText, selection: selection(), async: true }, catalog)).rejects.toThrow(/session/i);
    await unqualified.revoke();
  });

  it("revocation during host ACK cannot admit a tool or a delayed spawn", async () => {
    const f = await fixture();
    f.sink.toolExecutionStart = async () => { await f.scope.revoke(); return true; };
    expect(await f.child.call()).toMatchObject({ block: true });
    expect(f.child.effects).toEqual([]);
    const h = host();
    const scope = createSubagentScope({ origin, closure, sink: h.sink, announce: () => true });
    h.sink.recordSelection = async () => { await scope.revoke(); };
    await expect(scope.prepare({ roleText, selection: selection() }, catalog)).rejects.toThrow(/revoked/);
  });
});
