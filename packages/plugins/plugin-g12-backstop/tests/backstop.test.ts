import { generateKeyPairSync, verify } from "node:crypto";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { definePlugin, startWorkerRpcHost, type PluginContext, type PluginJobContext, type ScopeKey } from "@paperclipai/plugin-sdk";
import { runTick } from "../src/backstop.js";
import { parseConfig } from "../src/config.js";
import { GitHub, type CheckRun, type PullRequest } from "../src/github.js";
import manifest from "../src/manifest.js";
import { createG12Definition } from "../src/plugin.js";

// Synthetic ephemeral fixture key only. No environment, credential store or live HTTP.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const company = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const issue = "00000000-0000-4000-8000-000000000003";
const secret = "00000000-0000-4000-8000-000000000004";
const otherCompany = "00000000-0000-4000-8000-000000000005";
const A = "a".repeat(40), B = "b".repeat(40);
const T = 1_800_000_000_000;
const rawConfig = () => ({
  enabled: true, companyId: company, appId: 42, installationId: 73,
  privateKeyRef: { type: "secret_ref", secretId: secret },
  repos: ["Org/Repo"], owners: { Alice: { agentId: agent, issueId: issue } },
});
function pr(number = 1, sha = A): PullRequest {
  return { number, draft: false, user: { login: "ALICE" }, head: { sha } };
}
function check(overrides: Partial<CheckRun> = {}): CheckRun {
  return { name: "Paperclip Review", head_sha: A, status: "completed", conclusion: "success", app: { id: 42 }, ...overrides };
}
function stateId(key: ScopeKey) { return JSON.stringify(key); }
function fake(store = new Map<string, unknown>()) {
  const pulls = new Map<string, PullRequest[]>([["org/repo", [pr()]]]);
  const checks = new Map<string, CheckRun[]>([[`org/repo:${A}`, []]]);
  const repositories = ["org/repo"];
  const requests: { url: URL; init: RequestInit }[] = [];
  const wakes: { issueId: string; companyId: string; opts: Record<string, string> }[] = [];
  const logs: unknown[] = [];
  const secretReads: unknown[] = [];
  const jwtPayloads: Record<string, unknown>[] = [];
  let config: Record<string, unknown> = rawConfig();
  let wakeMode: "ok" | "throw-after-effect" | "refused" = "ok";
  let status = 200;
  let configGate: Promise<void> | undefined;
  const registered = new Map<string, (job: PluginJobContext) => Promise<void>>();
  const http = {
    fetch: vi.fn(async (urlString: string, init: RequestInit = {}) => {
      const url = new URL(urlString);
      expect(url.origin).toBe("https://api.github.com");
      requests.push({ url, init });
      if (status !== 200) return new Response("sensitive provider response", { status });
      const headers = new Headers(init.headers);
      expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      if (url.pathname === "/app/installations/73/access_tokens") {
        expect(init.method).toBe("POST");
        const jwt = headers.get("authorization")!.slice("Bearer ".length);
        const [header, payload, signature] = jwt.split(".");
        expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        jwtPayloads.push(JSON.parse(Buffer.from(payload, "base64url").toString()));
        expect(JSON.parse(init.body as string).permissions).toEqual({ checks: "read", pull_requests: "read" });
        return Response.json({ token: "synthetic-installation-token", expires_at: "2099-01-01T00:00:00Z" });
      }
      expect(headers.get("authorization")).toBe("Bearer synthetic-installation-token");
      expect(init.method).toBe("GET");
      const page = Number(url.searchParams.get("page"));
      expect(url.searchParams.get("per_page")).toBe("100");
      const slice = <V>(rows: V[]) => rows.slice((page - 1) * 100, page * 100);
      if (url.pathname === "/installation/repositories") return Response.json({ repositories: slice(repositories.map((full_name) => ({ full_name }))) });
      const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(pulls|commits\/([^/]+)\/check-runs)$/);
      if (!match) throw new Error(`Unexpected fake GitHub path ${url.pathname}`);
      if (match[2] === "pulls") {
        expect(url.searchParams.get("state")).toBe("open");
        return Response.json(slice(pulls.get(match[1]) ?? []));
      }
      expect(url.searchParams.get("filter")).toBe("latest");
      return Response.json({ check_runs: slice(checks.get(`${match[1]}:${match[3]}`) ?? []) });
    }),
  };
  const state = {
    get: vi.fn(async (key: ScopeKey) => {
      expect(key.scopeKind).toBe("company"); expect(key.scopeId).toBe(company); expect(key.namespace).toBe("g12-v1");
      return structuredClone(store.get(stateId(key)) ?? null);
    }),
    set: vi.fn(async (key: ScopeKey, value: unknown) => { store.set(stateId(key), structuredClone(value)); }),
  };
  const ctx = {
    http, state,
    config: { get: vi.fn(async (companyId: string) => { expect(companyId).toBe(company); await configGate; return config; }) },
    secrets: { resolve: vi.fn(async (ref: unknown, options: unknown) => { secretReads.push({ ref, options }); return pem; }) },
    issues: { requestWakeup: vi.fn(async (issueId: string, companyId: string, opts: Record<string, string>) => {
      expect(issueId).toBe(issue); expect(companyId).toBe(company);
      if (wakeMode === "refused") return { queued: false, runId: null };
      wakes.push({ issueId, companyId, opts });
      if (wakeMode === "throw-after-effect") throw new Error("synthetic-installation-token");
      return { queued: true, runId: "synthetic-run" };
    }) },
    logger: { info: (message: string, counts: unknown) => { expect(message).toBe("G12 tick counts"); logs.push(counts); } },
    jobs: { register: (key: string, handler: (job: PluginJobContext) => Promise<void>) => { registered.set(key, handler); } },
  } as unknown as PluginContext;
  return {
    ctx, store, pulls, checks, repositories, requests, wakes, logs, secretReads, jwtPayloads, registered,
    setStatus: (value: number) => { status = value; },
    setWakeMode: (value: typeof wakeMode) => { wakeMode = value; },
    setConfig: (value: Record<string, unknown>) => { config = value; },
    setConfigGate: (value: Promise<void>) => { configGate = value; },
    tick: (now = T) => runTick(ctx, parseConfig(config), now),
  };
}
const job: PluginJobContext = { jobKey: "g12-backstop", runId: "test-run", trigger: "schedule", scheduledAt: new Date(T).toISOString() };

