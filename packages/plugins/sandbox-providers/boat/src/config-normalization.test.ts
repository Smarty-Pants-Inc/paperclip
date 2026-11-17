import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

// Keep: retained-conversation data safety. Injecting defaults into a saved
// environment changes its lease fingerprint on an unrelated edit.
const apiKey = "fixture-config-key";
const validate = (config: Record<string, unknown>) => plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config });

describe("Boat storage config normalization", () => {
  it.each([
    { apiKey },
    { apiKey, snapshot: "daily-work" },
    { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} },
    { apiKey, runLeaseRenewCapSeconds: 250 },
    { apiKey, hostMetadata: { keep: "unchanged" } },
  ])("preserves the caller's exact config and key set across repeated saves: %j", async input => {
    const before = JSON.stringify(input);
    const result = await validate(Object.freeze(input));
    expect(result).toEqual({ ok: true, normalizedConfig: input });
    expect(Object.keys(result.normalizedConfig!)).toEqual(Object.keys(input));
    expect(JSON.stringify(result.normalizedConfig)).toBe(before);
    expect(JSON.stringify(input)).toBe(before);
    expect(await validate(result.normalizedConfig!)).toEqual(result);
  });

  it.each([
    { provider: "boat" },
    { duplexCarrier: "off" },
    { reuseLease: false },
    { runnerLifecycleMode: "inherit" },
    { runnerIdleTimeoutMs: 300000 },
    { retainOnDestroy: true },
    { type: "small" },
    { ttlSeconds: 1800 },
    { runLeaseRenewCapSeconds: 86400 },
    { setupTimeoutSeconds: 180 },
    { labels: {} },
  ])("keeps explicitly supplied defaults without materializing omitted keys: %j", async given => {
    const input = { apiKey, ...given };
    expect(await validate(input)).toEqual({ ok: true, normalizedConfig: input });
  });

  it("retains existing canonicalization only for supplied values", async () => {
    const input = { apiKey: `  ${apiKey}  `, ttlSeconds: "300", setupTimeoutSeconds: "60",
      runnerIdleTimeoutMs: "600000", retainOnDestroy: false, duplexCarrier: "ssh", runLeaseRenewCapSeconds: 250 };
    const expected = { ...input, apiKey, ttlSeconds: 300, setupTimeoutSeconds: 60, runnerIdleTimeoutMs: 600000, retainOnDestroy: true };
    const result = await validate(input);
    expect(result).toEqual({ ok: true, normalizedConfig: expected });
    expect(Object.keys(result.normalizedConfig!)).toEqual(Object.keys(input));
    expect(input.retainOnDestroy).toBe(false);
  });
});
