import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiEventProjector } from "../pi-event-projector.js";
import paperclipPiExtension, { piHostInstructionSegment, type PiBindApi } from "./index.js";

// Keep reason: Paul's Smarty did not know today's date. Pi has no date setting, so the
// shipped host extension tells the model the time once per run through Pi's documented
// before_agent_start per-run `message` return (a hidden custom message, sent to the model
// after the run's prompt), NOT a system-prompt section: our host-instructions handler
// forces the whole system prompt every run, so a per-run section would change the
// forced prompt bytes and miss the provider prompt cache on every run's first request.
// This drives the REAL Pi 1.5.2 SDK session with the real default host extension; only
// the model stream is local. One warm session crosses a mocked midnight.
const boundary = "paperclip-host-current-time-test";
const CUSTOM_TYPE = "paperclip.current-time";
const roots: string[] = [];
const sessions: Array<Awaited<ReturnType<typeof createAgentSession>>["session"]> = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const session of sessions.splice(0)) {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function warmSession() {
  const root = await mkdtemp(join(tmpdir(), "pi-current-time-")); roots.push(root);
  const agentDir = join(root, "agent");
  const instructions = join(root, "host.instructions.md");
  await writeFile(instructions, piHostInstructionSegment("Host instructions", boundary));
  for (const name of ["PAPERCLIP_PI_BIND_SOCKET", "PAPERCLIP_PI_BIND_INITIAL", "PAPERCLIP_PI_BIND_INITIAL_FILE"]) vi.stubEnv(name, undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PAPERCLIP_PI_INSTRUCTIONS_FILE", instructions);
  vi.stubEnv("PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY", boundary);
  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  const runtime = {
    getModel: () => model, getPhysicalModel: () => model,
    getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
    isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined, getError: () => undefined,
    resolveModel: async (_model: unknown, _messages: unknown, options: { thinkingLevel: string }) => ({ model, thinkingLevel: options.thinkingLevel }),
  } as unknown as ModelRuntime;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const sessionManager = SessionManager.inMemory(root);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: "Current time canary", appendSystemPrompt: [piHostInstructionSegment("stale instructions", boundary)],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => paperclipPiExtension(pi as unknown as PiBindApi)],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", tools: [], resourceLoader: loader, sessionManager, settingsManager });
  sessions.push(session);
  await session.bindExtensions({ mode: "print" });
  // What the provider actually receives for each request (after Pi's projections),
  // snapshotted as JSON so later runs cannot mutate an earlier request.
  const requests: Context[] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)) as Context);
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id,
      stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    stream.push({ type: "done", reason: "stop", message }); return stream;
  };
  // Every native event Pi emits, as the pi_rpc driver would relay it.
  const events: unknown[] = [];
  session.subscribe(event => { events.push(JSON.parse(JSON.stringify(event))); });
  return { session, requests, events };
}

