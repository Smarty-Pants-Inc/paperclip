import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import paperclipPiExtension, { piHostInstructionSegment, type PiBindApi } from "./index.js";

// Keep reason: Paul's Smarty did not know today's date. Pi has no date setting, so the
// shipped host extension adds one prompt section per run (Pi's documented
// before_agent_start systemPromptOptions.sections seam). This drives the REAL Pi 1.5.2
// SDK session (extension runner, section diff, forced-prompt projection) with the real
// default host extension; only the model stream is local. One warm session crosses a
// mocked day change, so a session that outlives a day must still get today's time.
const boundary = "paperclip-host-current-time-test";
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
  // What the provider actually receives for each request (after Pi's projections).
  const requests: string[] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.stringify(context));
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id,
      stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    stream.push({ type: "done", reason: "stop", message }); return stream;
  };
  return { session, requests };
}

const timeLines = (text: string) => text.match(/Current time: [^\\"<]*/g) ?? [];

describe("Pi host extension: current time per run", () => {
  it("gives two runs on ONE warm session across a day change two different dates, in the env's TZ, exactly once each", async () => {
    vi.stubEnv("TZ", "America/New_York");
    const { session, requests } = await warmSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T23:30:00Z"));
    await session.prompt("first run");
    vi.setSystemTime(new Date("2026-11-17T23:30:00Z"));
    await session.prompt("second run, same warm session, next day");
    expect(requests).toHaveLength(2);
    expect(timeLines(requests[0]!)).toEqual(["Current time: 2026-11-16T18:30:00-05:00 (America/New_York)"]);
    expect(timeLines(requests[1]!)).toEqual(["Current time: 2026-11-17T18:30:00-05:00 (America/New_York)"]);
    // Host instructions are still refreshed alongside: the time does not displace them.
    for (const request of requests) expect(request).toContain("Host instructions");
    // The transcript records one structured section patch per run (Pi's preferred seam), never a duplicated message.
    const system = session.messages.filter(message => message.role === "system");
    expect(system.flatMap(message => timeLines(JSON.stringify(message)))).toEqual([
      "Current time: 2026-11-16T18:30:00-05:00 (America/New_York)",
      "Current time: 2026-11-17T18:30:00-05:00 (America/New_York)",
    ]);
    expect(session.messages.filter(message => message.role === "custom")).toEqual([]);
  });

  it("uses the TZ from the environment, including its daylight-saving offset", async () => {
    vi.stubEnv("TZ", "Europe/Berlin");
    const { session, requests } = await warmSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
    await session.prompt("summer run");
    expect(timeLines(requests[0]!)).toEqual(["Current time: 2026-07-01T12:00:00+02:00 (Europe/Berlin)"]);
  });

  it("says UTC explicitly when TZ is unset, never a silent wrong zone", async () => {
    vi.stubEnv("TZ", undefined);
    const { session, requests } = await warmSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T23:30:00Z"));
    await session.prompt("no zone configured");
    expect(timeLines(requests[0]!)).toEqual(["Current time: 2026-11-16T23:30:00Z (UTC; no TZ configured)"]);
  });

  it("also installs the time section ahead of the managed (broker-bound) authority handler, whose forced prompt renders it", () => {
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
    expect(handlers[0]!({ type: "before_agent_start", systemPromptOptions }, {})).toBeUndefined();
    expect(systemPromptOptions.sections).toEqual({ current_time: "Current time: 2026-11-17T05:00:00+05:30 (Asia/Kolkata)" });
  });

  it("says UTC explicitly when TZ is not a valid IANA zone", async () => {
    vi.stubEnv("TZ", "Not/AZone");
    const { session, requests } = await warmSession();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T23:30:00Z"));
    await session.prompt("bad zone configured");
    expect(timeLines(requests[0]!)).toEqual(["Current time: 2026-11-16T23:30:00Z (UTC; TZ is not a valid IANA zone)"]);
  });
});
