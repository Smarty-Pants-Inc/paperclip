import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Keep: real Runner setup 413 regression, byte safety, and signed-URL trust boundary.
// All HTTP is intercepted; unexpected requests fail instead of reaching Boat.
const API = "https://boat.dev/api/v1/sandboxes/bx_test";
const signedUrl = "https://sandbox.invalid/upload?signature=fixture-secret";
const threshold = 4_194_304;
const params = { driverKey: "boat", companyId: "c", environmentId: "e", config: { apiKey: "boat_test" },
  lease: { providerLeaseId: "bx_test" }, command: "sh", args: ["-s"], timeoutMs: 5000 };
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function fixture(stdin: string, failure?: "http" | "network" | "url") {
  const bytes = Buffer.from(stdin, "utf8");
  const files = new Map<string, Buffer>();
  const events: string[] = [];
  let path = "", command = "", inlineBody: string | undefined;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `${API}/files` && init.method === "PUT") {
      events.push("inline"); inlineBody = String(init.body);
      const data = JSON.parse(inlineBody); path = data.path;
      expect(data.encoding).toBe("utf8");
      const uploaded = Buffer.from(data.content, "utf8");
      expect(uploaded.equals(bytes)).toBe(true);
      if (uploaded.length > 5_242_880) return json({ message: "file_too_large" }, 413);
      files.set(path, uploaded); return json({ ok: true });
    }
    if (url === `${API}/files/upload-url` && init.method === "POST") {
      events.push("url");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer boat_test");
      const body = JSON.parse(String(init.body)); path = body.path;
      expect(body).toEqual({ path });
      if (failure === "url") return json({ message: "upload URL unavailable" }, 503);
      return json({ ok: true, type: "file.upload_url", url: signedUrl, method: "PUT", path, expiresAt: "2030-01-01T00:00:00Z" });
    }
    if (url === signedUrl && init.method === "PUT") {
      events.push("signed");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      const uploaded = Buffer.from(await new Response(init.body).arrayBuffer());
      expect(uploaded.length).toBe(bytes.length);
      expect(uploaded.equals(bytes)).toBe(true);
      if (failure === "network") { files.set(path, uploaded); throw new Error("fixture connection lost"); }
      if (failure === "http") { files.set(path, uploaded); return new Response("upload denied", { status: 403 }); }
      files.set(path, uploaded); return new Response(null, { status: 204 });
    }
    if (url === `${API}/commands` && init.method === "POST") {
      events.push("command"); command = JSON.parse(String(init.body)).command;
      expect(command).toBe(`exec 'sh' '-s' < '${path}'`);
      expect(files.get(path)?.equals(bytes)).toBe(true);
      return json({ exitCode: 0, stdout: `consumed ${bytes.length} bytes`, stderr: "" });
    }
    if (url === `${API}/files?path=${encodeURIComponent(path)}` && init.method === "DELETE") {
      events.push("cleanup"); files.delete(path); return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { files, events, fetch, get path() { return path; }, get inlineBody() { return inlineBody; } };
}
afterEach(() => vi.unstubAllGlobals());
describe("Runner stdin staging", () => {
  for (const [name, stdin, signed] of [
    ["0 B", "", false],
    ["4 MiB exactly", "x".repeat(threshold), false],
    ["4 MiB + 1 B", "x".repeat(threshold + 1), true],
    ["60 MB", "0123456789".repeat(6_000_000), true],
    ["4 MiB UTF-8 exactly", "é".repeat(threshold / 2), false],
    ["4 MiB + 1 UTF-8 bytes (fewer characters)", "é".repeat(threshold / 2) + "x", true],
  ] as const) {
    it(`${name}: preserves bytes, route, redirection and cleanup`, async () => {
      const f = fixture(stdin);
      expect(await plugin.definition.onEnvironmentExecute!({ ...params, stdin })).toMatchObject({
        exitCode: 0, timedOut: false, stdout: `consumed ${Buffer.byteLength(stdin, "utf8")} bytes`,
      });
      expect(f.path).toMatch(/^\/tmp\/paperclip-stdin-[a-f0-9-]+$/);
      expect(f.events).toEqual(signed ? ["url", "signed", "command", "cleanup"] : ["inline", "command", "cleanup"]);
      expect(f.files.size).toBe(0);
      if (!signed) expect(f.inlineBody).toBe(JSON.stringify({ path: f.path, content: stdin, encoding: "utf8" }));
      else expect(f.inlineBody).toBeUndefined();
    });
  }
  for (const failure of ["http", "network", "url"] as const) {
    it(`${failure} upload failure: refuses execution and cleans the same temp path`, async () => {
      const stdin = "x".repeat(threshold + 1), f = fixture(stdin, failure);
      await expect(plugin.definition.onEnvironmentExecute!({ ...params, stdin })).rejects.toThrow(
        failure === "http" ? "Boat stdin upload failed (403)" : failure === "network" ? "fixture connection lost" : "upload URL unavailable",
      );
      expect(f.events).toEqual(failure === "url" ? ["url", "cleanup"] : ["url", "signed", "cleanup"]);
      expect(f.files.size).toBe(0);
      expect(f.inlineBody).toBeUndefined();
    });
  }
});
