import { generateKeyPairSync, verify } from "node:crypto";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { definePlugin, startWorkerRpcHost, type PluginContext, type PluginJobContext, type ScopeKey } from "@paperclipai/plugin-sdk";
import { reconcileWake, runTick } from "../src/backstop.js";
import { parseConfig } from "../src/config.js";
import { GitHub, type CheckRun, type PullRequest } from "../src/github.js";
import manifest from "../src/manifest.js";
import { createG12Definition } from "../src/plugin.js";
import { errorCode, G12Error, G12ErrorCode as Code } from "../src/errors.js";

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
  return { number, draft: false, user: { login: "ALICE" }, head: { sha }, base: { repo: { id: 123 } } };
}
function check(overrides: Partial<CheckRun> = {}): CheckRun {
  return { id: 456, name: "Paperclip Review", head_sha: A, status: "completed", conclusion: "success", app: { id: 42 }, ...overrides };
}
function stateId(key: ScopeKey) { return JSON.stringify(key); }
function fake(store = new Map<string, unknown>()) {
  const pulls = new Map<string, PullRequest[]>([["org/repo", [pr()]]]);
  const checks = new Map<string, CheckRun[]>([[`org/repo:${A}`, []]]);
  const repositories = ["org/repo"];
  const requests: { url: URL; init: RequestInit }[] = [];
  const wakes: { issueId: string; companyId: string; opts: Record<string, string> }[] = [];
  const logs: unknown[] = [];
  const warnings: unknown[] = [];
  let assignee: string | null = agent;
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
    issues: {
      get: vi.fn(async (issueId: string, companyId: string) => {
        expect(issueId).toBe(issue); expect(companyId).toBe(company);
        return { id: issue, companyId: company, assigneeAgentId: assignee };
      }),
      requestWakeup: vi.fn(async (issueId: string, companyId: string, opts: Record<string, string>) => {
      expect(issueId).toBe(issue); expect(companyId).toBe(company);
      if (wakeMode === "refused") return { queued: false, runId: null };
      wakes.push({ issueId, companyId, opts });
      if (wakeMode === "throw-after-effect") throw new Error("synthetic-installation-token");
      return { queued: true, runId: "synthetic-run" };
    }) },
    logger: {
      info: (message: string, counts: unknown) => { expect(message).toBe("G12 tick counts"); logs.push(counts); },
      warn: (message: string, meta: unknown) => { warnings.push({ message, meta }); },
    },
    jobs: { register: (key: string, handler: (job: PluginJobContext) => Promise<void>) => { registered.set(key, handler); } },
  } as unknown as PluginContext;
  return {
    ctx, store, pulls, checks, repositories, requests, wakes, logs, warnings, secretReads, jwtPayloads, registered,
    setAssignee: (value: string | null) => { assignee = value; },
    setStatus: (value: number) => { status = value; },
    setWakeMode: (value: typeof wakeMode) => { wakeMode = value; },
    setConfig: (value: Record<string, unknown>) => { config = value; },
    setConfigGate: (value: Promise<void>) => { configGate = value; },
    tick: async (now = T) => runTick(ctx, parseConfig(config), now),
  };
}
const job: PluginJobContext = { jobKey: "g12-backstop", runId: "test-run", trigger: "schedule", scheduledAt: new Date(T).toISOString() };
function getCount(f: ReturnType<typeof fake>) { return f.requests.filter(({ init }) => init.method === "GET").length; }