const timeLines = (value: unknown) => JSON.stringify(value).match(/Current time: [^\\"<]*/g) ?? [];
/** The provider-facing system prompt bytes: every system message (head + any patches) and the top-level field. */
const systemBytes = (request: Context) => JSON.stringify({
  systemPrompt: request.systemPrompt ?? null,
  system: request.messages.filter(message => (message.role as string) === "system"),
});
/** Non-system messages a request added after the previous request's messages. */
const added = (request: Context, previous?: Context) => request.messages.slice(previous?.messages.length ?? 0);

async function oneRun(timeZone: string | undefined, at: string) {
  vi.stubEnv("TZ", timeZone);
  const harness = await warmSession();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  await harness.session.prompt("a run");
  return harness;
}

describe("Pi host extension: current time per run (hidden per-run message)", () => {
  it("gives two runs on ONE warm session across a mocked midnight two different dates, once each, with IDENTICAL system prompt bytes", async () => {
    vi.stubEnv("TZ", "America/New_York");
    const { session, requests } = await warmSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T04:59:30Z")); // 23:59:30 on the 16th in New York
    await session.prompt("first run");
    vi.setSystemTime(new Date("2026-11-17T05:00:30Z")); // 00:00:30 on the 17th in New York
    await session.prompt("second run, same warm session, after midnight");
    expect(requests).toHaveLength(2);
    const [first, second] = requests as [Context, Context];
    // Each run adds exactly one time line, after its own prompt, as a user-role context message.
    expect(timeLines(added(first))).toEqual(["Current time: 2026-11-16T23:59:30-05:00 (America/New_York)"]);
    expect(timeLines(added(second, first))).toEqual(["Current time: 2026-11-17T00:00:30-05:00 (America/New_York)"]);
    expect(added(second, first).map(message => message.role)).toEqual(["assistant", "user", "user"]);
    // C1: the cache prefix survives. The system prompt bytes are identical across both runs
    // and carry no time; run 2's request starts with run 1's request byte for byte.
    expect(systemBytes(second)).toBe(systemBytes(first));
    expect(timeLines(systemBytes(first))).toEqual([]);
    expect(getCurrentSystemPrompt(second.messages)).toBe(getCurrentSystemPrompt(first.messages));
    expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
    // Host instructions are still refreshed: the time does not displace them.
    for (const request of requests) expect(getCurrentSystemPrompt(request.messages)).toContain("Host instructions");
    // The transcript records one hidden custom message per run (Pi's documented message return).
    const custom = session.messages.filter(message => message.role === "custom");
    expect(custom.map(message => ({ customType: (message as { customType?: string }).customType, display: (message as { display?: boolean }).display, lines: timeLines(message) }))).toEqual([
      { customType: CUSTOM_TYPE, display: false, lines: ["Current time: 2026-11-16T23:59:30-05:00 (America/New_York)"] },
      { customType: CUSTOM_TYPE, display: false, lines: ["Current time: 2026-11-17T00:00:30-05:00 (America/New_York)"] },
    ]);
  });

  // One warm session per test: the host extension's process-global seams admit one live session.
  it("uses the environment's TZ with its daylight-saving offset (New York summer: -04:00; winter is -05:00 above)", async () => {
    const { requests } = await oneRun("America/New_York", "2026-07-01T16:00:00Z");
    expect(timeLines(added(requests[0]!))).toEqual(["Current time: 2026-07-01T12:00:00-04:00 (America/New_York)"]);
  });

  it("uses the environment's TZ with its daylight-saving offset (Berlin winter: +01:00)", async () => {
    const { requests } = await oneRun("Europe/Berlin", "2026-01-15T10:00:00Z");
    expect(timeLines(added(requests[0]!))).toEqual(["Current time: 2026-01-15T11:00:00+01:00 (Europe/Berlin)"]);
  });

  it("uses the environment's TZ with its daylight-saving offset (Berlin summer: +02:00)", async () => {
    const { requests } = await oneRun("Europe/Berlin", "2026-07-01T10:00:00Z");
    expect(timeLines(added(requests[0]!))).toEqual(["Current time: 2026-07-01T12:00:00+02:00 (Europe/Berlin)"]);
  });

  it("says UTC explicitly when TZ is unset, never a silent wrong zone", async () => {
    const { requests } = await oneRun(undefined, "2026-11-16T23:30:00Z");
    expect(timeLines(added(requests[0]!))).toEqual(["Current time: 2026-11-16T23:30:00Z (UTC; no TZ configured)"]);
  });

  it("says UTC explicitly when TZ is not a valid IANA zone", async () => {
    const { requests } = await oneRun("Not/AZone", "2026-11-16T23:30:00Z");
    expect(timeLines(added(requests[0]!))).toEqual(["Current time: 2026-11-16T23:30:00Z (UTC; TZ is not a valid IANA zone)"]);
  });

  it("C2: Pi's native events for the time message project to NO Paperclip run event (never a visible chat message)", async () => {
    const { events } = await oneRun("America/New_York", "2026-11-16T23:30:00Z");
    const timeEvents = events.filter(event => timeLines(event).length > 0);
    // Pi does announce the message natively (message_start/message_end, role "custom", display false) ...
    expect(timeEvents.map(event => (event as { type: string }).type)).toEqual(expect.arrayContaining(["message_start", "message_end"]));
    for (const event of timeEvents.filter(event => ["message_start", "message_end"].includes((event as { type: string }).type))) {
      expect((event as { message: { role: string; customType: string; display: boolean } }).message).toMatchObject({ role: "custom", customType: CUSTOM_TYPE, display: false });
    }
    // ... and the pi_rpc projector (native Pi RPC -> canonical Paperclip run events) drops it.
    const projector = createPiEventProjector({ runId: "pi-current-time", turnId: "t" });
    for (const event of timeEvents.filter(event => ["message_start", "message_end"].includes((event as { type: string }).type))) {
      expect(projector.project(event)).toEqual([]);
    }
  });

  it("also installs the time message in managed (broker-bound) mode without touching the prompt the authority handler forces", () => {
    for (const name of ["PAPERCLIP_PI_BIND_INITIAL_FILE", "PAPERCLIP_PI_INSTRUCTIONS_FILE", "PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY"]) vi.stubEnv(name, undefined);
    vi.stubEnv("PAPERCLIP_PI_BIND_SOCKET", "/pi-current-time-unopened.sock");
    vi.stubEnv("PAPERCLIP_PI_BIND_INITIAL", JSON.stringify({ schema: 1, sessionId: "session", epoch: 1, runId: "run", turnId: "turn", model: "paperclip/m", thinkingLevel: "low", instructions: "", tools: [] }));
    vi.stubEnv("TZ", "Asia/Kolkata");
    const registered = new Map<string, Array<(event: any, context: any) => any>>();
    const pi = { events: { on: () => () => {}, emit: () => {} },
      on: (name: string, handler: (event: any, context: any) => any) => { registered.set(name, [...registered.get(name) ?? [], handler]); return () => {}; },
      registerProvider() {}, unregisterProvider() {}, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, getThinkingLevel: () => "low" } as unknown as PiBindApi;
    paperclipPiExtension(pi);
    // No session_start: nothing opens. Shut down so process-global seams are released for later tests.
    cleanups.push(async () => { for (const handler of registered.get("session_shutdown") ?? []) await handler({}, {}); });
    const handlers = registered.get("before_agent_start") ?? [];
    expect(handlers).toHaveLength(2);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T23:30:00Z"));
    const systemPromptOptions = { sections: {} as Record<string, string> };
    const results = handlers.map(handler => { try { return handler({ type: "before_agent_start", messageType: "user", prompt: "p", systemPrompt: "S", systemPromptOptions }, { abort() {} }); } catch { return "refused"; } });
    expect(results).toContainEqual({ message: { customType: CUSTOM_TYPE, content: "Current time: 2026-11-17T05:00:00+05:30 (Asia/Kolkata)", display: false } });
    expect(systemPromptOptions.sections).toEqual({});
  });
});
