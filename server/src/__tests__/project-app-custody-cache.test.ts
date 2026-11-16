import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as github from "../services/github-app-client.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = github.parseGitHubAppConfig({ appId: "123", installationId: "456", repositories: "owner/a", permissionProfile: "read" });

function boundary() {
  let now = Date.now();
  const http = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app") return Response.json({ id: 123, slug: "project-custody" });
    if (path === "/app/installations/456") return Response.json({ id: 456, app_id: 123, account: { login: "owner" }, permissions: { contents: "read", pull_requests: "read", issues: "read" } });
    if (path.endsWith("/access_tokens")) return Response.json({ token: "synthetic-project-token", expires_at: new Date(now + 3600_000).toISOString() });
    if (path.startsWith("/users/")) return Response.json({ id: 321, login: "project-custody[bot]", type: "Bot" });
    if (path === "/installation/repositories") return Response.json({ repositories: [{ id: 101, full_name: "owner/a" }] });
    throw new Error(`Unexpected HTTP path ${path}`);
  });
  return { http, clock: () => now, advance: (ms: number) => { now += ms; } };
}

describe("E2 custody provider cache invalidation contract", () => {
  it("is a real cache hit until but not including the 60-second bound", async () => {
    const b = boundary(); const client = github.createGitHubAppClient(b.http, b.clock, 60_000);
    await client.acquire("custody-test:company:connection:grant:version", config, key);
    const requests = b.http.mock.calls.length;
    b.advance(59_999); await client.acquire("custody-test:company:connection:grant:version", config, key);
    expect(b.http).toHaveBeenCalledTimes(requests);
    b.advance(1); await client.acquire("custody-test:company:connection:grant:version", config, key);
    expect(b.http.mock.calls.length).toBeGreaterThan(requests);
  });

  it("a revoke/signed-installation invalidation reaches independently constructed client caches", async () => {
    expect(typeof github.invalidateGitHubAppInstallation).toBe("function");
    const b = boundary(); const a = github.createGitHubAppClient(b.http, b.clock, 60_000); const c = github.createGitHubAppClient(b.http, b.clock, 60_000);
    await a.acquire("company:A", config, key); await c.acquire("company:B", config, key);
    const requests = b.http.mock.calls.length;
    github.invalidateGitHubAppInstallation("456");
    await a.acquire("company:A", config, key); await c.acquire("company:B", config, key);
    expect(b.http.mock.calls.length).toBe(requests * 2);
  });

  it("invalidation during provider I/O refuses BOTH the owner and a joined in-flight release", async () => {
    expect(typeof github.invalidateGitHubAppInstallation).toBe("function");
    const b = boundary(); const original = b.http.getMockImplementation()!;
    let reached!: () => void; let release!: () => void;
    const atProvider = new Promise<void>(done => { reached = done; });
    const gate = new Promise<void>(done => { release = done; });
    b.http.mockImplementation(async input => {
      if (new URL(String(input)).pathname === "/app/installations/456") { reached(); await gate; }
      return original(input);
    });
    const client = github.createGitHubAppClient(b.http, b.clock, 60_000);
    const first = client.acquire("company:joined", config, key);
    await atProvider;
    const joined = client.acquire("company:joined", config, key);
    const outcomes = Promise.allSettled([first, joined]);
    try { github.invalidateGitHubAppInstallation("456"); }
    finally { release(); }
    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { details: { code: "github_app_access_unavailable", reason: "installation" } } },
      { status: "rejected", reason: { details: { code: "github_app_access_unavailable", reason: "installation" } } },
    ]);
  });
});
