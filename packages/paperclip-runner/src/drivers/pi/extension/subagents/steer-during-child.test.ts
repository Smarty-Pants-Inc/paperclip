import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiSteerRecordingPeer } from "../../../../../test-support/pi-rpc-steer-peer.js";
import { PiRpcDriver, type PiRpcHarnessSession } from "../../pi-rpc-driver.js";
import { sendPiBindRequest, type Origin } from "../../pi-bind-protocol.js";
import { announce, captureOrigin, installPiBindExtension, registerStopChildren, type PiBindApi, type PiBindContext, type PiBindInitial } from "../index.js";
import { installChildBridge } from "./child-bridge.js";
import { consumeChildBridgeLease, createSubagentScope, type ChildBridgeSink, type ChildToolEvent } from "./host.js";
import { validateRoleTemplate } from "./role-template.js";
import { installSubagentSeam } from "./seam.js";

// Keep reason: rung-4 steering crosses the immutable parent/child authority trust
// boundary. Reuse the recorded JSONL peer and the real offline SDK-child harness.
// Only the parent's native input dispatch and scope-to-Stop adapter are controlled;
// neither fixture can mint Origin, bypass announce(), or invent child settlement.
describe("Pi RPC steer while an in-process child is running", () => {
  it("keeps the spawn Origin, ACKs the child's next native tool call, and reports settled Stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-steer-child-"));
    const noncePath = join(root, "child-effect.txt");
    const tracePath = join(root, "tracing.mjs");
    await writeFile(tracePath, "export default function() {}\n");
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"));
    const handlers = new Map<string, (event: any, context: PiBindContext) => any>();
    let idle = true;
    const context: PiBindContext = {
      sessionManager: { getSessionId: () => "native-parent" },
      isIdle: () => idle, hasPendingMessages: () => false,
      abort() { throw new Error("The active parent must not be aborted by steer"); },
      model: { provider: "paperclip", id: "neutral/vendor-model-not-in-bundled-catalog" },
    };
    const api: PiBindApi = {
      on(event, handler) { handlers.set(event, handler); return () => { handlers.delete(event); }; },
      registerTool() {}, registerProvider() {}, unregisterProvider() {},
      getActiveTools: () => [], setActiveTools() {}, getThinkingLevel: () => "off",
    };
    const emit = (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, context);
    let control: ReturnType<typeof installPiBindExtension> | undefined;
    let initial: PiBindInitial | undefined;
    let bindSocket = "";
    const inputs: Array<{ command: string; result: unknown }> = [];
    const nativeRequest = peer.transport.request.bind(peer.transport);
    let parent: PiRpcHarnessSession | undefined;
    let child: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let scope: ReturnType<typeof createSubagentScope> | undefined;
    let offSeam: (() => void) | undefined;
    let offStop: (() => void) | undefined;
    let childPrompt: Promise<unknown> | undefined;
    let releaseChild!: () => void;
    const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
    let childStarted!: () => void;
    const childRunning = new Promise<void>(resolve => { childStarted = resolve; });
    const toolStarts: ChildToolEvent[] = [];
    const announcements: Array<{ toolCallId: string; origin: Readonly<Origin>; ack: boolean }> = [];
    try {
      parent = await new PiRpcDriver({
        ...peer.driverOptions, runtimeDirectory: join(root, "parent"),
        environment: { ...peer.driverOptions.environment, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
        transportFactory(options) {
          initial = JSON.parse(readFileSync(options.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
          bindSocket = options.env!.PAPERCLIP_PI_BIND_SOCKET!;
          control = installPiBindExtension(api, { socketPath: bindSocket, initial: initial! });
          const startup = Promise.resolve(emit("session_start"));
          peer.transport.request = async (type, params) => {
            await startup;
            // Mirror Pi 1.5.2 native RPC dispatch: both commands pass source=rpc
            // through input, but queued steer must NOT run before_agent_start.
            if (type === "prompt" || type === "steer") {
              const result = await emit("input", { source: "rpc", text: params?.message });
              inputs.push({ command: type, result });
              if (result?.action !== "continue") throw new Error(`${type} input was refused`);
              if (type === "prompt") {
                await emit("before_agent_start", { systemPrompt: "native parent" });
                idle = false;
              }
            }
            return nativeRequest(type, params);
          };
          return peer.transport;
        },
      }).openSession({ runId: "steer-child-run", normalizedSessionId: "steer-child-parent", workingDirectory: root }) as PiRpcHarnessSession;
      const { turnId } = await parent.startTurn({ message: { role: "user", text: "scenario:queue" } });
      const before = captureOrigin()!;
      expect(before).toEqual({ epoch: initial!.epoch, runId: "steer-child-run", turnId });
      expect(Object.isFrozen(before)).toBe(true);
      offSeam = installSubagentSeam({
        announce(toolCallId, origin) {
          const ack = announce(toolCallId, origin);
          announcements.push({ toolCallId, origin, ack });
          return ack;
        },
        registerParkReadyContributor: () => () => {}, registerStopChildren: () => () => {},
      });
      const sink: ChildBridgeSink = {
        async recordSelection() {}, async childReady() {},
        async startTurn() { return "host-child-turn"; },
        async toolExecutionStart(event) { toolStarts.push(event); return !event.revoked; },
        async toolExecutionEnd() {},
      };
      scope = createSubagentScope({ origin: { ...before, callId: "outer-subagent-call" }, closure: { langfuseExtensionPath: tracePath }, sink });
      const model = getModel("anthropic", "claude-sonnet-4-5")!;
      const roleText = "---\nname: probe\ntools: semantic_write\n---\nRun the offline probe.\n";
      const prepared = await scope.prepare({ roleText, selection: {
        selectionId: "before-steer", roleId: "probe", roleDigest: validateRoleTemplate(roleText).digest,
        paretoChoice: "quality", paretoRevision: "r1", complexity: "small", rationale: "steer regression", budget: 1,
        model: `${model.provider}/${model.id}:high`,
      } }, () => ({ provider: model.provider, id: model.id, family: "claude", thinkingLevels: ["high"] }));
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        systemPrompt: "Controlled offline child.", agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [async pi => {
          await installChildBridge(pi, consumeChildBridgeLease(prepared.options.extensionBindings));
          pi.registerTool({ name: "semantic_write", label: "Nonce", description: "Write the local regression nonce", parameters: Type.Object({}),
            async execute() {
              await writeFile(noncePath, "post-steer-child-ACK\n");
              return { content: [{ type: "text", text: "accepted" }], details: {} };
            },
          });
        }],
      });
      // Same offline runtime as sdk-child.test.ts: no auth store or live provider.
      const runtime = {
        getModel: () => model, getPhysicalModel: () => model, getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
        isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined, getError: () => undefined,
        resolveModel: async (_model: unknown, _messages: unknown, options: { thinkingLevel: string }) => ({ model, thinkingLevel: options.thinkingLevel }),
      } as unknown as ModelRuntime;
      await loader.reload();
      ({ session: child } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model, thinkingLevel: "high", tools: ["semantic_write"], resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager }));
      let requests = 0;
      child.agent.streamFunction = () => {
        const request = ++requests;
        const stream = createAssistantMessageEventStream();
        const finish = () => {
          const message = { role: "assistant", content: request === 1
            ? [{ type: "toolCall", id: "post-steer-native-call", name: "semantic_write", arguments: {} }]
            : [{ type: "text", text: "done" }],
            api: model.api, provider: model.provider, model: model.id, stopReason: request === 1 ? "toolUse" : "stop", timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } as AssistantMessage;
          stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        };
        if (request === 1) { childStarted(); void childGate.then(finish); }
        else finish();
        return stream;
      };
      await child.bindExtensions({ mode: "print" });
      const childId = child.sessionManager.getSessionId();
      offStop = registerStopChildren(async () => {
        const receipt = await scope!.revoke();
        // Test-host adapter: report only the scope's confirmed native settlement,
        // never treat an abort request or a tool ACK as completed child work.
        return receipt.status === "settled" ? { settled: [childId], uncertain: [] }
          : { settled: [], uncertain: [childId, ...receipt.errors] };
      });
      childPrompt = child.prompt("Make the gated native tool call.");
      await childRunning;
      expect(child.isStreaming).toBe(true);
      expect(toolStarts).toEqual([]);
      expect(scope.stopReceipt()).toMatchObject({ status: "abort-requested", unconfirmedChildSessions: [childId] });
      await parent.steer!({ turnId, message: { role: "user", text: "steering-marker" } });
      const after = captureOrigin();
      expect(after).toBe(before);
      expect(after).toEqual({ epoch: initial!.epoch, runId: "steer-child-run", turnId });
      expect(control!.authority.capture()).toBe(before);
      expect((await parent.snapshot()).activeTurnId).toBe(turnId);
      releaseChild();
      await childPrompt;
      expect(announcements).toEqual([{ toolCallId: "post-steer-native-call", origin: before, ack: true }]);
      expect(toolStarts).toEqual([expect.objectContaining({ origin: { ...before, callId: "outer-subagent-call" }, toolCallId: "post-steer-native-call", childSessionId: childId, childTurnId: "host-child-turn", revoked: false })]);
      expect(await readFile(noncePath, "utf8")).toBe("post-steer-child-ACK\n");
      expect(child.messages.filter(message => message.role === "toolResult")).toEqual([expect.objectContaining({ toolCallId: "post-steer-native-call", isError: false })]);
      expect(scope.stopReceipt()).toMatchObject({ status: "settled", unconfirmedChildSessions: [] });
      const stop = await sendPiBindRequest(bindSocket, { schema: 1, type: "stop_children", nonce: "stop-after-steer", sessionId: "steer-child-parent" });
      expect(stop).toMatchObject({ settled: [childId], uncertain: [] });
      expect(inputs).toEqual([{ command: "prompt", result: { action: "continue" } }, { command: "steer", result: { action: "continue" } }]);
      const commands = (await peer.commands()).filter(command => ["prompt", "steer", "abort", "follow_up"].includes(command.type));
      expect(commands).toEqual([expect.objectContaining({ type: "prompt", message: "scenario:queue" }), expect.objectContaining({ type: "steer", message: "steering-marker" })]);
      if (process.env.PI_STEER_CHILD_PROOF_PATH) await writeFile(process.env.PI_STEER_CHILD_PROOF_PATH, JSON.stringify({ before, after, announcements, toolStarts, stop, inputs, commands, requests, fixture: "recorded JSONL parent + real offline SDK child; scope-to-Stop test adapter; no live provider" }, null, 2) + "\n");
    } finally {
      releaseChild();
      await childPrompt?.catch(() => undefined);
      await scope?.revoke();
      await child?.abort();
      child?.dispose();
      // Close while the actual bind listener and stop adapter are still alive.
      try { await parent?.close(); }
      finally {
        offStop?.(); offSeam?.();
        await control?.close();
        await peer.transport.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 15000);
});
