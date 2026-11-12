import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