describe("G12 fix-round-2 regressions", () => {
  // Keep reason: PR #23 RFL data-safety failures across admission/receipt/restart boundaries.
  // The fake host intentionally does NOT dedupe arbitrary idempotencyKey values:
  // the shipped queue persists g12:* keys but has no corresponding replay fence.
  it.each(["lost-response", "receipt-write-failed"])("F1a never repeats an accepted wake after %s and restart", async (mode) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    if (mode === "lost-response") f.setWakeMode("throw-after-effect");
    else {
      const set = f.ctx.state.set;
      f.ctx.state.set = async (key, value) => {
        if (key.stateKey.startsWith("wake:") && value && "acceptedAt" in (value as object)) throw new Error("write failed");
        await set(key, value);
      };
    }
    await expect(f.tick()).rejects.toThrow(mode === "lost-response" ? Code.WakeFailed : Code.TickFailed);
    expect(f.wakes).toHaveLength(1);
    expect(f.wakes[0].opts.idempotencyKey).toBe(`g12:fail:123:1:${A}:42:456:failure`);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ pendingAt: T, reconcileAt: T + 900_000 }));
    const restarted = fake(f.store); restarted.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    await restarted.tick(T + 300_000);
    // Expiry calls for reconciliation, never proof of non-acceptance or permission to resend.
    expect((await restarted.tick(T + 900_000)).unresolved).toBe(1);
    await restarted.tick(T + 86_400_000);
    expect(restarted.wakes).toHaveLength(0);
    expect(restarted.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(f.wakes.length + restarted.wakes.length).toBe(1);
  });

  it("F1a never dispatches without an acknowledged pending write, including a lost write acknowledgement", async () => {
    for (const persist of [false, true]) {
      const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
      const set = f.ctx.state.set;
      f.ctx.state.set = async (key, value) => {
        if (key.stateKey.startsWith("wake:")) {
          if (persist) await set(key, value);
          throw new Error("pending write acknowledgement lost");
        }
        await set(key, value);
      };
      await expect(f.tick()).rejects.toThrow(Code.TickFailed);
      expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
      const restarted = fake(f.store); restarted.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
      await restarted.tick(T + 300_000);
      expect(restarted.wakes).toHaveLength(persist ? 0 : 1);
    }
  });

  it("F1a checks the tick deadline after reserving and never dispatches late", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T);
    try {
      const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
      const set = f.ctx.state.set;
      f.ctx.state.set = async (key, value) => {
        await set(key, value);
        if (key.stateKey.startsWith("wake:")) clock.mockReturnValue(T + 240_000);
      };
      await f.tick(); expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
      expect([...f.store.values()]).toContainEqual(expect.objectContaining({ pendingAt: T }));
      const restarted = fake(f.store); restarted.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
      clock.mockReturnValue(T + 300_000); await restarted.tick(T + 300_000);
      expect(restarted.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("F1b backs off refused keys across 12 restarted ticks and advances the two-GET cursor to PR 2", async () => {
    const store = new Map<string, unknown>();
    const attempts: string[] = [], accepted: string[] = [];
    for (let tick = 0; tick < 12; tick++) {
      const f = fake(store); f.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
      f.pulls.set("org/repo", [pr(1), pr(2)]);
      f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
      const request = f.ctx.issues.requestWakeup;
      f.ctx.issues.requestWakeup = async (id, companyId, options) => {
        const key = options!.idempotencyKey!; attempts.push(key);
        if (key.startsWith("g12:fail:123:1:")) return { queued: false, runId: null };
        const result = await request(id, companyId, options); accepted.push(key); return result;
      };
      await f.tick(T + tick * 300_000).catch(() => {});
      expect(getCount(f)).toBeLessThanOrEqual(2);
      if (tick === 0) expect([...store.values()]).toContainEqual(expect.objectContaining({ pullOffset: 1 }));
    }
    expect(accepted).toEqual([`g12:fail:123:2:${A}:42:456:failure`]);
    expect(attempts.filter((key) => key.startsWith("g12:fail:123:1:")).length).toBeLessThanOrEqual(4);
  });

  it("F1b retries a definitive queued:false only at its persisted deadline and caps exponential backoff", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("refused");
    let now = T;
    for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]) {
      await expect(f.tick(now)).rejects.toThrow(Code.WakeRefused);
      const before = vi.mocked(f.ctx.issues.requestWakeup).mock.calls.length;
      await f.tick(now + delay - 1);
      expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(before);
      expect([...f.store.values()]).toContainEqual(expect.objectContaining({ retryAt: now + delay }));
      now += delay;
    }
    f.setWakeMode("ok"); expect((await f.tick(now)).wakes).toBe(1);
    expect((await f.tick(now)).deduped).toBe(1);
  });

  it.each(["secrets", "state", "config"])("F6(e) does not trust an exact enum member thrown by upstream %s", async (site) => {
    const f = fake(); const sentinel = Code.ConfigSecretRef;
    if (site === "secrets") f.ctx.secrets.resolve = async () => { throw new Error(sentinel); };
    if (site === "state") f.ctx.state.get = async () => { throw new Error(sentinel); };
    if (site === "config") {
      const definition = createG12Definition(); await definition.setup(f.ctx);
      await definition.onConfigChanged!(rawConfig(), { companyId: company });
      f.ctx.config.get = async () => { throw new Error(sentinel); };
      await expect(f.registered.get("g12-backstop")!(job)).rejects.toThrow(/^G12_JOB_FAILED$/);
    } else await expect(f.tick()).rejects.toThrow(/^G12_TICK_FAILED$/);
  });

  it("F6(e) rejects every untyped enum-shaped error, not just unknown code-shaped text", () => {
    for (const code of Object.values(Code)) expect(errorCode(new Error(code), Code.JobFailed)).toBe(Code.JobFailed);
    const typed = new G12Error(Code.GitHubHttp403); typed.message = Code.ConfigSecretRef;
    expect(errorCode(typed, Code.JobFailed)).toBe(Code.GitHubHttp403); // From type/code, not message.
    expect(errorCode({ code: Code.ConfigSecretRef, message: Code.ConfigSecretRef }, Code.JobFailed)).toBe(Code.JobFailed);
  });

  it("F1a protects the missing-review key across a lost accepted response and restart too", async () => {
    const f = fake(); await f.tick(); f.setWakeMode("throw-after-effect");
    await expect(f.tick(T + 900_000)).rejects.toThrow(Code.WakeFailed);
    expect(f.wakes.map((wake) => wake.opts.idempotencyKey)).toEqual([`g12:missing:123:1:${A}`]);
    const restarted = fake(f.store); await restarted.tick(T + 1_200_000);
    expect(restarted.wakes).toHaveLength(0);
    expect(restarted.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("F1a bounds unresolved reconciliation to one state transition/warning and permits positive acceptance reconciliation", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("throw-after-effect");
    await expect(f.tick()).rejects.toThrow(Code.WakeFailed);
    await f.tick(T + 900_000);
    const writes = vi.mocked(f.ctx.state.set).mock.calls.filter(([key]) => key.stateKey.startsWith("wake:")).length;
    await f.tick(T + 86_400_000); await f.tick(T + 86_700_000);
    expect(vi.mocked(f.ctx.state.set).mock.calls.filter(([key]) => key.stateKey.startsWith("wake:"))).toHaveLength(writes);
    expect(f.warnings.filter((warning) => JSON.stringify(warning).includes(Code.WakeUnresolved))).toHaveLength(1);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ unresolvedAt: T + 900_000 }));
    const reads = vi.mocked(f.ctx.state.get).mock.calls.length, before = vi.mocked(f.ctx.state.set).mock.calls.length;
    await reconcileWake(f.ctx.state, company, `g12:fail:123:1:${A}:42:456:failure`, {
      pendingAt: T, agentId: agent, issueId: issue, outcome: "accepted",
    }, T + 86_700_000);
    expect(f.ctx.state.get).toHaveBeenCalledTimes(reads + 1);
    expect(f.ctx.state.set).toHaveBeenCalledTimes(before + 1);
    expect((await f.tick(T + 87_000_000)).unresolved).toBe(0);
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["timestamp", "agent", "issue", "outcome"])("F1a rejects stale or mismatched %s reconciliation without changing state", async (field) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("throw-after-effect");
    await expect(f.tick()).rejects.toThrow(Code.WakeFailed);
    const before = structuredClone([...f.store.entries()]);
    const proof = { pendingAt: T, agentId: agent, issueId: issue, outcome: "not-dispatched" as const };
    if (field === "timestamp") proof.pendingAt++;
    if (field === "agent") proof.agentId = otherCompany;
    if (field === "issue") proof.issueId = otherCompany;
    if (field === "outcome") Object.assign(proof, { outcome: "unknown" });
    await expect(reconcileWake(f.ctx.state, company, `g12:fail:123:1:${A}:42:456:failure`, proof, T)).rejects.toThrow(Code.WakeReconcileInvalid);
    expect([...f.store.entries()]).toEqual(before);
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("F6(e) also sanitizes upstream state errors at the admin reconciliation boundary", async () => {
    const f = fake(); f.ctx.state.get = async () => { throw new Error(Code.WakeRefused); };
    await expect(reconcileWake(f.ctx.state, company, `g12:fail:123:1:${A}:42:456:failure`, {
      pendingAt: T, agentId: agent, issueId: issue, outcome: "accepted",
    }, T)).rejects.toThrow(Code.WakeReconcileInvalid);
    expect(f.ctx.state.set).not.toHaveBeenCalled(); expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it.each(["backoff-write", "pending-clear"])("F1b preserves uncertainty if the %s fails after queued:false", async (mode) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("refused");
    const set = f.ctx.state.set;
    f.ctx.state.set = async (key, value) => {
      if ((mode === "backoff-write" && key.stateKey.startsWith("retry:")) ||
          (mode === "pending-clear" && key.stateKey.startsWith("wake:") && value === null)) throw new Error(Code.ConfigSecretRef);
      await set(key, value);
    };
    await expect(f.tick()).rejects.toThrow(Code.TickFailed);
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    f.ctx.state.set = set; await f.tick(T + 300_000);
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ pendingAt: T }));
  });

  it.each(["receipt", "retry"])("F1 fails closed on corrupt %s metadata before dispatch", async (kind) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("refused");
    await expect(f.tick()).rejects.toThrow(Code.WakeRefused);
    const key = [...f.store.keys()].find((key) => JSON.parse(key).stateKey.startsWith(kind === "receipt" ? "wake:" : "retry:"))!;
    f.store.set(key, kind === "receipt" ? { pendingAt: T } : { attempts: 1, retryAt: -1 });
    await expect(f.tick(T + 300_000)).rejects.toThrow(kind === "receipt" ? Code.WakeReceiptInvalid : Code.WakeRetryInvalid);
    expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
});

