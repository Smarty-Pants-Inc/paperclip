import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import paperclipPiExtension, { type PiBindApi, type PiBindContext } from "./extension/index.js";
import { createPiEventProjector, type PiProjectedEvent } from "./pi-event-projector.js";

// Independent wire literals: importing a future helper/marker would conceal a broken installation.
const marker = "paperclip.provider-performance.v1";
const code = "provider_performance_spans";
const instant = (at: number) => ({ name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" });
const diagnostic = (at: number) => ({ code, spans: [instant(at)] });
const entry = (id: string, data: unknown, customType = marker) => ({
  type: "entry_appended", entry: { type: "custom", id, parentId: null, timestamp: "2099-01-01T00:00:00Z", customType, data },
});
const performance = (events: PiProjectedEvent[]) => events.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === code);
type Handler = (event: unknown, context: PiBindContext) => unknown;
const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0).reverse()) await shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function extension(mode: "managed" | "native", append: (customType: string, data: unknown) => void) {
  for (const name of ["PAPERCLIP_PI_BIND_SOCKET", "PAPERCLIP_PI_BIND_INITIAL", "PAPERCLIP_PI_BIND_INITIAL_FILE", "PAPERCLIP_PI_INSTRUCTIONS_FILE", "PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY"]) vi.stubEnv(name, undefined);
  if (mode === "managed") {
    // No session_start: the real factory registers its public hooks without opening a socket.
    vi.stubEnv("PAPERCLIP_PI_BIND_SOCKET", "/pi-request-performance-unopened.sock");
    vi.stubEnv("PAPERCLIP_PI_BIND_INITIAL", JSON.stringify({ schema: 1, sessionId: "session", epoch: 1, runId: "run", turnId: "turn", model: "paperclip/m", thinkingLevel: "low", instructions: "", tools: [] }));
  } else {
    vi.stubEnv("PAPERCLIP_PI_INSTRUCTIONS_FILE", join(tmpdir(), "pi-request-performance-unread.md"));
    vi.stubEnv("PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY", "request-test-boundary");
  }
  const handlers = new Map<string, Handler[]>();
  let active: string[] = [];
  const pi: PiBindApi & { appendEntry(customType: string, data: unknown): void } = {
    events: { on: () => () => {}, emit: () => {} },
    on: (name, handler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler); handlers.set(name, registered);
      return () => { handlers.set(name, registered.filter(value => value !== handler)); };
    },
    appendEntry: append,
    registerProvider: () => {}, unregisterProvider: () => {}, registerTool: () => {},
    getActiveTools: () => active, setActiveTools: names => { active = names; },
    getThinkingLevel: () => "low", setThinkingLevel: () => {},
  };
  const ctx: PiBindContext = { sessionManager: { getSessionId: () => "native-session" }, isIdle: () => true, hasPendingMessages: () => false, abort: () => {} };
  paperclipPiExtension(pi);
  shutdowns.push(async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); });
  return { handlers, ctx };
}

