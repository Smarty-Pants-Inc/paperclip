// Keep: gateway routing must use Pi's persisted identity, never prompt-prefix matching.
// Agreed offline request-boundary test: real Pi 1.5.2 client, no provider traffic.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateBindRequest, type PiBindModel } from "./pi-bind-protocol.js";
import { buildPiManagedModel } from "./pi-managed-model.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { id: "affinity-proof", contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"] };
const runnerRoot = fileURLToPath(new URL("../../..", import.meta.url));
// Each invocation is a fresh process: no client/session singleton can fake persistence.
const launch = String.raw`
  const input = JSON.parse(await new Promise(resolve => {
    let text = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => resolve(text));
  }));
  globalThis.fetch = () => { throw new Error("Unexpected network access"); };
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
  const manager = input.file ? SessionManager.open(input.file) : SessionManager.create(input.root, input.root);
  if (!input.file) manager.appendMessage({ role: "user", content: "Daily task", timestamp: 1 });
  const captured = [];
  const fetch = async (url, init) => {
    captured.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    // A terminal non-retryable response proves construction without simulating an LLM.
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Offline capture" } }),
      { status: 400, headers: { "content-type": "application/json" } });
  };
  const result = await stream({ ...input.model, api: "anthropic-messages", provider: "paperclip", baseUrl: "http://127.0.0.1:1",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { messages: [{ role: "system", content: "Work on the daily task.", timestamp: 0 }, { role: "user", content: "Daily task", timestamp: 1 }] },
    { apiKey: "offline-capability", sessionId: manager.getSessionId(), fetch, maxTokens: 16 }).result();
  if (result.stopReason !== "error" || captured.length !== 1) throw new Error("Offline capture did not complete exactly once");
  process.stdout.write(JSON.stringify({ sessionId: manager.getSessionId(), file: manager.getSessionFile(), request: captured[0] }));
`;
type Capture = { sessionId: string; file: string; request: { url: string; headers: Record<string, string>; body: Record<string, unknown> } };
function capture(root: string, model: PiBindModel, file?: string): Capture {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", launch], {
    cwd: runnerRoot, input: JSON.stringify({ root, model, file }), encoding: "utf8", timeout: 20000,
  }));
}
async function managed() {
  return buildPiManagedModel({ snapshot: { providers: { paperclip: { api: "anthropic-messages", models: [limits] } } },
    id: limits.id, api: "anthropic-messages", warn: () => {} });
}
function bind(model: PiBindModel) {
  return { schema: 1, type: "bind", nonce: "affinity", sessionId: "private-envelope", expectedPriorEpoch: 0,
    epoch: 1, runId: "run", model: `paperclip/${model.id}`, thinkingLevel: "off", instructions: "Daily task", tools: [],
    provider: { name: "paperclip", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "offline-capability", models: [model] } };
}

describe("managed Pi session-affinity request headers", () => {
  it("sends the persisted Pi id across cold launches, isolates another session, and keeps identity out of prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-affinity-")); roots.push(root);
    const model = await managed();
    const first = capture(root, model);
    const resumed = capture(root, model, first.file);
    const other = capture(root, model);
    console.info("Pi offline request captures", JSON.stringify({ first, resumed, other }));
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(other.sessionId).not.toBe(first.sessionId);
    for (const item of [first, resumed, other]) {
      expect(item.request.headers["x-session-id"]).toBe(item.sessionId);
      expect(item.request.headers["x-session-affinity"]).toBeUndefined();
      expect(JSON.stringify(item.request.body)).not.toContain(item.sessionId);
      expect(JSON.stringify(item.request.body)).not.toContain("x-session-id");
      expect(item.request.body.system).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Work on the daily task." })]));
      expect(item.request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
    }
    // Both unconfigured base and explicit compat-off controls use the real client.
    const base = capture(root, limits as PiBindModel);
    const off = capture(root, { ...model, compat: { ...model.compat, sendSessionAffinityHeaders: false } });
    console.info("Pi offline negative controls", JSON.stringify({ base, off }));
    expect(base.request.headers["x-session-id"]).toBeUndefined();
    expect(base.request.headers["x-session-affinity"]).toBeUndefined();
    expect(off.request.headers["x-session-id"]).toBeUndefined();
  }, 90000);

  it("forces gateway affinity while preserving unrelated configured compat", async () => {
    const model = await buildPiManagedModel({ snapshot: { providers: { paperclip: { api: "anthropic-messages",
      models: [{ ...limits, compat: { supportsTemperature: false, sendSessionAffinityHeaders: false } }] } } },
      id: limits.id, api: "anthropic-messages", warn: () => {} });
    expect(model.compat).toEqual({ supportsTemperature: false, sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" });
  });

  it("admits the two affinity keys across the private bind", async () => {
    expect(validateBindRequest(bind({ ...await managed(), compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" } }))).toBe(true);
  });

  it.each([{ sendSessionAffinityHeaders: "true" }, { sessionAffinityFormat: true }, { sessionAffinityFormat: "unknown" }])(
    "rejects incorrectly typed affinity controls: %j", async compat => {
      expect(validateBindRequest(bind({ ...await managed(), compat } as PiBindModel))).toBe(false);
    },
  );
});
