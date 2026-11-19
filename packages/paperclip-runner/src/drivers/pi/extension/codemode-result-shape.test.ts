import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installPiBindExtension, type PiBindApi, type PiBindInitial } from "./index.js";
import type { PiToolCallRequest, PiToolResult } from "../pi-bind-protocol.js";

// Keep reason: Paul's hired Lead (run b45d714e) ran a codemode script that read
// get_task(...).data.status and call_api(...).data.interactions and failed with
// "TypeError: cannot read property 'status' of undefined at codemode.js:4:31".
// Paperclip tools return a JSON object (the semantic contract's outputSchema is an
// object; a direct call shows the model that object), but the Pi bind extension
// registered them without an outputSchema, so Pi codemode handed scripts the JSON
// TEXT as a string (pi docs/extensions.md "Structured output"). This drives the REAL
// Pi 1.5.2 SDK session, the real built-in codemode extension (QuickJS) and the real
// Paperclip bind extension; only the model stream and the host tool dispatch are local.
const TASK_ID = "6b1f8f1e-6c55-4d2c-9a43-2f0b8a3c1d10";
const tools = [
  { name: "get_task", description: "Read another task through normal task permissions. Requires an explicit taskId UUID; use get_task_context with {} for the active task.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
  { name: "search_api", description: "Fallback only: discover Paperclip API operations when the available dedicated tools cannot express the task.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false } },
  { name: "call_api", description: "Fallback only: call a discovered Paperclip API operation when dedicated tools lack the required operation or parameters.",
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, pathParams: { type: "object", additionalProperties: { type: "string" } } }, required: ["operationId"], additionalProperties: false } },
  { name: "list_assigned_skills", description: "List immutable assigned skill versions pinned to this Runner turn.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
// Exactly what the server's tool authority returns for each tool (apiToolResult over
// runner-api-client's { ok, status, contentType, retryAfter, data } envelope; search_api's
// catalog page), JSON-serialized by runnerd into one text item and normalized by
// pi-rpc-driver's normalizePiToolResult: { content: [{ type: "text", text }], details: {} }.
const serverResults: Record<string, unknown> = {
  get_task: { ok: true, status: 200, contentType: "application/json; charset=utf-8", retryAfter: null, apiOperationId: "GET /api/issues/{id}",
    data: { id: TASK_ID, identifier: "PLAY-4", title: "Set up the playful org", status: "in_progress" } },
  search_api: { results: [{ operationId: "GET /api/issues/{id}/interactions", method: "GET", path: "/api/issues/{id}/interactions" }], total: 1, nextCursor: null },
  call_api: { ok: true, status: 200, contentType: "application/json; charset=utf-8", retryAfter: null, apiOperationId: "GET /api/issues/{id}",
    data: { id: TASK_ID, interactions: [{ id: "i-1", kind: "confirmation", status: "pending" }, { id: "i-2", kind: "question", status: "answered" }] } },
  list_assigned_skills: [{ key: "paperclip", name: "paperclip", versionId: "v-1", digest: "d-1" }],
};
// The live Lead's two attempts, line for line in shape: tool calls on lines 1-3, the
// first property read of a tool result on line 4 (codemode.js:4).
const FIRST_ATTEMPT = [
  `const task = await tools.get_task({ taskId: "${TASK_ID}" });`,
  `const ops = await tools.search_api({ query: "issue interactions" });`,
  `const operationId = "GET /api/issues/{id}";`,
  `return { taskStatus: task.data.status, operationId, found: ops.total };`,
].join("\n");
const RETRY = [
  `const res = await tools.call_api({ operationId: "GET /api/issues/{id}", pathParams: { id: "${TASK_ID}" } });`,
  `const wanted = "pending";`,
  `const label = "interactions";`,
  `return { pending: res.data.interactions.filter(i => i.status === wanted).length, label, apiStatus: res.status };`,
].join("\n");

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runCodemode(code: string, results: Record<string, PiToolResult> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-shape-")); roots.push(root); await chmod(root, 0o700);
  const agentDir = join(root, "agent");
  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  const runtime = {
    getModel: () => model, getPhysicalModel: () => model, getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
    isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined, getError: () => undefined,
    resolveModel: async (_model: unknown, _messages: unknown, options: { thinkingLevel: string }) => ({ model, thinkingLevel: options.thinkingLevel }),
  } as unknown as ModelRuntime;
  const initial: PiBindInitial = { schema: 1, sessionId: "session", epoch: 1, runId: "run-1", turnId: "turn-1",
    model: `${model.provider}/${model.id}`, thinkingLevel: "off", instructions: "Host instructions", tools };
  const dispatched: PiToolCallRequest[] = [];
  const dispatchTool = async (call: PiToolCallRequest): Promise<PiToolResult> => {
    dispatched.push(call);
    return results[call.tool] ?? { content: [{ type: "text", text: JSON.stringify(serverResults[call.tool]) }], details: {} };
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: "codemode shape canary", agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [createCodemodeExtension(), pi => {
      const control = installPiBindExtension(pi as unknown as PiBindApi, { socketPath: join(root, "bind.sock"), initial, hooks: { dispatchTool } });
      cleanups.push(() => control.close());
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", tools: ["+codemode"], resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager });
  cleanups.push(async () => { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  await session.bindExtensions({ mode: "print" });
  const requests: Context[] = [];
  const declared: Array<{ name: string; description: string }> = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(JSON.parse(JSON.stringify(context)) as Context);
    if (requests.length === 1) for (const tool of session.agent.state.tools) declared.push({ name: tool.name, description: tool.description });
    const toolTurn = requests.length === 1;
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: toolTurn ? [{ type: "toolCall", id: "codemode-call-1", name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }],
      stopReason: toolTurn ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
    stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message }); return stream;
  };
  await session.prompt("Check the task and its pending interactions.", { source: "rpc" });
  const toolResult = requests[1]?.messages.find(message => message.role === "toolResult") as { content: Array<{ type: string; text?: string }>; isError: boolean } | undefined;
  const text = toolResult?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
  const declarations = JSON.stringify(declared);
  return { text, isError: toolResult?.isError, dispatched, declarations };
}

const scriptValue = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

describe("Paperclip tools inside a real Pi codemode script", () => {
  it("resolve to the JSON object the tool returned: the Lead's get_task(...).data.status script reads", async () => {
    const result = await runCodemode(FIRST_ATTEMPT);
    expect(result.dispatched.map(call => call.tool)).toEqual(["get_task", "search_api"]);
    expect(result.text, result.text).toContain("Script completed");
    expect(result.text).not.toContain("TypeError");
    expect(scriptValue(result.text)).toEqual({ taskStatus: "in_progress", operationId: "GET /api/issues/{id}", found: 1 });
    expect(result.isError).toBe(false);
    // The model is shown the same shape it gets: the envelope's fields, not "a string".
    const shown = (name: string) => (JSON.parse(result.declarations) as Array<{ name: string; description: string }>).find(tool => tool.name === name)!.description;
    expect(shown("get_task")).toContain("Codemode: `tools.get_task(args)` resolves to `{ ok?, status?, data?, error?, apiOperationId? }`.");
    expect(shown("call_api")).toContain("Codemode: `tools.call_api(args)` resolves to `{ ok?, status?, data?, error?, apiOperationId? }`.");
    expect(shown("search_api")).toContain("Codemode: `tools.search_api(args)` resolves to `{ [key: string]: unknown; } | Array<unknown>`.");
  }, 30_000);

  it("resolve to the JSON object the tool returned: the Lead's retry call_api(...).data.interactions reads", async () => {
    const result = await runCodemode(RETRY);
    expect(result.dispatched.map(call => call.tool)).toEqual(["call_api"]);
    expect(result.text, result.text).toContain("Script completed");
    expect(scriptValue(result.text)).toEqual({ pending: 1, label: "interactions", apiStatus: 200 });
  }, 30_000);

  it("resolve to the list a list-returning tool returned", async () => {
    const result = await runCodemode(`const skills = await tools.list_assigned_skills({});\nreturn { first: skills[0].key, count: skills.length };`);
    expect(result.text, result.text).toContain("Script completed");
    expect(scriptValue(result.text)).toEqual({ first: "paperclip", count: 1 });
  }, 30_000);

  it("keeps a failed call a rejection carrying the tool's error text", async () => {
    const failed: PiToolResult = { content: [{ type: "text", text: "paperclip_runner_task_not_found" }], details: {}, isError: true };
    const result = await runCodemode(`try { await tools.get_task({ taskId: "${TASK_ID}" }); return "resolved"; } catch (error) { return "caught: " + error.message; }`, { get_task: failed });
    expect(result.dispatched).toHaveLength(1);
    expect(result.text, result.text).toContain("Script completed");
    expect(result.text).toContain("caught: paperclip_runner_task_not_found");
  }, 30_000);
});
