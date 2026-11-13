import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import { runTick } from "../src/backstop.js";
import { parseConfig } from "../src/config.js";
import { G12ErrorCode } from "../src/errors.js";

const company = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const issue = "00000000-0000-4000-8000-000000000003";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const sentinel = "G12_PRIVATE_SENTINEL_PEM_JWT_TOKEN";
const sha = "a".repeat(40);

// Keep reason: secret-handling trust boundary, reproducing PR #23's RFL matrix.
// No real key, account, credential store or network is used.
describe("G12 secret redaction through provider/host failure paths", () => {
  it.each(["ok", "mint-401", "mint-403", "mint-500", "checks-401", "checks-403", "checks-500", "network", "bad-pem", "secret-error", "wake-error"])("keeps secrets out of logs, state, wake arguments and errors: %s", async (mode) => {
    const state = new Map<string, unknown>();
    const logs: unknown[] = [], wakes: unknown[] = [], credentials: string[] = [pem, sentinel];
    const config = parseConfig({ enabled: true, companyId: company, appId: 42, installationId: 73,
      privateKeyRef: { type: "secret_ref", secretId: company }, repos: ["org/repo"],
      owners: { alice: { agentId: agent, issueId: issue } } });
    const host = {
      http: { fetch: async (url: string, init: RequestInit) => {
        const token = new Headers(init.headers).get("authorization")!.slice(7);
        credentials.push(token);
        if (mode === "network") throw new Error(sentinel);
        const mint = url.includes("access_tokens");
        if (mode.startsWith(mint ? "mint-" : "checks-") && (mint || url.includes("check-runs"))) {
          return new Response(sentinel, { status: Number(mode.split("-")[1]) });
        }
        if (mint) return Response.json({ token: sentinel });
        if (url.includes("/pulls")) return Response.json([{ number: 1, draft: false, user: { login: "alice" },
          head: { sha }, base: { repo: { id: 123 } }, title: sentinel, body: sentinel }]);
        return Response.json({ check_runs: [{ id: 456, name: sentinel, head_sha: sha,
          status: "completed", conclusion: "failure", app: { id: 42 } }] });
      } },
      secrets: { resolve: async () => {
        if (mode === "secret-error") throw new Error(sentinel);
        return mode === "bad-pem" ? sentinel : pem;
      } },
      state: {
        get: async (key: ScopeKey) => state.get(JSON.stringify(key)) ?? null,
        set: async (key: ScopeKey, value: unknown) => { state.set(JSON.stringify(key), structuredClone(value)); },
      },
      issues: {
        get: async () => ({ id: issue, companyId: company, assigneeAgentId: agent }),
        requestWakeup: async (...args: unknown[]) => {
          wakes.push(args); if (mode === "wake-error") throw new Error(sentinel);
          return { queued: true, runId: company };
        },
      },
      logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    } as unknown as PluginContext;
    let errorMessage = "";
    try { await runTick(host, config); }
    catch (error) { errorMessage = (error as Error).message; }
    if (mode === "ok") expect(errorMessage).toBe("");
    else expect(Object.values(G12ErrorCode)).toContain(errorMessage);
    const output = JSON.stringify({ state: [...state.entries()], logs, wakes, errorMessage });
    for (const credential of credentials) expect(output).not.toContain(credential);
    if (mode !== "ok" && mode !== "wake-error") expect(wakes).toHaveLength(0);
  });
});
