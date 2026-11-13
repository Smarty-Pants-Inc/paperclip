import { createSign } from "node:crypto";
import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { G12Config } from "./config.js";
import { G12ErrorCode as Code } from "./errors.js";

export interface PullRequest {
  number: number;
  draft: boolean;
  user: { login: string } | null;
  head: { sha: string };
  base: { repo: { id: number } };
}
export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { id: number };
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
    throw new Error(Code.AppSignFailed);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function malformed(): never { throw new Error(Code.GitHubResponseInvalid); }
export class ScanPaused extends Error {
  constructor() { super(Code.ScanPaused); }
}
const httpErrors: Readonly<Record<number, Code>> = {
  401: Code.GitHubHttp401, 403: Code.GitHubHttp403, 404: Code.GitHubHttp404,
  422: Code.GitHubHttp422, 500: Code.GitHubHttp500,
};

/** Host-managed HTTP, fixed GitHub origin, no provider Link URLs or retry loops. */
export class GitHub {
  private gets = 0;
  private readonly startedAt = Date.now();
  retryAt = 0;
  constructor(
    private readonly http: PluginHttpClient,
    private readonly deadline: number,
    private readonly maxGets = 200,
    private readonly now = Date.now(),
  ) {}

  private rateBackoff(response: Response): void {
    const now = this.now + Math.max(0, Date.now() - this.startedAt);
    const retry = response.headers.get("retry-after");
    let until = 0;
    if (retry !== null) {
      const seconds = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : NaN;
      until = Number.isFinite(seconds) ? now + Math.max(1, seconds) * 1000 : Date.parse(retry);
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      until = Math.max(Number.isFinite(until) ? until : 0, reset > now ? reset : now + 300_000);
    }
    if (response.status === 429 && !(until > now)) until = now + 300_000;
    if (Number.isSafeInteger(until) && until > now) this.retryAt = Math.max(this.retryAt, until);
  }

  async request(path: string, token: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash) {
      throw new Error(Code.HttpOriginDenied);
    }
    if (Date.now() >= this.deadline || this.retryAt > this.now || (method === "GET" && this.gets >= this.maxGets)) {
      throw new ScanPaused();
    }
    if (method === "GET") this.gets++;
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
    } catch { throw new Error(Code.GitHubTransportFailed); }
    this.rateBackoff(response);
    // Consume successful data even at remaining=0, but pause before any next GET.
    if (!response.ok) {
      if (this.retryAt > this.now) throw new ScanPaused();
      throw new Error(httpErrors[response.status] ?? Code.GitHubHttpFailed);
    }
    try { return await response.json(); } catch { return malformed(); }
  }

  async installationToken(config: G12Config, jwt: string): Promise<string> {
    // Also fail closed for callers that did not use parseConfig. Never mint an
    // unrestricted token, even for disabled/legacy/malformed configuration.
    if (!Array.isArray(config.repos) || config.repos.length === 0) throw new Error(Code.ConfigRepos);
    const body = {
      permissions: { checks: "read", pull_requests: "read" },
      repositories: [...new Set(config.repos.map((repo) => repo.split("/")[1]))],
    };
    const result = await this.request(`/app/installations/${config.installationId}/access_tokens`, jwt, "POST", body);
    if (!object(result) || typeof result.token !== "string" || !result.token) return malformed();
    return result.token;
  }

  private async page(path: string, token: string, page: number, field?: string): Promise<unknown[]> {
    const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
    const values = field ? (object(result) ? result[field] : null) : result;
    if (!Array.isArray(values) || values.length > 100) return malformed();
    return values;
  }

  async pullsPage(repo: string, token: string, page: number): Promise<PullRequest[]> {
    const values = await this.page(`/repos/${repo}/pulls?state=open&sort=created&direction=asc`, token, page);
    return values.map((value) => {
      if (!object(value) || !id(value.number) || typeof value.draft !== "boolean" || !object(value.head) ||
          typeof value.head.sha !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(value.head.sha) ||
          !object(value.base) || !object(value.base.repo) || !id(value.base.repo.id) ||
          (value.user !== null && (!object(value.user) || typeof value.user.login !== "string"))) return malformed();
      // Do not retain provider objects (titles, bodies, URLs, etc.).
      return { number: value.number, draft: value.draft, head: { sha: value.head.sha },
        user: value.user === null ? null : { login: String((value.user as Record<string, unknown>).login) },
        base: { repo: { id: value.base.repo.id } } };
    });
  }

  async checksPage(repo: string, head: string, token: string, page: number): Promise<CheckRun[]> {
    // latest excludes superseded attempts. Still require exact head in backstop.
    const values = await this.page(`/repos/${repo}/commits/${head}/check-runs?filter=latest`, token, page, "check_runs");
    return values.map((value) => {
      if (!object(value) || !id(value.id) || typeof value.name !== "string" || typeof value.head_sha !== "string" ||
          typeof value.status !== "string" || (value.conclusion !== null && typeof value.conclusion !== "string") ||
          !object(value.app) || !id(value.app.id)) return malformed();
      return { id: value.id, name: value.name, head_sha: value.head_sha, status: value.status,
        conclusion: value.conclusion, app: { id: value.app.id } };
    });
  }
}
