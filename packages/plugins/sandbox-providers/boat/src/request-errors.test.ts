// Keep: credential trust boundary and failure paths unsafe to induce live.
// Every key, body, statusText and nested cause is a synthetic noncredential.
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
const id = "bx_23456789";
const canary = "synthetic-request-canary";
const params = { driverKey: "boat", companyId: "co", environmentId: "env", providerLeaseId: id, config: { apiKey: canary } };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function failure(response: () => Promise<Response>, apiKey = canary) {
  vi.stubGlobal("fetch", vi.fn(response));
  try { await plugin.definition.onEnvironmentInspectLease!({ ...params, config: { apiKey } }); }
  catch (error) { return error as Error & { httpStatus: number | null; category: string }; }
  throw new Error("Expected request to fail");
}
function assertSafe(error: Error, key = canary) {
  expect(error).toBeInstanceOf(Error);
  for (const value of [String(error), error.message, error.stack, JSON.stringify(Object.getOwnPropertyDescriptors(error))]) {
    expect(value?.includes(key)).toBe(false);
  }
  expect(Object.hasOwn(error, "cause")).toBe(false);
}
describe("central safe request errors", () => {
  it.each(["message", "nested", "statusText"])('drops provider %s and retains status', async source => {
    const error = await failure(async () => new Response(source === "statusText" ? null : JSON.stringify(source === "message" ? { message: canary } : { error: { message: canary } }), { status: 503, statusText: source === "statusText" ? canary : "fixture" }));
    assertSafe(error);
    expect(error).toMatchObject({ httpStatus: 503, category: "http_error" });
    expect(error.message).toBe(`Boat GET /sandboxes/${id} failed (503): http_error`);
  });
  it("drops network message, nested causes and stack", async () => {
    const original = new Error(canary, { cause: new Error(canary) });
    original.stack = canary;
    const error = await failure(async () => { throw original; });
    assertSafe(error);
    expect(error).toMatchObject({ httpStatus: null, category: "network_error" });
  });
  it.each(["x", canary])("drops parse previews even for short keys", async key => {
    const error = await failure(async () => new Response(`${key} invalid JSON`), key);
    assertSafe(error, key);
    expect(error).toMatchObject({ httpStatus: 200, category: "parse_error" });
  });
  it.each(["{", JSON.stringify({ message: canary }), JSON.stringify({ error: { details: { path: canary } } })])("drops ambiguous 404 diagnostics", async body => {
    const error = await failure(async () => new Response(body, { status: 404 }));
    assertSafe(error);
    expect(error).toMatchObject({ httpStatus: 404, category: "ambiguous_404" });
  });
  it("redacts a configured key colliding with the safe path", async () => {
    const error = await failure(async () => new Response(null, { status: 401 }), id);
    assertSafe(error, id);
    expect(error.message).toContain("/sandboxes/[REDACTED]");
  });
  it("redacts a configured key colliding with the constructed stack", async () => {
    const error = await failure(async () => { throw new Error(canary); }, "plugin.ts");
    assertSafe(error, "plugin.ts");
  });
  it("retains safe failures without an empty-key replacement", async () => {
    const error = await failure(async () => new Response(null, { status: 403 }), "");
    expect(error.message).toBe(`Boat GET /sandboxes/${id} failed (403): http_error`);
    expect(error.httpStatus).toBe(403);
  });
  it("rejects required null JSON via the same boundary", async () => {
    const error = await failure(async () => new Response("null"));
    assertSafe(error);
    expect(error).toMatchObject({ httpStatus: 200, category: "parse_error" });
  });
});