describe("G12 fix-round regressions", () => {
  // Keep reason: PR #23/RFL findings at the host admission, credential and state trust boundaries.
  it.each(["blockers", "status", "budget", "queued:false"])("F1 retries a proven pre-dispatch %s refusal after backoff/reconciliation, including worker restart", async (mode) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    if (mode === "queued:false") f.setWakeMode("refused");
    else f.ctx.issues.requestWakeup = async () => { throw new Error(`host refused: ${mode}`); };
    await f.tick().catch(() => {});
    expect(f.wakes).toHaveLength(0);
    const receipt = [...f.store.entries()].find(([key]) => JSON.parse(key).stateKey.startsWith("wake:"))![1];
    if (mode === "queued:false") expect(receipt).toBeNull();
    else {
      expect(receipt).toMatchObject({ pendingAt: T });
      // Only this fake host knows it threw before any effect. A real RPC Error
      // does not prove that: an admin must positively reconcile the one key.
      await reconcileWake(f.ctx.state, company, `g12:fail:123:1:${A}:42:456:failure`, {
        pendingAt: T, agentId: agent, issueId: issue, outcome: "not-dispatched",
      }, T);
    }
    const restarted = fake(f.store); restarted.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    expect((await restarted.tick(T + 299_999)).wakes).toBe(0);
    expect((await restarted.tick(T + 300_000)).wakes).toBe(1);
    expect((await restarted.tick(T + 300_000)).deduped).toBe(1);
  });

  it("F2 ignores editable check names but keeps distinct app/run identities", async () => {
    const f = fake();
    f.checks.set(`org/repo:${A}`, [check({ id: 800, name: "CI", conclusion: "failure" })]);
    await f.tick();
    f.checks.set(`org/repo:${A}`, [check({ id: 800, name: "Renamed", conclusion: "failure" })]);
    expect((await f.tick()).deduped).toBe(1); expect(f.wakes).toHaveLength(1);
    f.checks.set(`org/repo:${A}`, [check({ id: 801, name: "Renamed", conclusion: "failure" }), check({ id: 800, app: { id: 99 }, name: "Renamed", conclusion: "failure" })]);
    expect((await f.tick()).wakes).toBe(2);
    expect(f.wakes.map((wake) => wake.opts.idempotencyKey)).toEqual([
      `g12:fail:123:1:${A}:42:800:failure`, `g12:fail:123:1:${A}:42:801:failure`, `g12:fail:123:1:${A}:99:800:failure`,
    ]);
  });

  it.each([otherCompany, null])("F3 refuses a mismatched/unassigned issue (%s), logs a fixed code and retries", async (assignee) => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setAssignee(assignee);
    await f.tick().catch(() => {});
    expect(f.wakes).toHaveLength(0);
    expect(f.warnings).toContainEqual({ message: "G12 wake refused", meta: { code: "G12_ISSUE_ASSIGNEE_MISMATCH" } });
    f.setAssignee(agent); expect((await f.tick(T + 299_999)).wakes).toBe(0);
    expect((await f.tick(T + 300_000)).wakes).toBe(1);
  });

  it("F4 rejects all, empty and missing repository lists before secret/HTTP access", async () => {
    for (const repos of ["all", [], undefined]) {
      const f = fake(); f.setConfig({ ...rawConfig(), repos });
      await expect(f.tick()).rejects.toThrow("G12_CONFIG_REPOS");
      expect(f.requests).toHaveLength(0); expect(f.secretReads).toHaveLength(0);
    }
  });

  it("F5 caps a default tick at 200 GETs and a recreated worker resumes through 500 PRs", async () => {
    const f = fake(); f.pulls.set("org/repo", Array.from({ length: 500 }, (_, n) => pr(n + 1)));
    f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    await f.tick();
    expect(f.requests.filter(({ init }) => init.method === "GET").length).toBeLessThanOrEqual(200);
    expect(f.wakes.length).toBeGreaterThan(0); expect(f.wakes.length).toBeLessThan(500);
    const restarted = fake(f.store); restarted.pulls.set("org/repo", f.pulls.get("org/repo")!);
    restarted.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    for (let n = 0; n < 4 && f.wakes.length + restarted.wakes.length < 500; n++) {
      const before = restarted.requests.length; await restarted.tick();
      expect(restarted.requests.slice(before).filter(({ init }) => init.method === "GET").length).toBeLessThanOrEqual(200);
    }
    expect(f.wakes.length + restarted.wakes.length).toBe(500);
    expect(new Set([...f.wakes, ...restarted.wakes].map((wake) => wake.opts.idempotencyKey)).size).toBe(500);
  });

  it.each([
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((T + 600_000) / 1000) },
    { "retry-after": "600" },
    { "retry-after": new Date(T + 600_000).toUTCString() },
  ])("F5 persists rate backoff across restart and resumes at expiry: %j", async (headers) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T);
    try {
      const f = fake(); const fetch = f.ctx.http.fetch;
      f.ctx.http.fetch = async (url, init) => {
        const response = await fetch(url, init);
        return url.includes("check-runs") ? new Response("sensitive rate body", { status: 429, headers: Object.fromEntries(Object.entries(headers)) }) : response;
      };
      await f.tick().catch(() => {});
      const restarted = fake(f.store);
      await restarted.tick(T + 599_999); expect(restarted.requests).toHaveLength(0); expect(restarted.secretReads).toHaveLength(0);
      await restarted.tick(T + 600_000); expect(restarted.requests.length).toBeGreaterThan(0);
    } finally { clock.mockRestore(); }
  });

  it.each(["G12_PRIVATE_KEY_SENTINEL", "G12_GITHUB_HTTP_999_PRIVATE_TOKEN"])("F6 closes tick and job error boundaries to arbitrary code-shaped text: %s", async (sentinel) => {
    const f = fake(); f.ctx.secrets.resolve = async () => { throw new Error(sentinel); };
    await expect(f.tick()).rejects.toThrow(/^G12_TICK_FAILED$/);
    expect(JSON.stringify([f.logs, f.warnings])).not.toContain(sentinel);
    const definition = createG12Definition(); await definition.setup(f.ctx);
    await definition.onConfigChanged!(rawConfig(), { companyId: company });
    f.ctx.config.get = async () => { throw new Error(sentinel); };
    await expect(f.registered.get("g12-backstop")!(job)).rejects.toThrow(/^G12_JOB_FAILED$/);
  });

  it("F8 persists no PR text, check names or raw semantic keys in receipts", async () => {
    const f = fake();
    f.pulls.set("org/repo", [{ ...pr(), title: "PRIVATE_PR_TITLE", body: "PRIVATE_PR_BODY" } as PullRequest]);
    f.checks.set(`org/repo:${A}`, [check({ name: "PRIVATE_CHECK_NAME", conclusion: "failure" })]);
    await f.tick();
    const state = JSON.stringify([...f.store.entries()]);
    for (const text of ["PRIVATE_PR_TITLE", "PRIVATE_PR_BODY", "PRIVATE_CHECK_NAME", "g12:fail:"]) expect(state).not.toContain(text);
  });
});

