import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import piSubagents from "pi-subagents";
import { createSubagentLifecycle, SESSION_LIVENESS_KEY } from "./lifecycle.js";

// REAL public pi-subagents extension + SDK event bus/liveness/RPC and async spawn path.
// No live provider is called. The documented launcher is a deliberately failing env probe,
// NOT a successful SDK child run: it writes only the socket env and exits before startup.
describe("S-1 real pi-subagents 0.88.0 offline host bridge", () => {
  it("registers session liveness, answers real status RPC, inherits the bind socket into its async launcher", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "s1-package-"));
    const agentDir = join(scratch, "agent");
    const receiptPath = join(scratch, "runner-env.json");
    const launcherPath = join(scratch, "env-probe.mjs");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const priorRegistry = globals[SESSION_LIVENESS_KEY];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let lifecycle: ReturnType<typeof createSubagentLifecycle> | undefined;
    try {
      delete globals[SESSION_LIVENESS_KEY];
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
      vi.stubEnv("PI_SUBAGENT_CHILD", "0");
      vi.stubEnv("PAPERCLIP_PI_BIND_SOCKET", join(scratch, "private-bind.sock"));
      vi.stubEnv("PI_CODING_AGENT_PACKAGE_ROOT", dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!));
      await mkdir(join(agentDir, "extensions/subagent"), { recursive: true });
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await writeFile(launcherPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({pid:process.pid,socket:process.env.PAPERCLIP_PI_BIND_SOCKET})); process.exit(72);\n`);
      await writeFile(join(agentDir, "extensions/subagent/config.json"), JSON.stringify({ disableBuiltins: true, runnerLaunchers: { probe: [process.execPath, launcherPath] } }));
      await writeFile(join(agentDir, "agents/probe.md"), "---\nname: probe\ndescription: Offline environment probe\nlauncher: probe\ntools: read\n---\nNever contact a provider.\n");
      const model = getModel("anthropic", "claude-sonnet-4-5")!;
      const runtime = {
        getModel: () => model, getPhysicalModel: () => model,
        getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
        isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined, getError: () => undefined,
        resolveModel: async (_model: unknown, _messages: unknown, options: { thinkingLevel: string }) => ({ model, thinkingLevel: options.thinkingLevel }),
      } as unknown as ModelRuntime;
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      const sessionManager = SessionManager.inMemory(scratch);
      const loader = new DefaultResourceLoader({ cwd: scratch, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        systemPrompt: "Offline package canary", agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [pi => {
          lifecycle = createSubagentLifecycle({ sessionId: sessionManager.getSessionId(), events: pi.events, abortParent: () => session!.abort(), timeoutMs: 300, rpcTimeoutMs: 100,
            seam: { registerParkReadyContributor: () => () => {}, registerStopChildren: () => () => {} },
          });
          return piSubagents(pi);
        }],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: scratch, agentDir, modelRuntime: runtime, model, thinkingLevel: "high", tools: ["subagent"], resourceLoader: loader, sessionManager, settingsManager }));
      await session.bindExtensions({ mode: "print" });
      expect(lifecycle!.parkReady()).toEqual({ ready: true, reasons: [] });
      expect(await lifecycle!.stopAll("idle real package")).toEqual({ settled: [], uncertain: [] });
      expect(session.extensionRunner.getToolDefinition("subagent")).toBeDefined();
      let requests = 0;
      session.agent.streamFunction = () => {
        requests++;
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", content: requests === 1
          ? [{ type: "toolCall", id: "native-env-probe", name: "subagent", arguments: { agent: "probe", task: "Offline environment probe", model: "anthropic/claude-sonnet-4-5:high", async: true } }]
          : [{ type: "text", text: "done" }],
          api: model.api, provider: model.provider, model: model.id, stopReason: requests === 1 ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } as AssistantMessage;
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); return stream;
      };
      await session.prompt("Run the offline async launcher environment probe.");
      const result = session.messages.filter(message => message.role === "toolResult");
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ toolCallId: "native-env-probe", isError: true });
      expect(requests).toBe(2);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(receipt.socket).toBe(join(scratch, "private-bind.sock"));
      // The probe cannot leave a detached runner behind, including after startup failure.
      expect(() => process.kill(receipt.pid, 0)).toThrow(/ESRCH|no such process/i);
      expect(JSON.stringify(result)).toMatch(/exit|startup|failed|72/i);
      const evidenceDir = process.env.PI_CHILD_CANARY_EVIDENCE_DIR;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(evidenceDir, "s1-real-package.json"), JSON.stringify({ package: "pi-subagents@0.88.0", sdk: "1.5.2", livenessRegistered: true, idleStopViaRealRpc: true, runnerEnvInherited: receipt.socket, launcherOnly: true, syntheticModelRequests: requests, liveProviderRequests: 0, processReaped: true, result }, null, 2) + "\n");
      }
    } finally {
      try {
        if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
      } finally {
        lifecycle?.dispose();
        if (priorRegistry === undefined) delete globals[SESSION_LIVENESS_KEY]; else globals[SESSION_LIVENESS_KEY] = priorRegistry;
        vi.unstubAllEnvs(); await rm(scratch, { recursive: true, force: true });
      }
    }
  });
});
