import type { Db } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { secretService } from "../secrets.js";
import { resolveExecutionRunAdapterConfig } from "./run-preparation.js";

type Input = Parameters<typeof resolveExecutionRunAdapterConfig>[0];
const agentId = "11111111-1111-4111-8111-111111111111";
const langfuseEnv = { LANGFUSE_BASE_URL: { type: "plain", value: "https://langfuse.example.test" } };
const lowTrust: Input["trustPreset"] = {
  kind: "low_trust_review", preset: LOW_TRUST_REVIEW_PRESET,
  boundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: "company-one", issueIds: ["issue-one"], allowedSecretBindingIds: [] },
  sourcePresets: {},
};

function prepare(overrides: Partial<Input> = {}) {
  // Real binding normalization/resolution; these plain bindings need no DB or credentials.
  const db = { select: () => { throw new Error("Unexpected database access for plain env"); } } as unknown as Db;
  return resolveExecutionRunAdapterConfig({
    companyId: "company-one", agentId, issueId: "issue-one", adapterType: "paperclip_runner",
    environmentId: "environment-one", environmentEnv: langfuseEnv,
    executionRunConfig: { provider: "pi_rpc", env: {} }, projectEnv: null,
    secretsSvc: secretService(db), ...overrides,
  });
}

// Keep reason: recorded #20833 attribution failure, plus the low-trust boundary.
// Assert the environment consumed by both dispatch paths, not source text or calls.
describe("Langfuse run user identity", () => {
  it.each([
    { adapterType: "pi_local", environmentDriver: "local" },
    { adapterType: "paperclip_runner", environmentDriver: "local" },
    { adapterType: "paperclip_runner", environmentDriver: "sandbox" },
  ])("defaults environment-only Langfuse to the agent id: $adapterType / $environmentDriver", async input => {
    const result = await prepare(input);
    expect(result.resolvedConfig.env).toEqual({ LANGFUSE_BASE_URL: langfuseEnv.LANGFUSE_BASE_URL.value, LANGFUSE_USER_ID: agentId });
    expect(result.configuredTaskEnvironment.LANGFUSE_USER_ID).toBe(agentId);
    expect(result.secretKeys.has("LANGFUSE_USER_ID")).toBe(false);
    expect(result.secretManifest).toEqual([]);
  });

  it.each(["environment", "agent", "project", "routine", "projection"] as const)("preserves an explicit user id from %s", async scope => {
    const explicit = { LANGFUSE_USER_ID: "explicit-user" };
    const result = await prepare({
      ...(scope === "environment" ? { environmentEnv: { ...langfuseEnv, ...explicit } } : {}),
      ...(scope === "agent" ? { executionRunConfig: { provider: "pi_rpc", env: explicit } } : {}),
      ...(scope === "project" ? { projectId: "project-one", projectEnv: explicit } : {}),
      ...(scope === "routine" ? { routineId: "routine-one", routineEnv: explicit } : {}),
      ...(scope === "projection" ? { trustedEnvProjection: explicit } : {}),
    });
    expect(result.resolvedConfig.env).toMatchObject(explicit);
    expect(result.configuredTaskEnvironment.LANGFUSE_USER_ID).toBe("explicit-user");
  });

  it("does not add Langfuse to a run with no Langfuse variables", async () => {
    const result = await prepare({ environmentEnv: { OTHER_VALUE: "kept" } });
    expect(result.resolvedConfig.env).toEqual({ OTHER_VALUE: "kept" });
    expect(result.configuredTaskEnvironment).not.toHaveProperty("LANGFUSE_USER_ID");
  });

  it.each(["agent", "project", "routine"] as const)("detects Langfuse supplied only by %s env", async scope => {
    const result = await prepare({
      environmentEnv: null,
      ...(scope === "agent" ? { executionRunConfig: { provider: "pi_rpc", env: langfuseEnv } } : {}),
      ...(scope === "project" ? { projectId: "project-one", projectEnv: langfuseEnv } : {}),
      ...(scope === "routine" ? { routineId: "routine-one", routineEnv: langfuseEnv } : {}),
    });
    expect(result.configuredTaskEnvironment.LANGFUSE_USER_ID).toBe(agentId);
  });

  it("sets a non-secret user id for low_trust_review without a boundary error", async () => {
    const result = await prepare({ trustPreset: lowTrust, environmentDriver: "sandbox" });
    expect(result.configuredTaskEnvironment.LANGFUSE_USER_ID).toBe(agentId);
    expect(result.secretKeys.has("LANGFUSE_USER_ID")).toBe(false);
    // The same id is accepted as a plain binding by the actual inline-sensitive check.
    const explicit = await prepare({ trustPreset: lowTrust, executionRunConfig: { env: { LANGFUSE_USER_ID: agentId } } });
    expect(explicit.configuredTaskEnvironment.LANGFUSE_USER_ID).toBe(agentId);
  });

  it("still rejects inline Langfuse credentials across a low-trust boundary", async () => {
    await expect(prepare({ trustPreset: lowTrust, environmentEnv: { LANGFUSE_SECRET_KEY: "inline-secret" } })).rejects.toMatchObject({
      status: 422, details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  it("does not invent an identity when no run agent id is available", async () => {
    const result = await prepare({ agentId: undefined });
    expect(result.configuredTaskEnvironment).not.toHaveProperty("LANGFUSE_USER_ID");
  });
});
