import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentTaskSessions, authUsers, companies, companyMemberships, companySecretBindings, createDb, environments,
  heartbeatRuns, issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { agentService } from "../services/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as nativeRuntimeMode from "../services/native-runtime/runtime-mode.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// smarty-dev#20853, through the real save path (agent service + secret binding
// sync + config revision) and the real heartbeat session preparation.
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping session continuity tests: ${support.reason}`);

describePostgres("session continuity across settings saves (#20853)", () => {
  const captured = new Map<string, AdapterExecutionContext>();
  const secretsDir = path.join(os.tmpdir(), `paperclip-session-continuity-${randomUUID()}`);
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let mode: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    mkdirSync(secretsDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsDir, "master.key");
    temporary = await startEmbeddedPostgresTestDatabase("session-continuity-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    // A dispatch-capturing stand-in for paperclip_runner on the legacy path:
    // session preparation (the reset decision) is the code under test.
    mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
    });
    registerServerAdapter({
      type: "paperclip_runner",
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session",
          sessionParams: { sessionId: "saved-session", adapterState: "preserved" }, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: "paperclip_runner", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter("paperclip_runner");
    mode?.mockRestore();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsDir, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Continuity", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const secret = await secretService(db).create(companyId, { name: `key-${randomUUID()}`, provider: "local_encrypted", value: "v1" });
    const adapterConfig = {
      model: "model-a", lifecycleMode: "per_turn", idleTimeoutMs: 28_800_000,
      env: { API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    };
    await db.insert(agents).values({ id: agentId, companyId, name: "Continuity reader", adapterType: "paperclip_runner",
      status: "idle", adapterConfig: {}, runtimeConfig: {} });
    await save(agentId, userId, { adapterConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continuity", status: "todo", assigneeAgentId: agentId,
      responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId, secretId: secret.id, adapterConfig };
  }

  // The settings PATCH path: agent service update with a recorded revision.
  async function save(agentId: string, userId: string, patch: Record<string, unknown>) {
    const updated = await agentService(db).update(agentId, patch, { recordRevision: { createdByUserId: userId, source: "patch" } });
    expect(updated).not.toBeNull();
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    return { input: captured.get(run!.id)!, finished };
  }

  const bindingIds = (f: Awaited<ReturnType<typeof seed>>) => db.select({ id: companySecretBindings.id }).from(companySecretBindings)
    .where(and(eq(companySecretBindings.companyId, f.companyId), eq(companySecretBindings.targetType, "agent"),
      eq(companySecretBindings.targetId, f.agentId))).then(rows => rows.map(row => row.id).sort());

  // The run's selected environment (no explicit selection: the local one).
  const localEnvironmentId = async () => {
    const rows = await db.select().from(environments).where(eq(environments.driver, "local"));
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  };

  function expectKept(next: Awaited<ReturnType<typeof execute>>) {
    // No reset means no "Skipping saved session resume" warning (heartbeat.ts:3281-3286 is gated on it).
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false, resetReasons: [], taskSessionReused: true } } });
    expect(next.input.runtime.sessionId).toBe("saved-session");
  }

  it("(R1) a key-only idleTimeoutMs save keeps the saved session", async () => {
    const f = await seed();
    await execute(f);
    await save(f.agentId, f.userId, { adapterConfig: { ...f.adapterConfig, idleTimeoutMs: 300_000 } });
    expectKept(await execute(f));
  });

  it("(R2) an unrelated-key save that re-syncs the secret bindings keeps the session and the binding ids", async () => {
    const f = await seed();
    await execute(f);
    const before = await bindingIds(f);
    expect(before).toHaveLength(1);
    await save(f.agentId, f.userId, { name: "Renamed reader", adapterConfig: { ...f.adapterConfig } });
    expect(await bindingIds(f)).toEqual(before);
    expectKept(await execute(f));
  });

  it("(R5) an environment save that changes only runnerIdleTimeoutMs keeps the session", async () => {
    const f = await seed();
    await execute(f);
    const environmentId = await localEnvironmentId();
    const [environment] = await db.select().from(environments).where(eq(environments.id, environmentId));
    await db.update(environments).set({ config: { ...environment.config, runnerIdleTimeoutMs: 300_000 }, updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(environments.id, environmentId));
    expectKept(await execute(f));
  });

  it("(R6) an environment envVars value change still resets, with the reason", async () => {
    const f = await seed();
    await execute(f);
    const [environment] = await db.select().from(environments).where(eq(environments.id, await localEnvironmentId()));
    await db.update(environments).set({ envVars: { TZ: "America/Chicago" } as never, updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(environments.id, environment.id));
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true,
      changedCategories: expect.arrayContaining(["envBindings"]) } } });
  });

  it("(K3) a model change still resets", async () => {
    const f = await seed();
    await execute(f);
    await save(f.agentId, f.userId, { adapterConfig: { ...f.adapterConfig, model: "model-b" } });
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { taskSessionReused: false } } });
  });

  it("(K3) a secret VALUE change (new version) still resets", async () => {
    const f = await seed();
    await execute(f);
    await secretService(db).rotate(f.secretId, { value: "v2" });
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true,
      changedCategories: expect.arrayContaining(["secrets"]) } } });
  });

  it("(K4) a resave keeps binding ids, so a low-trust run limited to those ids still resolves the secret", async () => {
    const f = await seed();
    const before = await bindingIds(f);
    await save(f.agentId, f.userId, { adapterConfig: { ...f.adapterConfig, idleTimeoutMs: 300_000 } });
    const after = await bindingIds(f);
    expect(after).toEqual(before);
    await expect(secretService(db).resolveSecretValue(f.companyId, f.secretId, "latest", {
      consumerType: "agent", consumerId: f.agentId, configPath: "env.API_KEY", actorType: "agent", actorId: f.agentId,
      allowedBindingIds: before,
    })).resolves.toBe("v1");
    // A removed path still drops its binding; a re-pointed path still gets a new id.
    const other = await secretService(db).create(f.companyId, { name: `other-${randomUUID()}`, provider: "local_encrypted", value: "o1" });
    await save(f.agentId, f.userId, { adapterConfig: { ...f.adapterConfig, env: { API_KEY: { type: "secret_ref", secretId: other.id, version: "latest" } } } });
    const repointed = await bindingIds(f);
    expect(repointed).toHaveLength(1);
    expect(repointed).not.toEqual(before);
    await save(f.agentId, f.userId, { adapterConfig: { ...f.adapterConfig, env: {} } });
    expect(await bindingIds(f)).toEqual([]);
  });
});
