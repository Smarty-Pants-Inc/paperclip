// Offline executable canary: a REAL separate Node process and Pi SDK, synthetic provider only.
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import childBridge from "../child-bridge.ts";

const scratch = process.env.S1_CHILD_SCRATCH;
const noncePath = join(scratch, "socket-nonce.txt");
const model = getModel("anthropic", "claude-sonnet-4-5");
const runtime = {
  getModel: () => model, getPhysicalModel: () => model, getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true,
  isUsingOAuth: () => false, getRegisteredProviderConfig: () => undefined, getError: () => undefined,
  resolveModel: async (_model, _messages, options) => ({ model, thinkingLevel: options.thinkingLevel }),
};
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
const sessionManager = SessionManager.inMemory(scratch);
if (process.env.S1_CHILD_MODE === "resumed") sessionManager.appendMessage({ role: "user", content: "Saved prior-release child work", timestamp: Date.now() });
let requests = 0, effects = 0;
const errors = [];
let session;
const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  systemPrompt: "Controlled socket canary", agentsFilesOverride: () => ({ agentsFiles: [] }),
  extensionFactories: [childBridge, pi => {
    pi.registerTool({ name: "semantic_write", label: "Nonce", description: "Write nonce after native announce ACK", parameters: Type.Object({}), execute: async () => {
      effects++; await writeFile(noncePath, "socket-child-nonce\n"); return { content: [{ type: "text", text: "written" }], details: {} };
    } });
  }],
});
try {
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: scratch, agentDir: scratch, modelRuntime: runtime, model, thinkingLevel: "high", tools: ["semantic_write"], resourceLoader: loader, sessionManager, settingsManager }));
  session.extensionRunner.onError(error => { errors.push(error.error); });
  session.agent.streamFunction = () => {
    requests++;
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: requests === 1 ? [{ type: "toolCall", id: "native-socket-call", name: "semantic_write", arguments: {} }] : [{ type: "text", text: "done" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: requests === 1 ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: "done", reason: message.stopReason, message }); return stream;
  };
  await session.bindExtensions({ mode: "print" });
  await session.prompt("Execute the nonce probe");
  process.stdout.write(JSON.stringify({ pid: process.pid, requests, effects, errors, socketInherited: process.env.PAPERCLIP_PI_BIND_SOCKET ?? null, nonce: await readFile(noncePath, "utf8").catch(() => null), toolResults: session.messages.filter(message => message.role === "toolResult").map(message => ({ toolCallId: message.toolCallId, isError: message.isError })) }) + "\n");
} finally {
  await session?.abort();
  if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
}
