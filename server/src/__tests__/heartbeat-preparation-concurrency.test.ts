import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as outputModule from "../services/heartbeat/run-output.js";
import * as githubModule from "../services/heartbeat-github-launchers.js";
import * as selectionModule from "../services/heartbeat/runtime-selection.js";
import * as workspaceModule from "../services/heartbeat/workspaces.js";
import * as executionControlModule from "../services/adapter-execution-control.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

// Keep reason: no dispatch from partially prepared state, including Stop and
// simultaneous setup failures. These tests exercise the assembled coordinator;
// only GitHub discovery/runtime selection/provider execution are fixture boundaries.
const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(recoveryPostgresSupport.reason);

type Phase = "run_output" | "github_environment" | "runtime_selection";
const phases: Phase[] = ["run_output", "github_environment", "runtime_selection"];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describePostgres("heartbeat independent preparation", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const oldHome = process.env.PAPERCLIP_HOME;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let providerInput: AdapterExecutionContext | undefined;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-preparation-concurrency-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "heartbeat-preparation-home-"));
    process.env.PAPERCLIP_HOME = home;
    registerServerAdapter({
      type: "codex_local", supportsLocalAgentJwt: false,
      execute: async input => {
        providerInput = input;
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);
  afterEach(async () => {
    await heartbeat?.drainActiveRunExecutions();
    vi.restoreAllMocks();
    providerInput = undefined;
  });
  afterAll(async () => {
    unregisterServerAdapter("codex_local");
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture(options: {
    delayMs?: number;
    failures?: Partial<Record<Phase, Error>>;
    validationFailure?: Error;
    wait?: Partial<Record<Phase, Promise<void>>>;
    onStarted?: (phase: Phase) => void;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `preparation-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Preparation fixture", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Preparation fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Preparation fixture", adapterType: "codex_local", status: "idle",
      adapterConfig: { model: "fixture", env: { PREPARATION_INPUT: "retained" } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Prepare without partial dispatch", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    const starts = new Map<Phase, number>(), ends = new Map<Phase, number>();
    if (options.validationFailure) vi.spyOn(workspaceModule, "assertGitSensitiveAdapterWorkspaceValid").mockRejectedValue(options.validationFailure);
    async function step<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
      starts.set(phase, performance.now());
      options.onStarted?.(phase);
      try {
        await delay(options.delayMs ?? 0);
        await options.wait?.[phase];
        if (options.failures?.[phase]) throw options.failures[phase];
        return await work();
      } finally { ends.set(phase, performance.now()); }
    }
    const createOutput = outputModule.createHeartbeatRunOutput;
    vi.spyOn(outputModule, "createHeartbeatRunOutput").mockImplementation((...args) => {
      const output = createOutput(...args);
      return { ...output, begin: run => step("run_output", () => output.begin(run)) };
    });
    vi.spyOn(githubModule, "prepareHeartbeatGitHubEnvironment").mockImplementation(input => step("github_environment", async () => ({
      env: { ...input.env, PREPARATION_GITHUB: "prepared" }, prepare: undefined,
    })));
    vi.spyOn(selectionModule, "prepareAndSelectHeartbeatRuntime").mockImplementation((_db, input) => step("runtime_selection", async () => {
      // Real dependency: runtime selection must see the GitHub-derived config,
      // and the real output writer must have persisted its handle already.
      expect(input.config.runtimeConfig.env).toMatchObject({ PREPARATION_INPUT: "retained", PREPARATION_GITHUB: "prepared" });
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.run.id));
      expect(row.logRef).toBeTruthy();
      await input.onAdapterEvent({ eventType: "fixture.prepared", stream: "system", level: "info", message: "Prepared before dispatch" });
      return { selected: true, nativeExecution: null, nativeRunnerInstanceId: null, nativeWorkspaceSync: null, getNativeFreshSessionHandoff: undefined };
    }));
    let control: ReturnType<typeof executionControlModule.createAdapterExecutionControl> | undefined;
    const createControl = executionControlModule.createAdapterExecutionControl;
    vi.spyOn(executionControlModule, "createAdapterExecutionControl").mockImplementation(() => control = createControl());
    heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId }, contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    return { starts, ends, control: () => control!, async readRun() {
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0];
    }, async finish() {
      await heartbeat.drainActiveRunExecutions();
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0];
    } };
  }

  it("overlaps independent 300ms output/GitHub work, preserving the runtime-selection edge and prepared values", async () => {
    const f = await fixture({ delayMs: 300 });
    const row = await f.finish();
    const elapsedMs = f.ends.get("runtime_selection")! - Math.min(...f.starts.values());
    const env = providerInput?.config.env as Record<string, string> | undefined;
    const preparedResult = { model: providerInput?.config.model, env: { PREPARATION_INPUT: env?.PREPARATION_INPUT,
      PREPARATION_GITHUB: env?.PREPARATION_GITHUB }, logStore: row.logStore, status: row.status };
    console.log(JSON.stringify({ row: "three-300ms-production-dependency-graph", elapsedMs, preparedResult,
      phases: phases.map(phase => ({ phase, startMs: f.starts.get(phase), endMs: f.ends.get(phase) })) }));
    expect(preparedResult).toEqual({ model: "fixture", env: { PREPARATION_INPUT: "retained", PREPARATION_GITHUB: "prepared" },
      logStore: "local_file", status: "succeeded" });
    expect(providerInput).toBeDefined();
    expect(Math.abs(f.starts.get("run_output")! - f.starts.get("github_environment")!)).toBeLessThan(150);
    expect(f.starts.get("runtime_selection")!).toBeGreaterThanOrEqual(Math.max(f.ends.get("run_output")!, f.ends.get("github_environment")!));
    expect(elapsedMs).toBeGreaterThanOrEqual(600);
    expect(elapsedMs).toBeLessThan(850);
  });

  it.each(phases)("fails closed with the original %s failure", async phase => {
    const f = await fixture({ failures: { [phase]: new Error(`preparation_${phase}_failed`) } });
    const row = await f.finish();
    expect(row.status).toBe("failed");
    expect(row.error).toContain(`preparation_${phase}_failed`);
    expect(row.errorCode).toBe("adapter_failed");
    console.log(JSON.stringify({ row: "preparation-failure", phase, status: row.status, error: row.error, errorCode: row.errorCode,
      providerStarted: providerInput !== undefined }));
    expect(providerInput).toBeUndefined();
    if (phase !== "runtime_selection") expect(f.starts.has("runtime_selection")).toBe(false);
  });

  it("does not run GitHub discovery or runtime selection when workspace validation fails", async () => {
    const f = await fixture({ validationFailure: new Error("preparation_workspace_invalid") });
    const row = await f.finish();
    expect(row.status).toBe("failed");
    expect(row.error).toContain("preparation_workspace_invalid");
    expect(f.starts.has("github_environment")).toBe(false);
    expect(f.starts.has("runtime_selection")).toBe(false);
    expect(providerInput).toBeUndefined();
  });

  it("drains a delayed sibling before surfacing failure; serial-order failure wins", async () => {
    const githubStarted = deferred(), releaseGitHub = deferred(), outputFailed = deferred();
    const outputError = new Error("preparation_output_original");
    const f = await fixture({ failures: { run_output: outputError, github_environment: new Error("preparation_github_secondary") },
      wait: { github_environment: releaseGitHub.promise }, onStarted: phase => {
        if (phase === "github_environment") githubStarted.resolve();
        if (phase === "run_output") outputFailed.resolve();
      } });
    try {
      await Promise.all([githubStarted.promise, outputFailed.promise]);
      await delay(30);
      expect(providerInput).toBeUndefined();
      expect(f.starts.has("runtime_selection")).toBe(false);
      expect((await f.readRun()).status).toBe("running");
      let settled = false;
      const finishing = f.finish().then(row => { settled = true; return row; });
      await delay(30);
      expect(settled).toBe(false);
      releaseGitHub.resolve();
      const row = await finishing;
      expect(row.error).toContain(outputError.message);
      expect(f.ends.has("github_environment")).toBe(true);
    } finally { releaseGitHub.resolve(); }
  });

  it("cancels mid-prepare, drains both branches and never enters runtime selection/provider dispatch", async () => {
    const outputStarted = deferred(), githubStarted = deferred(), releaseOutput = deferred(), releaseGitHub = deferred();
    const f = await fixture({ wait: { run_output: releaseOutput.promise, github_environment: releaseGitHub.promise },
      onStarted: phase => { if (phase === "run_output") outputStarted.resolve(); if (phase === "github_environment") githubStarted.resolve(); } });
    try {
      await Promise.all([outputStarted.promise, githubStarted.promise]);
      f.control().controller.abort(new Error("preparation_cancelled"));
      releaseOutput.resolve();
      let settled = false;
      const finishing = f.finish().then(row => { settled = true; return row; });
      await delay(30);
      expect(settled).toBe(false);
      releaseGitHub.resolve();
      const row = await finishing;
      expect(["failed", "cancelled"]).toContain(row.status);
      expect(providerInput).toBeUndefined();
      expect(f.starts.has("runtime_selection")).toBe(false);
      expect(f.ends.has("run_output")).toBe(true);
      expect(f.ends.has("github_environment")).toBe(true);
      console.log(JSON.stringify({ row: "preparation-cancellation", status: row.status, providerStarted: providerInput !== undefined,
        settledPhases: [...f.ends.keys()] }));
    } finally { releaseOutput.resolve(); releaseGitHub.resolve(); }
  });
});
