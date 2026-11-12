import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { withManagedAiProbe } from "../services/ai-connection-runtime.js";
import { agentEnvironmentTestService } from "../services/agent-environment-test.js";

const accounts = vi.hoisted(() => ({ select: vi.fn(), credential: vi.fn(), markAuthenticationFailed: vi.fn() }));
vi.mock("../services/ai-connections.js", async original => ({ ...await original<object>(), aiConnectionService: () => ({
  select: accounts.select, runtimeCredential: accounts.credential, markAuthenticationFailed: accounts.markAuthenticationFailed,
}) }));
afterEach(() => { vi.clearAllMocks(); });
import { requireServerAdapter } from "../adapters/index.js";
import { assertHarnessTestPassed } from "../services/agent-harness-verification.js";

// Keep: the 1b double-prime fresh-agent incident fell through to OpenCode.
// Real registry -> setup -> runnerd -> Pi RPC -> controlled loopback model.
// Opt in with qualified runner/provider-pack artifacts; no product gate is bypassed.
const enabled = process.env.PAPERCLIP_PI_SETUP_E2E === "1";
it.skipIf(!enabled).each([
  [200, "pi_rpc_hello_probe_passed", null],
  [401, "pi_rpc_hello_probe_auth_required", "harness_auth_failed"],
  [404, "pi_rpc_hello_probe_model_unavailable", "harness_model_unavailable"],
] as const)("native Pi setup really prompts and classifies HTTP %s", async (status, check, failure) => {
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH) throw new Error("Qualified runner and Pi provider-pack artifacts are required");
  const root = await mkdtemp(join(tmpdir(), "native-pi-setup-e2e-"));
  const agent = join(root, "agent"); await mkdir(agent);
  const requests: Array<Record<string, unknown>> = [];
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: status === 401 ? "Authentication required" : "Model unavailable", type: status === 401 ? "authentication_error" : "model_not_found" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [{ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]) {
        res.write(`data: ${JSON.stringify({ id: "pi-setup-hello", object: "chat.completion.chunk", ...chunk })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  try {
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("No model listener");
    const result = await requireServerAdapter("paperclip_runner").testEnvironment({ companyId: "pi-setup-proof", adapterType: "paperclip_runner",
      config: { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off", env: {
        PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TMPDIR: process.env.TMPDIR!,
        PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none",
      } } });
    console.log("native Pi setup proof", JSON.stringify({ status, result, requests: requests.length }));
    expect(requests.length).toBeGreaterThan(0);
    expect(result.checks[0].code).toBe(check);
    if (failure) expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: failure }));
    else expect(() => assertHarnessTestPassed(result)).not.toThrow();
  } finally {
    peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// Keep: rung-3 production hires inherit an all-agents managed AI connection.
// Real managed credential projection -> environment service -> registry -> Pi;
// only the saved account/secret store is faked, not the native probe or model call.
it.skipIf(!enabled).each([
  [200, "pi_rpc_hello_probe_passed", null],
  [401, "pi_rpc_hello_probe_auth_required", "harness_auth_failed"],
  [404, "pi_rpc_hello_probe_model_unavailable", "harness_model_unavailable"],
] as const)("managed native Pi setup really uses its connection and classifies HTTP %s", async (status, check, failure) => {
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH) throw new Error("Qualified runner and Pi provider-pack artifacts are required");
  const root = await mkdtemp(join(tmpdir(), "managed-native-pi-setup-e2e-"));
  const agent = join(root, "agent"); await mkdir(agent);
  const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: status === 401 ? "Authentication required" : "Model unavailable", type: status === 401 ? "authentication_error" : "not_found_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "message_start", message: { id: "managed-pi-hello", type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  try {
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("No model listener");
    const credential = "managed-pi-connection-key";
    const ref = { configPath: "ai.credential", secretId: "managed-pi-secret", versionSelector: "latest" };
    const grant = { id: "managed-pi-grant", status: "active", subjectUserId: null, credentialSecretRefs: [ref] };
    const binding = { provider: "anthropic", method: "api_key", mode: "shared", connectionId: "managed-pi-connection", grantId: grant.id } as const;
    accounts.select.mockResolvedValue({ grant, connection: { id: binding.connectionId, name: "All agents gateway", config: { ai: {
      provider: "anthropic", method: "api_key", routing: { kind: "local", protocol: "messages", auth: "bearer", baseUrl: `http://127.0.0.1:${address.port}`, models: [{ id: "faux" }] },
    } } }, attribution: { connectionId: binding.connectionId, grantId: grant.id, provider: "anthropic", method: "api_key", mode: "shared" } });
    accounts.credential.mockResolvedValue(credential);
    const db = { select: (fields: Record<string, unknown>) => {
      const rows = "refs" in fields ? [{ refs: [ref], status: "active" }] : [{ epoch: 1, version: 1 }];
      const query = { from: () => query, where: () => query, limit: async () => rows,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) };
      return query;
    } } as unknown as Db;
    const service = agentEnvironmentTestService(db);
    const input = { companyId: "managed-pi-setup-proof", agentId: "managed-pi-agent", responsibleUserId: null,
      adapterType: "paperclip_runner", binding, config: { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off", cwd: root,
        env: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TMPDIR: process.env.TMPDIR!, ANTHROPIC_API_KEY: "stale-account-must-not-be-used" } } };
    const result = await withManagedAiProbe(db, input, managed => service.testManagedEnvironment("paperclip_runner",
      { companyId: input.companyId, adapterType: input.adapterType, config: managed.config }, binding, managed, input.agentId));
    console.log("managed native Pi setup proof", JSON.stringify({ status, result, requests: requests.length }));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.url === "/v1/messages?beta=true" && request.authorization === `Bearer ${credential}` && request.body.model === "faux")).toBe(true);
    expect(result.checks[0].code).toBe(check);
    expect(accounts.markAuthenticationFailed).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain("stale-account-must-not-be-used");
    if (failure) expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: failure }));
    else expect(() => assertHarnessTestPassed(result)).not.toThrow();
  } finally {
    peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
