import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { parseConfig, SAFE_ERROR } from "../src/config.js";
import { runTick } from "../src/intake.js";

// Import the REAL host conversion/Ajv path, not a local replica. Dynamic URL
// keeps package-only tsc from pulling server sources beyond rootDir.
const validatorPath = new URL("../../../../server/src/services/plugin-config-validator.ts", import.meta.url).pathname;
const { validateInstanceConfig } = await import(/* @vite-ignore */ validatorPath);
const raw = {
  enabled: true, mailbox: "smarty@smartypants.ai", routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333", version: 1 },
};
// Keep: recorded PROD config-save incident (2026-11-13); actual secret-binding
// trust boundary. Offline check exercises the same host validator as the route.
describe("host config / worker secret-ref boundary", () => {
  it("accepts picker bindings through the actual host conversion without mutating persisted config", () => {
    const original = structuredClone(raw);
    expect(validateInstanceConfig(raw, manifest.instanceConfigSchema)).toEqual({ valid: true });
    expect(raw).toEqual(original);
    expect(parseConfig(raw).gmailGrantRef).toEqual(original.gmailGrantRef);
    expect(parseConfig(raw).routineFireSecretRef).toEqual(original.routineFireSecretRef);
  });
  it("reproduces the old object-schema rejection as a negative control", () => {
    const schema = structuredClone(manifest.instanceConfigSchema!);
    for (const name of ["gmailGrantRef", "routineFireSecretRef"]) {
      (schema.properties as Record<string, unknown>)[name] = { type: "object", format: "secret-ref" };
    }
    expect(validateInstanceConfig(raw, schema)).toMatchObject({ valid: false,
      errors: [{ field: "/gmailGrantRef", message: "must be object" }, { field: "/routineFireSecretRef", message: "must be object" }] });
  });
  it.each(["gmailGrantRef", "routineFireSecretRef"])("rejects malformed or raw runtime refs at %s", name => {
    for (const value of [raw.gmailGrantRef.secretId, { type: "secret_ref", secretId: "bad" },
      { ...raw.gmailGrantRef, version: 0 }, { ...raw.gmailGrantRef, extra: "no" }]) {
      expect(() => parseConfig({ ...raw, [name]: value })).toThrow(SAFE_ERROR);
    }
    expect(validateInstanceConfig({ ...raw, [name]: { type: "secret_ref", secretId: "bad" } }, manifest.instanceConfigSchema).valid).toBe(false);
  });
  it("passes stored refs unchanged to ctx.secrets.resolve with exact binding/company paths", async () => {
    const config = parseConfig(raw), calls: unknown[] = [];
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    let state: unknown = { version: 2, seen: [], failures: [] };
    const ctx = {
      logger: { warn: () => {} },
      state: { get: async () => state, set: async (_key: unknown, value: unknown) => { state = value; } },
      secrets: { resolve: async (ref: unknown, options: unknown) => {
        calls.push({ ref, options });
        return calls.length === 1 ? JSON.stringify({ client_id: "fake", client_secret: "fake", refresh_token: "fake" }) : "fake";
      } },
      http: { fetch: async (url: string) => {
        if (url.includes("oauth2.googleapis.com")) return json({ access_token: "fake", token_type: "Bearer" });
        if (url.endsWith("/fire")) return json({}, 202);
        const u = new URL(url);
        if (u.pathname.endsWith("/messages")) return json({ messages: [{ id: "aa", threadId: "bb" }] });
        return json({ id: "aa", threadId: "bb", internalDate: String(Date.now()) });
      } },
    };
    await runTick(ctx, "test-company", config);
    expect(calls).toEqual([
      { ref: raw.gmailGrantRef, options: { companyId: "test-company", configPath: "gmailGrantRef" } },
      { ref: raw.routineFireSecretRef, options: { companyId: "test-company", configPath: "routineFireSecretRef" } },
    ]);
  });
});