describe("G12 cursor, identity and boundary coverage", () => {
  it("F1 keeps accepted siblings deduped while retrying a positively reconciled refusal after backoff", async () => {
    const f = fake();
    f.checks.set(`org/repo:${A}`, [check({ id: 1, conclusion: "failure" }), check({ id: 2, conclusion: "failure" })]);
    const request = f.ctx.issues.requestWakeup;
    f.ctx.issues.requestWakeup = async (id, companyId, options) => {
      if (options?.idempotencyKey?.includes(":42:2:")) throw new Error("Issue is blocked by unresolved blockers");
      return request(id, companyId, options);
    };
    await expect(f.tick()).rejects.toThrow("G12_WAKE_FAILED"); expect(f.wakes).toHaveLength(1);
    f.ctx.issues.requestWakeup = request;
    await reconcileWake(f.ctx.state, company, `g12:fail:123:1:${A}:42:2:failure`, {
      pendingAt: T, agentId: agent, issueId: issue, outcome: "not-dispatched",
    }, T);
    expect(await f.tick(T + 300_000)).toMatchObject({ wakes: 1, deduped: 1 }); expect(f.wakes).toHaveLength(2);
  });

  it("F2 repository renames keep the same numeric repository identity", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); await f.tick();
    f.setConfig({ ...rawConfig(), repos: ["org/renamed"] });
    f.pulls.set("org/renamed", [pr()]); f.checks.set(`org/renamed:${A}`, [check({ name: "Renamed", conclusion: "failure" })]);
    expect((await f.tick()).deduped).toBe(1); expect(f.wakes).toHaveLength(1);
  });

  it("F3 also refuses the missing-review wake until the assignee matches", async () => {
    const f = fake(); await f.tick(); f.setAssignee(otherCompany);
    await expect(f.tick(T + 900_000)).rejects.toThrow("G12_ISSUE_ASSIGNEE_MISMATCH"); expect(f.wakes).toHaveLength(0);
    f.setAssignee(agent); expect((await f.tick(T + 1_200_000)).wakes).toBe(1);
  });

  it("F4 never mints an unrestricted token even when called outside config parsing", async () => {
    const f = fake(); const github = new GitHub(f.ctx.http, Date.now() + 60_000);
    for (const repos of ["all", [], undefined]) {
      await expect(github.installationToken({ ...parseConfig(rawConfig()), repos } as ReturnType<typeof parseConfig>, "synthetic-jwt")).rejects.toThrow("G12_CONFIG_REPOS");
    }
    expect(f.requests).toHaveLength(0);
  });

  it("F5 defaults to 200 GETs and validates the configurable per-tick limit", () => {
    expect(parseConfig(rawConfig()).maxGetsPerTick).toBe(200);
    expect(parseConfig({ ...rawConfig(), maxGetsPerTick: 2 }).maxGetsPerTick).toBe(2);
    for (const maxGetsPerTick of [0, 1, 1.5, 1001, "200", NaN]) {
      expect(() => parseConfig({ ...rawConfig(), maxGetsPerTick })).toThrow("G12_CONFIG_GET_LIMIT");
    }
  });

  it("F5 resumes within a single PR's check pagination at a two-GET budget without a false missing wake", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
    f.checks.set(`org/repo:${A}`, Array.from({ length: 250 }, (_, n) => check({ id: n + 1,
      name: n === 249 ? "Paperclip Review" : "Other", conclusion: n === 100 ? "failure" : "success" })));
    await f.tick(); expect(getCount(f)).toBe(2); expect(f.wakes).toHaveLength(0);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ checkPage: 2, headSha: A }));
    const restarted = fake(f.store); restarted.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
    restarted.checks.set(`org/repo:${A}`, f.checks.get(`org/repo:${A}`)!);
    await restarted.tick(T + 900_000); expect(getCount(restarted)).toBe(2); expect(restarted.wakes).toHaveLength(1);
    expect(restarted.wakes[0].opts.idempotencyKey).toBe(`g12:fail:123:1:${A}:42:101:failure`);
    expect((await restarted.tick(T + 1_200_000)).missing).toBe(0); expect(restarted.wakes).toHaveLength(1);
    expect(restarted.store.get(stateId({ scopeKind: "company", scopeId: company, namespace: "g12-v1", stateKey: "scan" }))).toBeNull();
  });

  it("F5 re-observes a changed head before continuing a paused PR", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
    f.checks.set(`org/repo:${A}`, Array.from({ length: 101 }, (_, n) => check({ id: n + 1, name: "Other", conclusion: n === 100 ? "failure" : "success" })));
    await f.tick(); f.pulls.set("org/repo", [pr(1, B)]);
    f.checks.set(`org/repo:${B}`, [check({ head_sha: B })]);
    expect(await f.tick(T + 900_000)).toMatchObject({ wakes: 0, missing: 0 });
    expect(f.requests.at(-1)!.url.pathname).toContain(B); expect(f.requests.at(-1)!.url.searchParams.get("page")).toBe("1");
  });

  it("F5 resumes across explicit repositories rather than starting again at the first one", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), repos: ["org/empty", "org/repo"], maxGetsPerTick: 2 });
    f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    await f.tick(); expect(getCount(f)).toBe(2); expect(f.wakes).toHaveLength(0);
    const before = f.requests.length; await f.tick(); expect(f.wakes).toHaveLength(1);
    expect(f.requests.slice(before).filter(({ init }) => init.method === "GET").map(({ url }) => url.pathname)).toEqual([
      "/repos/org/repo/pulls", `/repos/org/repo/commits/${A}/check-runs`,
    ]);
  });

  it.each([200, 403])("F5 honors remaining=0 on HTTP %s, including the final successful response", async (status) => {
    const f = fake(); const fetch = f.ctx.http.fetch;
    f.ctx.http.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!url.includes("check-runs")) return response;
      return new Response(status === 200 ? await response.text() : "sensitive rate body", {
        status, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((T + 600_000) / 1000) },
      });
    };
    await f.tick(); const before = f.requests.length; await f.tick(T + 599_999);
    expect(f.requests).toHaveLength(before);
    f.ctx.http.fetch = fetch; await f.tick(T + 600_000); expect(f.requests.length).toBeGreaterThan(before);
  });

  it("F5 measures retry-after from response time rather than tick start", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(T);
    try {
      const f = fake(); const fetch = f.ctx.http.fetch;
      f.ctx.http.fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (!url.includes("check-runs")) return response;
        clock.mockReturnValue(T + 30_000);
        return new Response("rate body", { status: 429, headers: { "retry-after": "600" } });
      };
      await f.tick(); const restarted = fake(f.store);
      clock.mockReturnValue(T + 600_000); await restarted.tick(T + 600_000); expect(restarted.requests).toHaveLength(0);
      clock.mockReturnValue(T + 630_000); await restarted.tick(T + 630_000); expect(restarted.requests.length).toBeGreaterThan(0);
    } finally { clock.mockRestore(); }
  });

  it("F5 fails closed on corrupt persisted positions without contacting GitHub", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
    f.pulls.set("org/repo", [pr(1), pr(2)]); await f.tick();
    const key = stateId({ scopeKind: "company", scopeId: company, namespace: "g12-v1", stateKey: "scan" });
    f.store.set(key, { ...(f.store.get(key) as object), pullPage: -1 }); const before = f.requests.length;
    await expect(f.tick()).rejects.toThrow("G12_SCAN_STATE_INVALID"); expect(f.requests).toHaveLength(before);
  });

  it("F6 maps unlisted HTTP statuses to one fixed enum code, not arbitrary status-derived strings", async () => {
    const f = fake(); f.setStatus(418); await expect(f.tick()).rejects.toThrow(/^G12_GITHUB_HTTP_FAILED$/);
  });

  it("F6 never copies a code-shaped host wake error into warning logs", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    f.ctx.issues.requestWakeup = async () => { throw new Error("G12_PRIVATE_KEY_SENTINEL"); };
    await expect(f.tick()).rejects.toThrow(/^G12_WAKE_FAILED$/);
    expect(f.warnings).toEqual([{ message: "G12 wake unresolved", meta: { code: "G12_WAKE_FAILED" } }]);
    expect(JSON.stringify([f.logs, f.warnings, [...f.store.entries()]])).not.toContain("G12_PRIVATE_KEY_SENTINEL");
  });

  it("F8 keeps paused scan state free of PR payloads and check names", async () => {
    const f = fake(); f.setConfig({ ...rawConfig(), maxGetsPerTick: 2 });
    f.pulls.set("org/repo", [{ ...pr(), title: "PRIVATE_TITLE", body: "PRIVATE_BODY" } as PullRequest]);
    f.checks.set(`org/repo:${A}`, Array.from({ length: 101 }, (_, n) => check({ id: n + 1, name: "PRIVATE_CHECK" })));
    await f.tick();
    const state = JSON.stringify([...f.store.entries()]);
    expect(state).toContain('"checkPage":2');
    for (const value of ["PRIVATE_TITLE", "PRIVATE_BODY", "PRIVATE_CHECK", "ALICE", "org/repo"]) expect(state).not.toContain(value);
  });
});