describe("G12 code-only backstop", () => {
  it("declares exactly one five-minute code job and the six allowed capabilities", () => {
    expect(manifest.capabilities).toEqual(["jobs.schedule", "http.outbound", "secrets.read-ref", "plugin.state.read", "plugin.state.write", "issues.wakeup"]);
    expect(manifest.jobs).toEqual([expect.objectContaining({ jobKey: "g12-backstop", schedule: "*/5 * * * *" })]);
    expect(manifest.entrypoints).toEqual({ worker: "./dist/worker.js" });
  });

  it("signs a verifiable App JWT, requests a read-only repo-scoped installation token and resolves just the bound ref", async () => {
    const f = fake(); await f.tick();
    expect(f.jwtPayloads).toEqual([{ iss: "42", iat: T / 1000 - 60, exp: T / 1000 + 540 }]);
    expect(JSON.parse(f.requests[0].init.body as string).repositories).toEqual(["repo"]);
    expect(f.secretReads).toEqual([{ ref: { type: "secret_ref", secretId: secret }, options: { companyId: company, configPath: "privateKeyRef" } }]);
    expect(JSON.stringify([...f.store.values()])).not.toContain("synthetic-installation-token");
    expect(JSON.stringify(f.logs)).not.toContain("PRIVATE KEY");
  });

  it("waits M minutes from first eligibility, wakes the owner once, and dedupes across a recreated worker", async () => {
    const f = fake();
    await f.tick(T); await f.tick(T + 15 * 60_000 - 1);
    expect(f.wakes).toHaveLength(0);
    expect((await f.tick(T + 15 * 60_000)).wakes).toBe(1);
    expect(f.wakes[0]).toEqual({ issueId: issue, companyId: company, opts: {
      reason: `g12:missing:org/repo:1:${A}`, contextSource: "smarty.g12-backstop", idempotencyKey: `g12:missing:org/repo:1:${A}`,
    } });
    expect((await f.tick(T + 20 * 60_000)).deduped).toBe(1);
    const restarted = fake(f.store);
    expect((await restarted.tick(T + 25 * 60_000)).deduped).toBe(1);
    expect(restarted.wakes).toHaveLength(0); expect(f.wakes).toHaveLength(1);
  });

  it("a new head has a fresh missing-review timer; returning to an old head does not repeat its wake", async () => {
    const f = fake(); await f.tick(); await f.tick(T + 900_000);
    f.pulls.set("org/repo", [pr(1, B)]);
    await f.tick(T + 1_000_000); expect(f.wakes).toHaveLength(1);
    await f.tick(T + 1_900_000); expect(f.wakes).toHaveLength(2);
    expect(f.wakes[1].opts.idempotencyKey).toBe(`g12:missing:org/repo:1:${B}`);
    f.pulls.set("org/repo", [pr()]); await f.tick(T + 2_000_000);
    expect(f.wakes).toHaveLength(2);
  });

  it("only the configured App's Paperclip Review on this head satisfies missing review", async () => {
    const f = fake();
    f.checks.set(`org/repo:${A}`, [check({ app: { id: 99 } }), check({ head_sha: B }), check({ name: "Other" })]);
    await f.tick(); await f.tick(T + 900_000); expect(f.wakes).toHaveLength(1);
    const healthy = fake();
    healthy.checks.set(`org/repo:${A}`, [check({ status: "in_progress", conclusion: null })]);
    await healthy.tick(); await healthy.tick(T + 99_000_000); expect(healthy.wakes).toHaveLength(0);
  });

  it("wakes once per completed failure/timed_out key, never cancelled, stale, pending or successful checks", async () => {
    const f = fake();
    f.checks.set(`org/repo:${A}`, [check(), check({ name: "CI", app: { id: 99 }, conclusion: "failure" }),
      check({ name: "Slow CI", conclusion: "timed_out" }), check({ name: "Cancelled", conclusion: "cancelled" }),
      check({ name: "Pending", status: "in_progress", conclusion: "failure" }), check({ name: "Old", head_sha: B, conclusion: "failure" }),
      check({ name: "Neutral", conclusion: "neutral" }), check({ name: "Action", conclusion: "action_required" }),
      check({ name: "CI", app: { id: 99 }, conclusion: "failure" })]);
    expect((await f.tick()).wakes).toBe(2);
    expect(f.wakes.map((wake) => wake.opts.idempotencyKey)).toEqual([`g12:fail:org/repo:1:${A}:CI:failure`, `g12:fail:org/repo:1:${A}:Slow CI:timed_out`]);
    expect((await f.tick(T + 900_000)).deduped).toBe(2); expect(f.wakes).toHaveLength(2);
    f.pulls.set("org/repo", [pr(1, B)]);
    f.checks.set(`org/repo:${B}`, [check({ head_sha: B, name: "CI", conclusion: "failure" })]);
    await f.tick(); expect(f.wakes.at(-1)!.opts.idempotencyKey).toBe(`g12:fail:org/repo:1:${B}:CI:failure`);
  });

  it("has no agent/model call on empty or healthy ticks and logs only numeric counts", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check()]);
    await f.tick(); await f.tick(T + 900_000); f.pulls.clear(); await f.tick(T + 1_800_000);
    expect(f.wakes).toHaveLength(0);
    expect(f.logs).toHaveLength(3);
    expect(f.logs.every((counts) => Object.values(counts as object).every((value) => typeof value === "number"))).toBe(true);
    // ctx deliberately contains no agents, sessions or routines service.
  });

  it("paginates installation repositories, open PRs and check runs past page one", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), repos: "all" });
    f.repositories.splice(0, 1, ...Array.from({ length: 100 }, (_, n) => `org/empty${n}`), "org/repo");
    f.pulls.set("org/repo", [...Array.from({ length: 100 }, (_, n) => ({ ...pr(n + 1), draft: true })), pr(101)]);
    f.checks.set(`org/repo:${A}`, [...Array.from({ length: 100 }, (_, n) => check({ name: n === 0 ? "Paperclip Review" : `CI${n}` })), check({ name: "Last-page CI", conclusion: "failure" })]);
    const counts = await f.tick();
    expect(counts).toMatchObject({ repos: 101, prs: 101, eligible: 1, checks: 101, wakes: 1 });
    expect(f.wakes[0].opts.idempotencyKey).toBe(`g12:fail:org/repo:101:${A}:Last-page CI:failure`);
    for (const suffix of ["/installation/repositories", "/pulls", "/check-runs"]) {
      expect(f.requests.some(({ url }) => url.pathname.endsWith(suffix) && url.searchParams.get("page") === "2")).toBe(true);
    }
  });

  it("skips draft/unmapped/deleted authors; first eligibility begins only when ready and mapped", async () => {
    const f = fake();
    f.pulls.set("org/repo", [{ ...pr(), draft: true }, { ...pr(2), user: { login: "unknown" } }, { ...pr(3), user: null }]);
    expect(await f.tick()).toMatchObject({ eligible: 0, drafts: 1, unmapped: 2 }); expect(f.store.size).toBe(0);
    f.pulls.set("org/repo", [pr()]); await f.tick(T + 900_000); expect(f.wakes).toHaveLength(0);
    await f.tick(T + 1_800_000); expect(f.wakes).toHaveLength(1);
  });

  it("fails closed on unreadable check runs instead of treating a GitHub error as missing review", async () => {
    const f = fake(); await f.tick();
    const original = f.ctx.http.fetch;
    f.ctx.http.fetch = async (url, init) => url.includes("check-runs") ? new Response("sensitive provider response", { status: 403 }) : original(url, init);
    await expect(f.tick(T + 900_000)).rejects.toThrow("G12_GITHUB_HTTP_403"); expect(f.wakes).toHaveLength(0);
    f.ctx.http.fetch = original; await f.tick(T + 1_000_000); expect(f.wakes).toHaveLength(1);
  });

  it("does not retry an ambiguous accepted wake, even though the fake receiver has NO idempotency fence", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("throw-after-effect");
    await expect(f.tick()).rejects.toThrow("G12_WAKE_UNCERTAIN_RECONCILE_RECEIPT"); expect(f.wakes).toHaveLength(1);
    f.setWakeMode("ok"); await expect(f.tick()).rejects.toThrow("G12_WAKE_UNRESOLVED_RECONCILE_RECEIPT");
    expect(f.wakes).toHaveLength(1); expect([...f.store.values()]).toContainEqual(expect.objectContaining({ outcome: "uncertain", agentId: agent }));
    expect(JSON.stringify(f.logs)).not.toContain("synthetic-installation-token");
  });

  it("reserves before send: a crash saving the final receipt cannot duplicate the accepted wake", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    const set = f.ctx.state.set;
    f.ctx.state.set = async (key, value) => {
      if ((value as { outcome?: string }).outcome === "queued") throw new Error("simulated crash");
      await set(key, value);
    };
    await expect(f.tick()).rejects.toThrow("G12_TICK_FAILED"); expect(f.wakes).toHaveLength(1);
    f.ctx.state.set = set;
    await expect(f.tick()).rejects.toThrow("G12_WAKE_UNRESOLVED_RECONCILE_RECEIPT"); expect(f.wakes).toHaveLength(1);
  });

  it("never wakes if reserving state fails, and surfaces a refused admission without automatic repeat", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    const set = f.ctx.state.set;
    f.ctx.state.set = async (key, value) => {
      if (key.stateKey.startsWith("wake:")) throw new Error("storage unavailable"); await set(key, value);
    };
    await expect(f.tick()).rejects.toThrow("G12_TICK_FAILED"); expect(f.wakes).toHaveLength(0);
    f.ctx.state.set = set; f.setWakeMode("refused");
    await expect(f.tick()).rejects.toThrow("G12_WAKE_REFUSED_RECONCILE_RECEIPT");
    await expect(f.tick()).rejects.toThrow("G12_WAKE_UNRESOLVED_RECONCILE_RECEIPT");
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("keeps an unconfigured/disabled worker completely quiet, including no secret or HTTP access", async () => {
    const f = fake(); const definition = createG12Definition(); await definition.setup(f.ctx);
    await f.registered.get("g12-backstop")!(job); expect(f.requests).toHaveLength(0);
    f.setConfig({ ...rawConfig(), enabled: false }); await f.tick();
    expect(f.secretReads).toHaveLength(0); expect(f.store.size).toBe(0); expect(f.wakes).toHaveLength(0);
  });

  it("wires setup/configChanged/runJob using company config, rejects mismatched tenant and concurrent jobs", async () => {
    const f = fake(); const definition = createG12Definition(); await definition.setup(f.ctx);
    await definition.onConfigChanged!(rawConfig(), { companyId: company });
    expect([...f.registered.keys()]).toEqual(["g12-backstop"]);
    let release!: () => void;
    f.setConfigGate(new Promise<void>((resolve) => { release = resolve; }));
    const running = f.registered.get("g12-backstop")!(job);
    try { await expect(f.registered.get("g12-backstop")!(job)).rejects.toThrow("G12_JOB_ALREADY_RUNNING"); }
    finally { release(); await running; }
    expect(f.ctx.config.get).toHaveBeenCalledWith(company);
    await expect(definition.onConfigChanged!({ ...rawConfig(), companyId: otherCompany }, { companyId: otherCompany })).rejects.toThrow("G12_COMPANY_BINDING_MISMATCH");
    await expect(f.registered.get("g12-backstop")!(job)).rejects.toThrow("G12_COMPANY_BINDING_MISMATCH");
  });

  it("rejects inline keys, extra refs, unsafe paths, conflicting owners and invalid config; defaults to 15 minutes", async () => {
    expect(parseConfig(rawConfig()).missingReviewMinutes).toBe(15);
    for (const patch of [
      { privateKeyRef: pem }, { privateKeyRef: { type: "secret_ref", secretId: secret, extra: "no" } },
      { anotherRef: { type: "secret_ref", secretId: secret } }, { repos: ["org/../repo"] },
      { repos: ["../repo"] }, { repos: ["org/.."] }, { repos: ["./repo"] }, { repos: ["org/."] },
      { repos: ["org/repo", "ORG/REPO"] }, { missingReviewMinutes: 0 }, { appId: "42" },
      { owners: { Alice: { agentId: agent, issueId: issue }, ALICE: { agentId: agent, issueId: issue } } },
      { owners: { Alice: { agentId: agent, issueId: issue }, Bob: { agentId: otherCompany, issueId: issue } } },
    ]) expect(() => parseConfig({ ...rawConfig(), ...patch })).toThrow(/^G12_CONFIG_/);
    const definition = createG12Definition();
    expect(await definition.onValidateConfig!({ ...rawConfig(), privateKeyRef: pem })).toMatchObject({ ok: false });
    expect(await definition.onValidateConfig!(rawConfig())).toEqual({ ok: true });
    await expect(definition.onConfigChanged!(rawConfig(), { companyId: otherCompany })).rejects.toThrow("G12_COMPANY_BINDING_MISMATCH");
  });

  it("round-trips setup/configChanged/runJob and both wake kinds through the real shipped SDK JSON-RPC transport", async () => {
    const f = fake();
    const input = new PassThrough(), output = new PassThrough();
    const lines = createInterface({ input: output });
    const rpc = startWorkerRpcHost({ plugin: definePlugin(createG12Definition()), stdin: input, stdout: output, rpcTimeoutMs: 2000 });
    let id = 0;
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const methods: string[] = [];
    const failures: Error[] = [];
    const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
    async function handle(message: Record<string, any>) {
      if (!message.method) {
        const waiter = pending.get(message.id);
        if (!waiter) throw new Error("Unknown RPC response");
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
        return;
      }
      const p = message.params;
      methods.push(message.method);
      if (message.method === "log") { f.ctx.logger.info(p.message, p.meta); return; }
      let result: unknown;
      switch (message.method) {
        case "config.get": result = await f.ctx.config.get(p.companyId); break;
        case "secrets.resolve": result = await f.ctx.secrets.resolve(p.secretRef, { companyId: p.companyId, configPath: p.configPath }); break;
        case "state.get": result = await f.ctx.state.get(p); break;
        case "state.set": { const { value, ...key } = p; await f.ctx.state.set(key as ScopeKey, value); result = null; break; }
        case "http.fetch": {
          const response = await f.ctx.http.fetch(p.url, p.init);
          result = { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: await response.text() };
          break;
        }
        case "issues.requestWakeup": result = await f.ctx.issues.requestWakeup(p.issueId, p.companyId, p); break;
        default: throw new Error(`Unexpected host service ${message.method}`);
      }
      send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    }
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      void handle(message).catch((error) => {
        failures.push(error);
        if (message.method && message.id) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Fake host assertion failed" } });
      });
    });
    function call(method: string, params: unknown) {
      const requestId = `host-${++id}`;
      const result = new Promise<unknown>((resolve, reject) => pending.set(requestId, { resolve, reject }));
      send({ jsonrpc: "2.0", id: requestId, method, params });
      return result;
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(T);
    try {
      await expect(call("initialize", { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: company, hostVersion: "test" } })).resolves.toMatchObject({ ok: true });
      await call("runJob", { job }); expect(f.requests).toHaveLength(0);
      await call("configChanged", { companyId: company, config: rawConfig() });
      await call("runJob", { job }); expect(f.wakes).toHaveLength(0);
      clock.mockReturnValue(T + 900_000);
      await call("runJob", { job }); expect(f.wakes).toHaveLength(1);
      await call("runJob", { job }); expect(f.wakes).toHaveLength(1);
      f.checks.set(`org/repo:${A}`, [check(), check({ name: "Real RPC CI", conclusion: "timed_out" })]);
      await call("runJob", { job }); await call("runJob", { job });
      expect(f.wakes.map((wake) => wake.opts.idempotencyKey)).toEqual([
        `g12:missing:org/repo:1:${A}`, `g12:fail:org/repo:1:${A}:Real RPC CI:timed_out`,
      ]);
      expect(new Set(methods)).toEqual(new Set(["log", "config.get", "secrets.resolve", "state.get", "state.set", "http.fetch", "issues.requestWakeup"]));
      expect(failures).toEqual([]); expect(pending.size).toBe(0);
    } finally {
      clock.mockRestore(); rpc.stop(); lines.close(); input.destroy(); output.destroy();
    }
    expect(rpc.running).toBe(false);
  });

  it("rejects off-origin requests and redacts secret/signing/provider errors", async () => {
    const f = fake(); const github = new GitHub(f.ctx.http, Date.now() + 60_000);
    await expect(github.request("https://example.com/steal", "synthetic-token")).rejects.toThrow("G12_HTTP_ORIGIN_DENIED");
    expect(f.requests).toHaveLength(0);
    f.ctx.secrets.resolve = async () => { throw new Error("PRIVATE KEY sensitive provider error"); };
    await expect(f.tick()).rejects.toThrow(/^G12_TICK_FAILED$/); expect(f.requests).toHaveLength(0);
    f.ctx.secrets.resolve = async () => "not a PEM: PRIVATE KEY sensitive";
    await expect(f.tick()).rejects.toThrow(/^G12_APP_SIGN_FAILED$/);
  });
});
