import { createSign } from "node:crypto";
import type { ManagerKeySource } from "./manager-key-source.js";
import { SafeFailure } from "./errors.js";

export type SafeGitHubResponse = { status: number; data: unknown };
export type GitHubFetch = typeof fetch;

export interface ManagerAppConfig {
  managerAppId: string;
  managerInstallationId: string;
  managerKeyAnchorProjectId: string;
  enterpriseSlug: string;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function signManagerAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const issuedAt = nowSeconds - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKeyPem, "base64url")}`;
}

export class GitHubApi {
  private readonly baseUrl: string;
  private readonly fetcher: GitHubFetch;

  constructor(
    private readonly keys: ManagerKeySource,
    options: { baseUrl?: string; fetcher?: GitHubFetch } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async withInstallationToken<T>(config: ManagerAppConfig, companyId: string, work: (token: string) => Promise<T>): Promise<T> {
    let privateKeyPem: string;
    try {
      privateKeyPem = await this.keys.read(companyId, config.managerKeyAnchorProjectId);
    } catch (error) {
      if (error instanceof SafeFailure) throw error;
      throw new SafeFailure("Manager key unavailable; GitHub request was not made.");
    }

    let jwt: string;
    try {
      jwt = signManagerAppJwt(config.managerAppId, privateKeyPem);
    } catch {
      throw new SafeFailure("Manager key unavailable; GitHub request was not made.");
    }

    const response = await this.request("POST", `/app/installations/${config.managerInstallationId}/access_tokens`, jwt);
    const token = isRecord(response.data) && typeof response.data.token === "string" ? response.data.token : "";
    if (!token) throw new SafeFailure(`GitHub request failed with HTTP ${response.status}.`, response.status);
    return work(token);
  }

  async request(method: string, path: string, bearer: string, body?: unknown): Promise<SafeGitHubResponse> {
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod === "DELETE") throw new SafeFailure("DELETE is reserved for GitHub App unsuspension.");
    if (!["GET", "POST", "PATCH", "PUT"].includes(normalizedMethod)) throw new SafeFailure("Unsupported GitHub request method.");
    return this.send(normalizedMethod, path, bearer, body);
  }

  async suspendInstallation(installationId: string, appJwt: string): Promise<SafeGitHubResponse> {
    return this.request("PUT", `/app/installations/${installationId}/suspended`, appJwt);
  }

  async unsuspendInstallation(installationId: string, appJwt: string): Promise<SafeGitHubResponse> {
    return this.send("DELETE", `/app/installations/${installationId}/suspended`, appJwt);
  }

  private async send(method: string, path: string, bearer: string, body?: unknown): Promise<SafeGitHubResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SafeFailure("GitHub request failed before a response was received.");
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      if (response.ok && response.status !== 204) throw new SafeFailure(`GitHub request failed with HTTP ${response.status}.`, response.status);
    }
    if (!response.ok) throw new GitHubHttpFailure(response.status);
    return { status: response.status, data };
  }
}

export class GitHubHttpFailure extends SafeFailure {
  constructor(status: number) {
    super(`GitHub request failed with HTTP ${status}.`, status);
    this.name = "GitHubHttpFailure";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
