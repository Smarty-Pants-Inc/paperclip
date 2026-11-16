import { vi } from "vitest";

/** HTTP-only GitHub fixture for genuine H-session approval setup. Install this
 * module before production client imports: JWT signing, token scope checks,
 * vault reads and the approval writer itself are never replaced. */
vi.hoisted(() => {
  let sequence = 0;
  const scopes = new Map<string, string[]>();
  const nativeFetch = globalThis.fetch;
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") return nativeFetch(input, init);
    const path = url.pathname;
    if (path === "/app") {
      // J07 uses this second spelling of the SAME provider registration. Model
      // that exact Client ID at HTTP, not by bypassing provider verification.
      const jwt = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /i, "");
      const issuer = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).iss : undefined;
      return Response.json({ id: 123, slug: "project-fixture",
        client_id: issuer === "Iv1ProjectClient1234" ? issuer : "Iv1syntheticclient" });
    }
    if (/^\/app\/installations\/\d+$/.test(path)) return Response.json({ id: Number(path.split("/").at(-1)), app_id: 123,
      suspended_at: null, account: { login: "owner" }, permissions: { contents: "write", pull_requests: "write", issues: "read" } });
    if (path.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body)) as { repositories: string[] };
      if (!body.repositories?.length || body.repositories.some(repo => !["a", "b"].includes(repo.toLowerCase()))) throw new Error("Unexpected approval repository subset");
      const token = `synthetic-approval-http-token-${++sequence}`;
      scopes.set(token, body.repositories);
      return Response.json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path.startsWith("/users/")) return Response.json({ id: 123, login: "project-fixture[bot]", type: "Bot" });
    if (path === "/installation/repositories") {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
      const repos = token ? scopes.get(token) : undefined;
      if (!repos) throw new Error("Approval installation token was not minted by HTTP");
      return Response.json({ repositories: repos.map(name => ({ id: name.toLowerCase() === "a" ? 101 : 202, full_name: `owner/${name}`, private: true })) });
    }
    throw new Error(`Unexpected approval provider path: ${path}`);
  });
  vi.stubGlobal("fetch", http);
  return http;
});
