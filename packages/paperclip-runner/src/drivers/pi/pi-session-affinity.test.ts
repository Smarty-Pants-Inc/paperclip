// Keep: gateway routing must use Pi's persisted identity, never prompt-prefix matching.
// Agreed offline request-boundary test: real Pi 1.5.2 client, no provider traffic.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateBindRequest, type PiBindModel } from "./pi-bind-protocol.js";
import { buildPiManagedModel } from "./pi-managed-model.js";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";

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
  // KEEP: exercise the actual managed driver -> native Pi -> broker -> upstream
  // on every protocol. Client-only captures missed rf-2's stripped routing header.
  it.each(["messages", "chat", "responses"] as const)("delivers native Pi's session id through the %s broker", async protocol => {
    const root = await mkdtemp(join(tmpdir(), "pi-affinity-wire-")); roots.push(root);
    const home = join(root, "home"), agent = join(home, "agent"), workspace = join(root, "workspace");
    await mkdir(agent, { recursive: true }); await mkdir(workspace);
    const requests: Array<{ path?: string; headers: IncomingHttpHeaders; body: unknown }> = [];
    const peer = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type: string, fields: Record<string, unknown> = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      if (protocol === "messages") {
        emit("message_start", { message: { id: "local", type: "message", role: "assistant", model: "affinity-proof", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
        emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        emit("message_stop");
      } else if (protocol === "responses") {
        const base = { id: "resp_local", object: "response", created_at: 1, model: "affinity-proof", status: "in_progress", output: [], error: null, incomplete_details: null };
        const item = { type: "message", id: "msg_local", role: "assistant", content: [], status: "in_progress" };
        const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
        emit("response.created", { response: base });
        emit("response.output_item.added", { output_index: 0, item });
        emit("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part });
        emit("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: "ok", logprobs: [] });
        emit("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: "ok", logprobs: [] });
        const finalItem = { ...item, status: "completed", content: [{ ...part, text: "ok" }] };
        emit("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: "ok" } });
        emit("response.output_item.done", { output_index: 0, item: finalItem });
        emit("response.completed", { response: { ...base, status: "completed", output: [finalItem], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      } else {
        for (const chunk of [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]) {
          res.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", ...chunk })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
      }
      res.end();
    });
    await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("No offline listener");
    let session: PiRpcHarnessSession | undefined;
    const proof: Record<string, unknown> = { protocol, requests };
    try {
      session = await new PiRpcDriver({ command: join(runnerRoot, "node_modules/.bin/pi"), model: "paperclip/affinity-proof", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"),
        environment: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}${protocol === "messages" ? "" : "/v1"}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol, PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      }).openSession({ runId: "offline-wire", normalizedSessionId: "private-envelope", workingDirectory: workspace }) as PiRpcHarnessSession;
      proof.ids = session.ids(); proof.pid = session.processPid();
      const iterator = session.events()[Symbol.asyncIterator]();
      await session.startTurn({ message: { role: "user", text: "Reply ok." } });
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("Native events ended before completion");
        if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
        if (next.value.eventType === "turn.completed") { proof.terminal = next.value.eventType; break; }
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]!.path).toBe(protocol === "messages" ? "/v1/messages?beta=true" : protocol === "chat" ? "/v1/chat/completions" : "/v1/responses");
      expect(requests[0]!.headers["x-session-id"]).toBe(session.ids().providerSessionId);
      // Responses already uses Pi's identity as protocol cache metadata, not
      // model-visible content. Preserve that native behavior without adding it
      // to the prompt; Messages/Chat have no such field.
      const { prompt_cache_key, ...promptBody } = requests[0]!.body as Record<string, unknown>;
      if (protocol === "responses") expect(prompt_cache_key).toBe(session.ids().providerSessionId);
      expect(JSON.stringify(promptBody)).not.toContain(session.ids().providerSessionId);
    } finally {
      await session?.close(); proof.exited = session?.processExited();
      peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()));
      if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `affinity-wire-${protocol}.json`), JSON.stringify(proof, null, 2));
    }
  }, 60_000);
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
