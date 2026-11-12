import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import childBridge from "./child-bridge.js";
import { createSubagentScope, type ChildBridgeSink } from "./host.js";
import { validateRoleTemplate } from "./role-template.js";

// Real Pi 1.5.2 SDK session; synthetic model stream only. No auth store, provider, network,
// real Langfuse exporter or pi-subagents factory internals are used by this test.
describe("F087 real Pi SDK event-order canary (controlled offline stream)", () => {
  it.each(["accepted", "sink-error", "stop-before-prompt", "stop-live-tool"])("%s has the expected nonce and native call lineage", async mode => {
    const scratch = await mkdtemp(join(tmpdir(), "pi-child-canary-"));
    const noncePath = join(scratch, "semantic-nonce.txt");
    const tracePath = join(scratch, "tracing.mjs");
    await writeFile(tracePath, 'export default function(pi) { pi.on("session_start", () => pi.events.emit("canary:trace-start", {})); }\n');
    const events: Array<Record<string, unknown>> = [];
    let traceStarts = 0, requests = 0, streamAttempts = 0;
    let toolStarted!: () => void;
    const liveTool = new Promise<void>(resolve => { toolStarted = resolve; });
    const roleText = "---\nname: probe\ntools: orchestrate, semantic_write\n---\nRun the probe.\n";
    const model = getModel("anthropic", "claude-sonnet-4-5")!;
    const sink: ChildBridgeSink = {
      recordSelection: async receipt => { events.push({ type: "selection", ...receipt }); },
      childReady: async receipt => { events.push({ type: "ready", ...receipt }); },
      startTurn: async event => { events.push({ type: "turn", ...event }); return `host-child-${events.length}`; },
      toolExecutionStart: async event => {
        events.push({ ...event });
        if (mode === "sink-error") throw new Error("host ledger did not ACK");
        return !event.revoked;
      },
      toolExecutionEnd: async event => { events.push({ ...event }); },
    };
    const origin = { epoch: 3, runId: "parent-run-3", turnId: "host-parent-turn", callId: "outer-subagent-call" };
    const scope = createSubagentScope({ origin, closure: { langfuseExtensionPath: tracePath }, sink });
    const prepared = await scope.prepare({ roleText, selection: {
      selectionId: `canary-${mode}`, roleId: "probe", roleDigest: validateRoleTemplate(roleText).digest,
      paretoChoice: "quality", paretoRevision: "r1", complexity: "small", rationale: "offline canary", budget: 1,
      model: `${model.provider}/${model.id}:high`,
    } }, () => ({ provider: model.provider, id: model.id, family: "claude", thinkingLevels: ["high"] }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({
      cwd: scratch, agentDir: scratch, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      systemPrompt: "Controlled offline child.", agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [async pi => {
        pi.events.on("canary:trace-start", () => { traceStarts++; });
        const priorBindings = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
        try {
          process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify(prepared.options.extensionBindings);
          await childBridge(pi);
        } finally {
          if (priorBindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
          else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = priorBindings;
        }
        pi.registerTool({ name: "semantic_write", label: "Nonce", description: "Write a local canary nonce", parameters: Type.Object({}),
          execute: async (toolCallId, _args, signal) => {
            if (mode === "stop-live-tool") {
              toolStarted();
              await new Promise<void>(resolve => {
                if (signal?.aborted) resolve();
                else signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              throw new Error("Tool cancelled before nonce write");
            }
            events.push({ type: "effect", toolCallId });
            await writeFile(noncePath, "accepted-child-nonce\n");
            return { content: [{ type: "text", text: "nonce written" }], details: {} };
          },
        });
        pi.registerTool({ name: "orchestrate", label: "Nested probe", description: "Exercise native nested tool events", parameters: Type.Object({}),
          execute: async (_id, _args, signal, _update, ctx) => {
            const outcome = await ctx.executeTool("semantic_write", {}, { signal });
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      }],
    });
    // Explicitly replace model runtime dependencies: no real credential is created or read.
    const runtime = {
      getModel: () => model, getPhysicalModel: () => model,
      getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
      isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined,
      getError: () => undefined,
      resolveModel: async (_model: unknown, _messages: unknown, options: { thinkingLevel: string }) => ({ model, thinkingLevel: options.thinkingLevel }),
    } as unknown as ModelRuntime;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: scratch, agentDir: scratch, modelRuntime: runtime, model, thinkingLevel: "high", tools: ["orchestrate", "semantic_write"], resourceLoader: loader, sessionManager: SessionManager.inMemory(scratch), settingsManager }));
      session.agent.streamFunction = (_model, _context, options) => {
        streamAttempts++;
        const aborted = options?.signal?.aborted;
        // A real provider must honor an already-aborted signal. Count accepted requests separately
        // from SDK stream invocations: Pi may invoke the stream once with an aborted signal.
        if (!aborted) requests++;
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant", content: aborted ? [] : requests === 1 ? [{ type: "toolCall", id: "native-model-call", name: "orchestrate", arguments: {} }] : [{ type: "text", text: "done" }],
          api: model.api, provider: model.provider, model: model.id, stopReason: aborted ? "aborted" : requests === 1 ? "toolUse" : "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
        } as AssistantMessage;
        if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
        else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        return stream;
      };
      await session.bindExtensions({ mode: "print" });
      expect(traceStarts).toBe(1);
      if (mode === "stop-before-prompt") await scope.revoke();
      const prompt = session.prompt("Execute the nonce probe.");
      if (mode === "stop-live-tool") {
        await liveTool;
        expect(await scope.revoke()).toMatchObject({ status: "abort-requested" });
      }
      await prompt;
      if (mode === "accepted") {
        expect(await readFile(noncePath, "utf8")).toBe("accepted-child-nonce\n");
        expect(session.getLastAssistantText()).toBe("done");
        expect(session.messages.filter(message => message.role === "toolResult").every(message => !message.isError)).toBe(true);
        const starts = events.filter(event => event.type === "tool_execution_start");
        expect(starts).toHaveLength(2);
        expect(starts[0]).toMatchObject({ origin, toolCallId: "native-model-call" });
        expect(starts[1]).toMatchObject({ origin, toolCallId: "native-model-call/1" });
        expect(events.findIndex(event => event.toolCallId === "native-model-call/1" && event.type === "tool_execution_start")).toBeLessThan(events.findIndex(event => event.type === "effect"));
      } else {
        await expect(readFile(noncePath, "utf8")).rejects.toThrow(/ENOENT/);
        expect(events.filter(event => event.type === "effect")).toEqual([]);
        if (mode === "stop-before-prompt") expect(requests).toBe(0);
        if (mode === "stop-live-tool") {
          expect(requests).toBe(1);
          expect(scope.stopReceipt()).toMatchObject({ status: "settled", unconfirmedChildSessions: [] });
          const ends = events.filter(event => event.type === "tool_execution_end");
          expect(ends).toHaveLength(2);
          for (const event of ends) expect(event).toMatchObject({ origin, revoked: true });
        }
      }
      const evidenceDir = process.env.PI_CHILD_CANARY_EVIDENCE_DIR;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(evidenceDir, `${mode}.json`), JSON.stringify({ mode, sdk: "1.5.2", stream: "synthetic-offline", streamAttempts, requests, traceStarts, nonce: await readFile(noncePath, "utf8").catch(() => null), events }, null, 2) + "\n");
      }
    } finally {
      await scope.revoke();
      await session?.abort();
      session?.dispose();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