describe("G12 code-only backstop", () => {
  it("declares exactly one five-minute code job plus the assignee-read capability", () => {
    expect(manifest.capabilities).toEqual(["jobs.schedule", "http.outbound", "secrets.read-ref", "plugin.state.read", "plugin.state.write", "issues.read", "issues.wakeup"]);
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
      reason: `g12:missing:123:1:${A}`, contextSource: "smarty.g12-backstop", idempotencyKey: `g12:missing:123:1:${A}`,
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
    expect(f.wakes[1].opts.idempotencyKey).toBe(`g12:missing:123:1:${B}`);
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
      check({ id: 457, name: "Slow CI", conclusion: "timed_out" }), check({ name: "Cancelled", conclusion: "cancelled" }),
      check({ name: "Pending", status: "in_progress", conclusion: "failure" }), check({ name: "Old", head_sha: B, conclusion: "failure" }),
      check({ name: "Neutral", conclusion: "neutral" }), check({ name: "Action", conclusion: "action_required" }),
      check({ name: "CI", app: { id: 99 }, conclusion: "failure" })]);
    expect((await f.tick()).wakes).toBe(2);
    expect(f.wakes.map((wake) => wake.opts.idempotencyKey)).toEqual([`g12:fail:123:1:${A}:99:456:failure`, `g12:fail:123:1:${A}:42:457:timed_out`]);
    expect((await f.tick(T + 900_000)).deduped).toBe(2); expect(f.wakes).toHaveLength(2);
    f.pulls.set("org/repo", [pr(1, B)]);
    f.checks.set(`org/repo:${B}`, [check({ head_sha: B, name: "CI", conclusion: "failure" })]);
    await f.tick(); expect(f.wakes.at(-1)!.opts.idempotencyKey).toBe(`g12:fail:123:1:${B}:42:456:failure`);
  });

  it("has no agent/model call on empty or healthy ticks and logs only numeric counts", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check()]);
    await f.tick(); await f.tick(T + 900_000); f.pulls.clear(); await f.tick(T + 1_800_000);
    expect(f.wakes).toHaveLength(0);
    expect(f.logs).toHaveLength(3);
    expect(f.logs.every((counts) => Object.values(counts as object).every((value) => typeof value === "number"))).toBe(true);
    // ctx deliberately contains no agents, sessions or routines service.
  });

  it("scans only explicit repositories and paginates open PRs and check runs past page one", async () => {
    const f = fake();
    f.setConfig({ ...rawConfig(), repos: [...Array.from({ length: 100 }, (_, n) => `org/empty${n}`), "org/repo"] });
    f.pulls.set("org/repo", [...Array.from({ length: 100 }, (_, n) => ({ ...pr(n + 1), draft: true })), pr(101)]);
    f.checks.set(`org/repo:${A}`, [...Array.from({ length: 100 }, (_, n) => check({ name: n === 0 ? "Paperclip Review" : `CI${n}` })), check({ name: "Last-page CI", conclusion: "failure" })]);
    const counts = await f.tick();
    expect(counts).toMatchObject({ repos: 101, prs: 101, eligible: 1, checks: 101, wakes: 1 });
    expect(f.wakes[0].opts.idempotencyKey).toBe(`g12:fail:123:101:${A}:42:456:failure`);
    expect(f.requests.some(({ url }) => url.pathname === "/installation/repositories")).toBe(false);
    for (const suffix of ["/pulls", "/check-runs"]) {
      expect(f.requests.some(({ url }) => url.pathname.endsWith(suffix) && url.searchParams.get("page") === "2")).toBe(true);
    }
  });

  it("skips draft/unmapped/deleted authors; first eligibility begins only when ready and mapped", async () => {
    const f = fake();
    f.pulls.set("org/repo", [{ ...pr(), draft: true }, { ...pr(2), user: { login: "unknown" } }, { ...pr(3), user: null }]);
    expect(await f.tick()).toMatchObject({ eligible: 0, drafts: 1, unmapped: 2 }); expect([...f.store.values()].filter((value) => value !== null)).toHaveLength(0);
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

  it("keeps an ambiguous response pending rather than either claiming acceptance or repeating its possible effect", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]); f.setWakeMode("throw-after-effect");
    await expect(f.tick()).rejects.toThrow("G12_WAKE_FAILED"); expect(f.wakes).toHaveLength(1);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ pendingAt: T }));
    expect([...f.store.values()].some((value) => value !== null && typeof value === "object" && "acceptedAt" in value)).toBe(false);
    f.setWakeMode("ok"); expect((await f.tick()).wakes).toBe(0);
    expect((await f.tick()).deduped).toBe(1); expect(f.wakes).toHaveLength(1);
    expect(JSON.stringify([f.logs, f.warnings])).not.toContain("synthetic-installation-token");
  });

  it("retains a saved acceptance even if checkpointing the scan subsequently fails", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    const set = f.ctx.state.set;
    f.ctx.state.set = async (key, value) => {
      if (key.stateKey === "scan") throw new Error("simulated crash");
      await set(key, value);
    };
    await expect(f.tick()).rejects.toThrow("G12_TICK_FAILED"); expect(f.wakes).toHaveLength(1);
    f.ctx.state.set = set;
    expect((await f.tick()).deduped).toBe(1); expect(f.wakes).toHaveLength(1);
  });

  it("surfaces failure to save an acceptance while preserving its pre-dispatch reservation against replay", async () => {
    const f = fake(); f.checks.set(`org/repo:${A}`, [check({ conclusion: "failure" })]);
    const set = f.ctx.state.set;
    f.ctx.state.set = async (key, value) => {
      if (key.stateKey.startsWith("wake:") && value && "acceptedAt" in (value as object)) throw new Error("storage unavailable");
      await set(key, value);
    };
    await expect(f.tick()).rejects.toThrow("G12_TICK_FAILED"); expect(f.wakes).toHaveLength(1);
    expect([...f.store.values()]).toContainEqual(expect.objectContaining({ pendingAt: T }));
    f.ctx.state.set = set; f.setWakeMode("refused");
    expect((await f.tick()).deduped).toBe(1);
    expect((await f.tick(T + 900_000)).unresolved).toBe(1);
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
        case "issues.get": result = await f.ctx.issues.get(p.issueId, p.companyId); break;
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
        `g12:missing:123:1:${A}`, `g12:fail:123:1:${A}:42:456:timed_out`,
      ]);
      expect(new Set(methods)).toEqual(new Set(["log", "config.get", "secrets.resolve", "state.get", "state.set", "http.fetch", "issues.get", "issues.requestWakeup"]));
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
