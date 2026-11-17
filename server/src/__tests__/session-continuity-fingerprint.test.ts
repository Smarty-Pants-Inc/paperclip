import { describe, expect, it } from "vitest";
import { resolveHeartbeatNativeLifecyclePolicy } from "../services/heartbeat/native-lifecycle.js";
import { buildEffectiveRunSessionConfigMetadata } from "../services/heartbeat/workspaces.js";

// smarty-dev#20853: a key-only agent or environment save must not reset a task
// session; a genuine identity change still must. Lifecycle timing and record
// bookkeeping (revision ids, row timestamps) are not session identity.
type Input = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];

function base(): Input {
  return {
    adapterType: "paperclip_runner",
    effectiveAdapterConfig: { provider: "pi", model: "model-a", lifecycleMode: "warm", idleTimeoutMs: 28_800_000 },
    agentRuntimeConfig: {},
    issueOverrides: null,
    workspaceConfig: { requestedMode: null, effectiveMode: null },
    environment: {
      selectionSource: "agent_default",
      selectedEnvironmentId: "11111111-1111-4111-8111-111111111111",
      selectedEnvironment: {
        id: "11111111-1111-4111-8111-111111111111",
        driver: "sandbox",
        config: { provider: "e2b", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 28_800_000,
          ttlSeconds: 3_600, runnerReconnectGraceMs: 30_000 },
        configRevisionAt: "2026-11-16T05:00:00.000Z",
      },
      executionPolicy: null,
    },
    environmentEnv: { TZ: "UTC" },
    projectEnv: null,
    routineEnv: null,
    secretManifest: [{
      configPath: "env.API_KEY", envKey: "API_KEY", secretId: "22222222-2222-4222-8222-222222222222",
      bindingId: "33333333-3333-4333-8333-333333333333", version: 1, provider: "local_encrypted",
      providerVersionRef: null, outcome: "success",
    }] as Input["secretManifest"],
    runtimeSkills: [],
    agentConfigRevision: { id: "44444444-4444-4444-8444-444444444444", changedKeys: ["adapterConfig"], configRevisionAt: "2026-11-16T05:00:00.000Z" },
  };
}

const fingerprint = async (input: Input) => (await buildEffectiveRunSessionConfigMetadata(input)).fingerprint;
function withEnvironmentConfig(patch: Record<string, unknown>, revisionAt?: string): Input {
  const input = base();
  const environment = input.environment as { selectedEnvironment: { config: Record<string, unknown>; configRevisionAt: string } };
  environment.selectedEnvironment.config = { ...environment.selectedEnvironment.config, ...patch };
  if (revisionAt) environment.selectedEnvironment.configRevisionAt = revisionAt;
  return input;
}

describe("session config fingerprint: non-identity saves keep the session (#20853 PART 1)", () => {
  it("(superseded by replacement: upstream #21862 fingerprint includes idle-timeout, RFL record 03:56Z) (R1, a) an agent idleTimeoutMs-only change changes the fingerprint", async () => {
    const changed = base();
    changed.effectiveAdapterConfig = { ...changed.effectiveAdapterConfig, idleTimeoutMs: 300_000 };
    expect(await fingerprint(changed)).not.toBe(await fingerprint(base()));
  });

  it("(R2, b) a new config revision row (new id, time, changed keys) with the same content keeps the fingerprint", async () => {
    const changed = base();
    changed.agentConfigRevision = { id: "55555555-5555-4555-8555-555555555555", changedKeys: ["name"], configRevisionAt: "2026-11-16T06:00:00.000Z" };
    expect(await fingerprint(changed)).toBe(await fingerprint(base()));
  });

  it("(R5, e) an environment save that only advances updatedAt keeps the fingerprint", async () => {
    expect(await fingerprint(withEnvironmentConfig({}, "2026-11-16T06:28:00.000Z"))).toBe(await fingerprint(base()));
  });

  it("(superseded by replacement: upstream #21862 fingerprint includes idle-timeout, RFL record 03:56Z) (R5, f) environment lifecycle timing (runnerIdleTimeoutMs, ttlSeconds, runnerReconnectGraceMs) changes the fingerprint", async () => {
    for (const patch of [{ runnerIdleTimeoutMs: 300_000 }, { ttlSeconds: 7_200 }, { runnerReconnectGraceMs: 60_000 }]) {
      expect(await fingerprint(withEnvironmentConfig(patch, "2026-11-16T06:28:00.000Z"))).not.toBe(await fingerprint(base()));
    }
  });
});

