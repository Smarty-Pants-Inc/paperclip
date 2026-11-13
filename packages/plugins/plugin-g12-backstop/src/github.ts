import { createSign } from "node:crypto";
import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { G12Config } from "./config.js";

export interface PullRequest {
  number: number;
  draft: boolean;
  user: { login: string } | null;
  head: { sha: string };
}
export interface CheckRun {
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { id: number } | null;
}

export function signAppJwt(appId: number, privateKey: string, now: number): string {
  try {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const seconds = Math.floor(now / 1000);
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) })).toString("base64url");
    const input = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input);
    return `${input}.${signer.sign(privateKey, "base64url")}`;
  } catch {
    // Crypto errors must not copy PEM data or provider error text into job logs.
    throw new Error("G12_APP_SIGN_FAILED");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function malformed(): never { throw new Error("G12_GITHUB_RESPONSE_INVALID"); }

/** Only host-managed HTTP, only a fixed GitHub origin. Never follow provider Link URLs. */
export class GitHub {
  private requests = 0;
  constructor(private readonly http: PluginHttpClient, private readonly deadline: number) {}

  async request(path: string, token: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) {
      throw new Error("G12_HTTP_ORIGIN_DENIED");
    }
    // Leave room beneath the host's five-minute job timeout. Per-request timeout
    // and redirect rejection remain with the host HTTP service.
    if (Date.now() >= this.deadline || ++this.requests > 5000) throw new Error("G12_SCAN_BUDGET_EXCEEDED");
    let response: Response;
    try {
      response = await this.http.fetch(url.href, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "paperclip-g12-backstop/0.1.0",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new Error("G12_GITHUB_TRANSPORT_FAILED"); }
    // Never log response bodies, token values, request headers or PR text.
    if (!response.ok) throw new Error(`G12_GITHUB_HTTP_${response.status}`);
    try { return await response.json(); } catch { return malformed(); }
  }

  async installationToken(config: G12Config, jwt: string): Promise<string> {
    const body = {
      permissions: { checks: "read", pull_requests: "read" },
      ...(config.repos === "all" ? {} : { repositories: [...new Set(config.repos.map((repo) => repo.split("/")[1]))] }),
    };
    const result = await this.request(`/app/installations/${config.installationId}/access_tokens`, jwt, "POST", body);
    if (!object(result) || typeof result.token !== "string" || !result.token) return malformed();
    return result.token;
  }

  private async *pages(path: string, token: string, field?: string): AsyncGenerator<unknown[]> {
    for (let page = 1; ; page++) {
      const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
      const values = field ? (object(result) ? result[field] : null) : result;
      if (!Array.isArray(values) || values.length > 100) return malformed();
      yield values;
      // GitHub REST supports numeric page/per_page for all three endpoints.
      // An exactly full last page causes one harmless empty-page read.
      if (values.length < 100) return;
    }
  }

  async repositories(token: string): Promise<string[]> {
    const repos = new Set<string>();
    for await (const page of this.pages("/installation/repositories", token, "repositories")) {
      for (const value of page) {
        if (!object(value) || typeof value.full_name !== "string" || !/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(value.full_name)) return malformed();
        repos.add(value.full_name.toLowerCase());
      }
    }
    return [...repos];
  }

  async *pulls(repo: string, token: string): AsyncGenerator<PullRequest> {
    for await (const page of this.pages(`/repos/${repo}/pulls?state=open&sort=created&direction=asc`, token)) {
      for (const value of page) {
        if (!object(value) || !Number.isSafeInteger(value.number) || Number(value.number) < 1 ||
            typeof value.draft !== "boolean" || !object(value.head) ||
            typeof value.head.sha !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(value.head.sha) ||
            (value.user !== null && (!object(value.user) || typeof value.user.login !== "string"))) return malformed();
        yield value as unknown as PullRequest;
      }
    }
  }

  async checks(repo: string, head: string, token: string): Promise<CheckRun[]> {
    const checks: CheckRun[] = [];
    // latest excludes superseded attempts: an earlier failed rerun must not
    // wake after its replacement succeeds. Results still require exact head.
    for await (const page of this.pages(`/repos/${repo}/commits/${head}/check-runs?filter=latest`, token, "check_runs")) {
      for (const value of page) {
        if (!object(value) || typeof value.name !== "string" || typeof value.head_sha !== "string" ||
            typeof value.status !== "string" || (value.conclusion !== null && typeof value.conclusion !== "string") ||
            (value.app !== null && (!object(value.app) || !Number.isSafeInteger(value.app.id)))) return malformed();
        checks.push(value as unknown as CheckRun);
      }
    }
    return checks;
  }
}