// Keep reason: data-safety boundary; a request observer must not become a payload transformer.
describe("Pi pre-dispatch logical-request observation (not physical wire/internal HTTP-attempt evidence)", () => {
  it.each(["managed", "native"] as const)("installs the real public before_provider_request hook once for %s and appends a timing-only instant", async mode => {
    const writes: Array<{ customType: string; data: unknown }> = [];
    const { handlers, ctx } = extension(mode, (customType, data) => { writes.push({ customType, data }); });
    const hooks = handlers.get("before_provider_request") ?? [];
    expect(hooks, "the default host extension must install the actual Pi request hook").toHaveLength(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    let payloadReads = 0;
    const poisoned = Object.defineProperty({ type: "before_provider_request" }, "payload", { enumerable: true, get() { payloadReads++; throw new Error("PRIVATE_PROVIDER_PAYLOAD"); } });
    expect(await hooks[0]!(poisoned, ctx)).toBeUndefined();
    clock.mockReturnValue(1_800_000_000_007);
    const payload = Object.freeze({ messages: Object.freeze([{ content: "PRIVATE_PROMPT" }]), tools: Object.freeze([]) });
    const event = Object.freeze({ type: "before_provider_request", payload });
    expect(await hooks[0]!(event, ctx)).toBeUndefined();
    expect(event.payload).toBe(payload);
    expect(payload.messages[0]!.content).toBe("PRIVATE_PROMPT");
    expect(payloadReads).toBe(0);
    expect(writes).toEqual([
      { customType: marker, data: diagnostic(1_800_000_000_000) },
      { customType: marker, data: diagnostic(1_800_000_000_007) },
    ]);
    const projector = createPiEventProjector({ runId: "hook-run", turnId: "hook-turn" });
    expect(writes.flatMap((write, index) => performance(projector.project(entry(`hook-${index}`, write.data, write.customType)))).map(value => value.payload))
      .toEqual([diagnostic(1_800_000_000_000), diagnostic(1_800_000_000_007)]);
  });

  it("returns undefined and fails open when appendEntry throws, without reading the provider payload", async () => {
    let attempts = 0, payloadReads = 0;
    const { handlers, ctx } = extension("native", () => { attempts++; throw new Error("PRIVATE_APPEND_ERROR"); });
    const hooks = handlers.get("before_provider_request") ?? [];
    expect(hooks).toHaveLength(1);
    const event = Object.defineProperty({ type: "before_provider_request" }, "payload", { get() { payloadReads++; throw new Error("PRIVATE_PAYLOAD"); } });
    expect(await hooks[0]!(event, ctx)).toBeUndefined();
    expect(attempts).toBe(1);
    expect(payloadReads).toBe(0);
  });
});

// Keep reason: native custom entries are untrusted; only timing fields and admitted origin cross PRP.
describe("owned Pi custom entry -> admitted-turn performance diagnostic", () => {
  it("projects timing only, snapshots the admitted origin, and ignores forged entry time/owner and opaque fields", () => {
    const at = Date.now();
    const origin = { runId: "admitted-run", turnId: "admitted-turn" };
    const projector = createPiEventProjector(origin);
    Object.assign(origin, { runId: "later-run", turnId: "later-turn" });
    const row = { ...instant(at), runId: "forged-run", turnId: "forged-turn", provider: "forged-provider", attributes: { prompt: "PRIVATE_PROMPT", path: "/PRIVATE/PATH" } };
    const native = entry("timing-entry", { code, spans: [row], runId: "forged-run", turnId: "forged-turn", payload: "PRIVATE_PAYLOAD" });
    const before = JSON.stringify(native);
    const projected = performance(projector.project(native));
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ runId: "admitted-run", turnId: "admitted-turn", eventType: "harness.diagnostic" });
    expect(projected[0]!.payload).toEqual(diagnostic(at));
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|forged|2099/);
    expect(JSON.stringify(native)).toBe(before);
  });

  it("does not traverse arbitrary owned-entry attributes just to find the timing fields", () => {
    const at = Date.now();
    let opaqueReads = 0;
    const row = Object.defineProperty({ ...instant(at) }, "attributes", { enumerable: true, get() { opaqueReads++; throw new Error("PRIVATE_OPAQUE_BODY"); } });
    const native = entry("opaque-entry", { code, spans: [row] });
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    const projected = performance(projector.project(native));
    expect(projected.map(event => event.payload)).toEqual([diagnostic(at)]);
    expect(opaqueReads).toBe(0);
  });

  it("keeps 24 distinct logical requests including same-millisecond sends after generic activity suppression; retry/turn notices do not synthesize sends", () => {
    const at = Date.now();
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    for (let index = 0; index < 24; index++) projector.project({ type: `unrelated-native-activity-${index}` });
    const actual: PiProjectedEvent[] = [];
    for (let index = 0; index < 24; index++) {
      // Two real invocations can share Date.now(); entry identity, not time, distinguishes them.
      actual.push(...performance(projector.project(entry(`request-${index}`, diagnostic(at + Math.floor(index / 2))))));
      for (const type of ["turn_start", "turn_end", "auto_retry_start", "auto_retry_end", "agent_end"]) {
        expect(performance(projector.project({ type })), type).toEqual([]);
      }
    }
    expect(actual).toHaveLength(24);
    expect(actual.map(event => event.payload)).toEqual(Array.from({ length: 24 }, (_, index) => diagnostic(at + Math.floor(index / 2))));
  });

  it("admits only the exact owned marker, custom entry type, phase and zero-duration timestamps", () => {
    const at = Date.now();
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    expect(performance(projector.project(entry("valid", diagnostic(at))))).toHaveLength(1);
    const invalid = [
      entry("other-marker", diagnostic(at), `${marker}.other`),
      { type: "entry_appended", entry: { type: "message", customType: marker, data: diagnostic(at) } },
      ...[
        { ...instant(at), name: "pi.request.sent.extra" },
        { ...instant(at), name: "provider.model.stream" },
        { ...instant(at), endedAtMs: at + 1 },
        { ...instant(at), endedAtMs: at - 1 },
        { ...instant(at), startedAtMs: "now" },
        { ...instant(at), startedAtMs: Infinity },
        { ...instant(at), endedAtMs: NaN },
      ].map((row, index) => entry(`invalid-${index}`, { code, spans: [row] })),
    ];
    for (const native of invalid) expect(performance(projector.project(native))).toEqual([]);
  });
});
