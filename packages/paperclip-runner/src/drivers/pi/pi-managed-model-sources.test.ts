// Keep: the real -lf5d catch and the user-config-to-managed-broker trust boundary.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PiBindCommand, PiBindResponse } from "./pi-bind-protocol.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";

class IdleTransport {
  pid = 42;
  exited = false;
  #wake?: (value: IteratorResult<PiRpcRecord>) => void;
  async request(type: string) {
    const model = { provider: "paperclip", id: "source-proof" };
    return { success: true, data: type === "get_state" ? { model, sessionId: "source-session", thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model : type === "get_available_models" ? { models: [{ ...model, contextWindow: 200000 }] } : type === "get_available_thinking_levels" ? { levels: ["off"] } : undefined };
  }
  events(): AsyncIterable<PiRpcRecord> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.exited ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => { this.#wake = resolve; }) }) };
  }
  async close() { this.exited = true; this.#wake?.({ value: undefined, done: true }); }
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const model = (fields: Record<string, unknown>) => ({ id: "source-proof", ...fields });
const provider = (fields: Record<string, unknown>) => ({ models: [model(fields)] });

async function fixture(primary: unknown, user: unknown, originalPiDir = false, managedPiDir = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-model-sources-"));
  const home = join(root, "home", "user"), runtime = join(root, "run"), agent = join(runtime, "agent");
  const original = originalPiDir ? join(root, "original-pi") : join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true }); await mkdir(original, { recursive: true });
  const agentFile = join(agent, "models.json"), userFile = join(original, "models.json");
  await writeFile(agentFile, JSON.stringify(primary));
  if (user === "unreadable") await mkdir(userFile);
  else if (user !== undefined) await writeFile(userFile, typeof user === "string" ? user : JSON.stringify(user));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", originalPiDir ? original : undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const transport = new IdleTransport();
  const session = await new PiRpcDriver({ model: "paperclip/source-proof", piRpcThinkingLevel: "off", runtimeDirectory: runtime,
    environment: { HOME: home, ...(managedPiDir ? { PI_CODING_AGENT_DIR: agent } : {}), PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    transportFactory: () => transport as unknown as PiRpcTransport,
    bindRequest: async <C extends PiBindCommand>(_path: string, request: C) => {
      if (request.type !== "stop_children") throw new Error("source fixture only supports Stop");
      return { schema: 1, type: "stop_children", nonce: request.nonce, sessionId: request.sessionId, settled: [], uncertain: [] } as unknown as PiBindResponse<C>;
    },
  }).openSession({ runId: "source-run", normalizedSessionId: "source-session", workingDirectory: root }) as PiRpcHarnessSession;
  try {
    const disk = JSON.parse(await readFile(agentFile, "utf8"));
    return { root, userFile, disk, metadata: disk.providers.paperclip.models[0], diagnostics: warn.mock.calls.map(call => String(call[0])) };
  } finally { await session.close(); expect(transport.exited).toBe(true); }
}

it("reads the exact-id cap only in the original HOME when the runner has no Pi dir", async () => {
  const snapshot = { providers: { unrelated: { models: [{ id: "different", contextWindow: 1 }] }, "cliproxyapi-anthropic": provider({ thinkingLevelMap: { max: null }, contextWindow: 900000, maxTokens: 123000, reasoning: true, apiKey: "must-not-cross", baseUrl: "https://must-not-cross.invalid", api: "wrong-api" }) } };
  const f = await fixture({ providers: { other: { models: [{ id: "different" }] } } }, snapshot);
  expect(f.metadata).toEqual(model({ thinkingLevelMap: { max: null }, contextWindow: 900000, maxTokens: 123000, reasoning: true }));
  expect(f.disk.providers.paperclip.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(f.disk.providers["cliproxyapi-anthropic"]).toBeUndefined();
  expect(await readFile(f.userFile, "utf8")).toBe(JSON.stringify(snapshot));
  expect(f.diagnostics).toEqual([]);
});

it("prefers the agent source per field, then the user's paperclip entry over its other provider", async () => {
  const f = await fixture({ providers: { paperclip: provider({ contextWindow: 111111, thinkingLevelMap: { max: null } }), other: provider({ maxTokens: 1, reasoning: true }) } },
    { providers: { native: provider({ contextWindow: 999999, maxTokens: 2, reasoning: true }), paperclip: provider({ contextWindow: 222222, maxTokens: 33333, reasoning: false, thinkingLevelMap: { max: "max", xhigh: null } }) } });
  expect(f.metadata).toEqual(model({ contextWindow: 111111, maxTokens: 33333, reasoning: false, thinkingLevelMap: { max: null, xhigh: null } }));
  expect(f.diagnostics).toEqual([]);
});

it("keeps an exact agent entry on another provider ahead of a user paperclip entry", async () => {
  const f = await fixture({ providers: { paperclip: { models: [{ id: "different" }] }, native: provider({ contextWindow: 444444, maxTokens: 55555, reasoning: true }) } },
    { providers: { paperclip: provider({ contextWindow: 222222, maxTokens: 33333, reasoning: false, thinkingLevelMap: { max: null } }) } });
  expect(f.metadata).toEqual(model({ contextWindow: 444444, maxTokens: 55555, reasoning: true, thinkingLevelMap: { max: null } }));
});

it("captures the runner's original PI_CODING_AGENT_DIR before the driver sets run/agent", async () => {
  const f = await fixture({}, { providers: { native: provider({ contextWindow: 777777, maxTokens: 66666, reasoning: true }) } }, true);
  expect(f.metadata).toEqual(model({ contextWindow: 777777, maxTokens: 66666, reasoning: true }));
});

it("does not mistake a child managed-home override for the runner's original Pi dir", async () => {
  const metadata = { contextWindow: 777777, maxTokens: 66666, reasoning: true, thinkingLevelMap: { max: null } };
  const f = await fixture({}, { providers: { native: provider(metadata) } }, false, true);
  expect(f.metadata).toEqual(model(metadata));
});

it.each([undefined, "{invalid-json", "[]", "unreadable", { providers: { native: provider({ maxTokens: -1 }) } }, " ".repeat(61 * 1024)])("skips an unavailable/invalid optional user file with one bounded diagnostic (%#)", async user => {
  const metadata = { contextWindow: 333333, maxTokens: 44444, reasoning: true };
  const f = await fixture({ providers: { paperclip: provider(metadata) } }, user);
  expect(f.metadata).toEqual(model(metadata));
  expect(f.diagnostics).toHaveLength(1);
  expect(f.diagnostics[0]!.length).toBeLessThanOrEqual(256);
  expect(f.diagnostics[0]!.split("\n")).toHaveLength(1);
});