describe("session config fingerprint: upgrade keeps saved sessions (#20853)", () => {
  // The fingerprint of base() computed by ae182f27 (before #20853). Sessions saved
  // under that shape must still match after the upgrade, or every saved
  // session would reset once at deploy (the very loss #20853 removes).
  const PRE_20853_FINGERPRINT = "v1:sha256:ad9a666abb4f8ca60dc7951e7b937321ed87a1d391cad2a8d84fb4276b74e5b7";
  it("the pre-#20853 shape of an unchanged config is still computed for compatibility", async () => {
    expect((await buildEffectiveRunSessionConfigMetadata({ ...base(), legacyComposition: true })).fingerprint)
      .toBe(PRE_20853_FINGERPRINT);
  });
});

describe("session config fingerprint: identity guards still reset (#20853 K3, R6)", () => {
  it("a model change resets", async () => {
    const changed = base();
    changed.effectiveAdapterConfig = { ...changed.effectiveAdapterConfig, model: "model-b" };
    expect(await fingerprint(changed)).not.toBe(await fingerprint(base()));
  });

  it("a provider change resets", async () => {
    const changed = base();
    changed.effectiveAdapterConfig = { ...changed.effectiveAdapterConfig, provider: "codex" };
    expect(await fingerprint(changed)).not.toBe(await fingerprint(base()));
  });

  it("a lifecycle MODE change resets (only timing is excluded)", async () => {
    const changed = base();
    changed.effectiveAdapterConfig = { ...changed.effectiveAdapterConfig, lifecycleMode: "per_turn" };
    expect(await fingerprint(changed)).not.toBe(await fingerprint(base()));
    expect(await fingerprint(withEnvironmentConfig({ runnerLifecycleMode: "per_turn" }))).not.toBe(await fingerprint(base()));
  });

  it("a secret VALUE change (new secret version) resets", async () => {
    const changed = base();
    changed.secretManifest = [{ ...changed.secretManifest![0]!, version: 2 }] as Input["secretManifest"];
    expect(await fingerprint(changed)).not.toBe(await fingerprint(base()));
  });

  it("(R6) an environment envVars value change resets; an environment provider change resets", async () => {
    const env = base();
    env.environmentEnv = { TZ: "America/Chicago" };
    expect(await fingerprint(env)).not.toBe(await fingerprint(base()));
    expect(await fingerprint(withEnvironmentConfig({ provider: "daytona" }))).not.toBe(await fingerprint(base()));
  });
});

describe("lifecycle policy order is unchanged (#20853 correction D)", () => {
  it("a session's persisted policy wins over the environment's and the agent's", () => {
    const persistedPolicy = { mode: "warm" as const, idleTimeoutMs: 123_000 };
    const policy = resolveHeartbeatNativeLifecyclePolicy({
      adapterType: "paperclip_runner", backend: "pi_rpc", agentMode: "warm", agentIdleTimeoutMs: 28_800_000,
      environmentPolicy: { mode: "warm", idleTimeoutMs: 300_000 }, persistedPolicy, managedAiSelected: false, taskOwned: false,
    });
    expect(policy).toEqual(persistedPolicy);
    expect(resolveHeartbeatNativeLifecyclePolicy({
      adapterType: "paperclip_runner", backend: "pi_rpc", agentMode: "warm", agentIdleTimeoutMs: 28_800_000,
      environmentPolicy: { mode: "warm", idleTimeoutMs: 300_000 }, managedAiSelected: false, taskOwned: false,
    })).toEqual({ mode: "warm", idleTimeoutMs: 300_000 });
  });
});
