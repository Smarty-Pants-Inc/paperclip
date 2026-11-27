import * as databaseModule from "@paperclipai/db";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, applyPendingMigrations, closeFileStorageDb, createDb, pluginCompanySettings, pluginConfig, plugins, resourceLifecycleEvents, secretAccessEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as instructionModule from "../services/agent-instructions.js";
import { pluginAgentRuntimeState, pluginAgentRuntimeIdentity } from "../services/plugin-agent-runtime-state.js";
import { pluginLifecycleInbox } from "../services/plugin-lifecycle-inbox.js";
import { registerPluginLifecycleDelivery } from "../services/plugin-lifecycle-delivery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { secretService } from "../services/secrets.js";

const externalUrl = process.env.PAPERCLIP_AGENT_RUNTIME_HOOKS_TEST_DATABASE_URL;
const expectedDatabase = process.env.PAPERCLIP_AGENT_RUNTIME_HOOKS_EXPECTED_DATABASE;
if (externalUrl || expectedDatabase) {
  if (!externalUrl || !expectedDatabase || !/^sleep2_[a-z0-9_]+_test$/.test(expectedDatabase)) {
    throw new Error("Explicit external fixture URL and expected database are required");
  }
  const target = new URL(externalUrl);
  if (!["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "127.0.0.1" || target.port !== "55448" || target.pathname !== `/${expectedDatabase}` || target.search) {
    throw new Error("External fixture must match the exact owned database");
  }
}
const support = externalUrl ? { supported: true as const } : await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("agent runtime synchronization hooks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let pluginId: string;
  let agentId: string;
  let home: string;
  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else database = await startEmbeddedPostgresTestDatabase("paperclip-agent-runtime-");
    db = createDb(externalUrl ?? database.connectionString, { maxConnections: 4 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-runtime-home-"));
  }, 90_000);
  afterAll(async () => {
    try { if (db) await closeFileStorageDb(db, 1); }
    finally {
      try { await db?.$client.end({ timeout: 1 }); }
      finally {
        try { await database?.cleanup(); }
        finally { if (home) await fs.rm(home, { recursive: true, force: true }); }
      }
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    companyId = randomUUID(); pluginId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runtime fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready",
      manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runtime agent", lifecycleRequiredPluginIds: [pluginId] });
  });
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);

  async function heldConfigurationRun() {
    const { heartbeatRuns, issues } = await import("@paperclipai/db");
    const root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Runtime agent", adapterConfig: {} });
    const config = { provider: "pi_rpc", model: "openai/gpt-5", sessionContinuity: "continuous",
      instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md", instructionsFilePath: `${root}/AGENTS.md` };
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, agentId));
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "Original instructions");
    const [issue] = await db.insert(issues).values({ companyId, title: "Held configuration", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "running",
      runtimeMode: "native", nativeIssueId: issue.id, resultJson: { retained: "receipt" } }).returning();
    const read = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!;
    const clear = () => db.update(heartbeatRuns).set({ resultJson: { retained: "receipt" } }).where(eq(heartbeatRuns.id, run.id));
    return { config, root, run, read, clear };
  }

  it.each(["model", "piRpcThinkingLevel", "piThinkingLevel", "thinkingLevel", "modelReasoningEffort", "reasoningEffort", "effort", "variant", "futureRetainedInput"])
    ("hold seam producers: committed %s changes end only that agent's old native hold; no-op/rollback do not", async key => {
    const { agentService } = await import("../services/agents.js");
    const { updateAgentConfigurationInTransaction } = await import("../services/agent-configuration-transaction.js");
    const { heartbeatRuns } = await import("@paperclipai/db");
    const f = await heldConfigurationRun();
    const [otherAgent] = await db.insert(agents).values({ companyId, name: "Unchanged agent" }).returning();
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgent.id, invocationSource: "on_demand", status: "running", runtimeMode: "native" }).returning();
    const service = agentService(db);
    await service.update(agentId, { name: "Display-only rename" });
    await service.update(agentId, { adapterConfig: { ...f.config, timeoutSec: 45 } });
    await service.update(agentId, { adapterConfig: { ...f.config, timeoutSec: 45 } });
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    await expect(db.transaction(async tx => {
      await updateAgentConfigurationInTransaction(tx as unknown as Db, agentId, { adapterConfig: { ...f.config, [key]: "rolled-back" } });
      throw new Error("configuration rollback");
    })).rejects.toThrow("configuration rollback");
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    await service.update(agentId, { adapterConfig: { ...f.config, [key]: key === "model" ? "openai/gpt-5-mini" : "high" } });
    const changed = await f.read();
    expect(changed.resultJson).toEqual({ retained: "receipt", heldNativeConfigurationEnd: true });
    expect(changed.status).toBe("running");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRun.id)))[0]!.resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    // Intent belongs to the old run; a successor has no stale close/cancel state.
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "queued", runtimeMode: "native" }).returning();
    expect(next.resultJson?.heldNativeConfigurationEnd).not.toBe(true);
  });

  it("hold seam producers: changed instruction entry bytes request an end, identical bytes never do", async () => {
    const f = await heldConfigurationRun();
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const instructions = agentInstructionRevisionService(db);
    const initial = (await instructions.readCurrent({ companyId, agentId }, actor))!;
    const commit = (content: string, baseRevisionId: string) => instructions.commit({ companyId, agentId,
      entryFile: "AGENTS.md", content, baseRevisionId, source: "api" }, actor);
    expect((await commit(initial.content, initial.revision.id)).changed).toBe(false);
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    const changed = await commit("Changed instructions", initial.revision.id);
    expect(changed.changed).toBe(true);
    expect((await f.read()).resultJson).toEqual({ retained: "receipt", heldNativeConfigurationEnd: true });
    await f.clear();
    expect((await commit(changed.content, changed.revision.id)).changed).toBe(false);
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
  });

  it("hold seam v3: a chat model change ends only that issue's held run, after commit", async () => {
    const { heartbeatRuns, issues } = await import("@paperclipai/db");
    const { requestHeldNativeConfigurationEnd } = await import("../services/native-runtime/held-native-turn.js");
    const { issueService } = await import("../services/issues.js");
    const f = await heldConfigurationRun();
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Other held chat", assigneeAgentId: agentId }).returning();
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: otherIssue.id, resultJson: { retained: "other receipt" } }).returning();
    const change = async (tx: Db) => {
      await issueService(db).update(f.run.nativeIssueId!, { assigneeAdapterOverrides: { adapterConfig: { model: "paperclip/gpt-6.2-sol" } } }, tx);
      await requestHeldNativeConfigurationEnd(tx, { companyId, agentId, issueId: f.run.nativeIssueId! });
    };
    await expect(db.transaction(async tx => { await change(tx as unknown as Db); throw new Error("rollback chip change"); }))
      .rejects.toThrow("rollback chip change");
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    await db.transaction(tx => change(tx as unknown as Db));
    expect((await f.read()).resultJson).toEqual({ retained: "receipt", heldNativeConfigurationEnd: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRun.id)))[0]!.resultJson)
      .toEqual({ retained: "other receipt" });
  });

  it("hold seam v2: the configuration producer waits on issue before owning run", async () => {
    const { heartbeatRuns, issues } = await import("@paperclipai/db");
    const { requestHeldNativeConfigurationEnd } = await import("../services/native-runtime/held-native-turn.js");
    const f = await heldConfigurationRun();
    let release!: () => void, locked!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const producerReady = new Promise<void>(resolve => { started = resolve; });
    const checkout = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.run.nativeIssueId!)).for("update");
      locked(); await gate;
    });
    await ready;
    let pid = 0;
    const producer = db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      pid = Number(backend.pid); started();
      await requestHeldNativeConfigurationEnd(tx as unknown as Db, { companyId, agentId });
    });
    try {
      await producerReady;
      await vi.waitFor(async () => {
        const [waiting] = await db.execute(sql`select wait_event_type, query from pg_stat_activity where pid = ${pid}`);
        expect(waiting.wait_event_type).toBe("Lock");
        expect(waiting.query).toContain('from "issues"');
      });
      // The issue owner can still take its run lock: no inverse run lock was acquired.
      await db.transaction(tx => tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update", { noWait: true }));
    } finally { release(); await checkout; await producer; }
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).toBe(true);
  });

  it("hold seam v2: identical entry adoption binds managed paths without ending the hold", async () => {
    const f = await heldConfigurationRun();
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const instructions = agentInstructionRevisionService(db);
    const initial = (await instructions.readCurrent({ companyId, agentId }, actor))!;
    // Exercise bindEntry on the identical-byte return, not only the already-bound path.
    const { instructionsBundleMode, instructionsRootPath, ...unbound } = f.config;
    await db.update(agents).set({ adapterConfig: unbound }).where(eq(agents.id, agentId));
    const saved = await instructions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: initial.content,
      baseRevisionId: initial.revision.id, source: "api" }, actor);
    expect(saved.changed).toBe(false);
    expect((await f.read()).resultJson?.heldNativeConfigurationEnd).not.toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.adapterConfig.instructionsRootPath).toBe(f.root);
    expect(agent!.adapterConfig.instructionsBundleMode).toBe("managed");
  });

  it("captures all configuration writers while ignoring no-op and heartbeat bookkeeping updates", async () => {
    expect(await events()).toHaveLength(1);
    await db.update(agents).set({ name: "Runtime agent", updatedAt: new Date(), lastHeartbeatAt: new Date(), spendMonthUtc: "2099-01" }).where(eq(agents.id, agentId));
    expect(await events()).toHaveLength(1);
    await db.update(agents).set({ adapterConfig: { model: "fixture" }, permissions: { canCreateAgents: true } }).where(eq(agents.id, agentId));
    await db.update(agents).set({ runtimeConfig: { fixture: true } }).where(eq(agents.id, agentId));
    const rows = await events();
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.resourceId === agentId)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
  });

  it("captures instruction saves, deletion and writeback through the shared file store", async () => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    await agentFileStore(db).write({ companyId, agentId, path: "AGENTS.md", bytes: Buffer.from("instructions"), baseHash: null }, actor);
    const saved = await agentFileStore(db).write({ companyId, agentId, path: "notes.txt", bytes: Buffer.from("notes"), baseHash: null }, actor);
    const beforeDelete = (await events()).length;
    await agentFileStore(db).write({ companyId, agentId, path: "notes.txt", bytes: null, baseHash: saved.contentHash }, actor);
    expect(await events()).toHaveLength(beforeDelete + 1);
    expect(await events()).toContainEqual(expect.objectContaining({ resourceId: agentId, action: "update" }));
  });

  it("records a managed reset even when only its supporting files changed", async () => {
    const before = (await events()).length;
    await db.insert(activityLog).values({ companyId, actorType: "plugin", actorId: pluginId, action: "plugin.managed_agent.reset", entityType: "agent", entityId: agentId });
    expect(await events()).toHaveLength(before + 1);
  });

  it("rolls configuration and its event back together and rejects a change when journaling fails", async () => {
    const before = await events();
    await expect(db.transaction(async tx => {
      await tx.update(agents).set({ name: "Rolled back" }).where(eq(agents.id, agentId));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await events()).toEqual(before);
    await db.execute((await import("drizzle-orm")).sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT runtime_fixture_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(db.update(agents).set({ name: "Failed" }).where(eq(agents.id, agentId))).rejects.toThrow(); }
    finally { await db.execute((await import("drizzle-orm")).sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT runtime_fixture_failure`); }
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].name).toBe("Runtime agent");
    expect(await events()).toEqual(before);
  });

  it.each(["file-write", "file-delete", "instructions"])("repairs runtime delivery when %s is retried after journal failure", async writer => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const instructions = agentInstructionRevisionService(db);
    const initial = await instructions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: "original", baseRevisionId: null, source: "api" }, actor);
    const store = agentFileStore(db);
    const saved = writer === "file-delete" ? await store.write({ companyId, agentId, path: "notes.txt", bytes: Buffer.from("notes"), baseHash: null }, actor) : null;
    const save = () => writer === "instructions"
      ? instructions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: "changed", baseRevisionId: initial.revision.id, source: "api" }, actor)
      : store.write({ companyId, agentId, path: saved ? "notes.txt" : "AGENTS.md", bytes: saved ? null : Buffer.from("changed"), baseHash: saved ? saved.contentHash : initial.revision.contentHash }, actor);
    const inbox = pluginLifecycleInbox(db, pluginId);
    for (const event of await events()) await inbox.acknowledge(companyId, String(event.id));
    const before = await events();
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT file_runtime_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(save()).rejects.toThrow(); }
    finally { await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT file_runtime_failure`); }
    expect(await events()).toEqual(before);
    expect(await store.read(companyId, agentId, saved ? "notes.txt" : "AGENTS.md", actor)).toEqual(saved ? null : Buffer.from("changed"));
    expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toHaveLength(before.length + 1);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([expect.objectContaining({ resourceId: agentId, action: "update" })]);
    const repaired = await events();
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId)).orderBy(activityLog.id);
    for (let replay = 0; replay < 5; replay++) expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toEqual(repaired);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, agentId)).orderBy(activityLog.id)).toEqual(audits);
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.revision).toBe(String((await events()).at(-1)!.id));
  });

  it("repairs a failed save even when that content hash was recorded before an intervening change", async () => {
    const actor = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
    const store = agentFileStore(db);
    const target = { companyId, agentId, path: "AGENTS.md" };
    const first = await store.write({ ...target, bytes: Buffer.from("first"), baseHash: null }, actor);
    const second = await store.write({ ...target, bytes: Buffer.from("second"), baseHash: first.contentHash }, actor);
    await store.write({ ...target, bytes: Buffer.from("first"), baseHash: second.contentHash }, actor);
    const before = (await events()).length;
    const save = () => store.write({ ...target, bytes: Buffer.from("second"), baseHash: first.contentHash }, actor);
    await db.execute(sql`ALTER TABLE resource_lifecycle_events ADD CONSTRAINT repeated_hash_failure CHECK (resource_type <> 'agent_runtime') NOT VALID`);
    try { await expect(save()).rejects.toThrow(); }
    finally { await db.execute(sql`ALTER TABLE resource_lifecycle_events DROP CONSTRAINT repeated_hash_failure`); }
    expect(await save()).toMatchObject({ changed: false });
    expect(await events()).toHaveLength(before + 1);
    await save();
    expect(await events()).toHaveLength(before + 1);
  });

  it("keeps old subscriptions isolated and replays runtime events in order until acknowledged", async () => {
    await db.update(agents).set({ name: "New name" }).where(eq(agents.id, agentId));
    const inbox = pluginLifecycleInbox(db, pluginId);
    expect(await inbox.list(companyId)).toEqual([]);
    const [first] = await inbox.list(companyId, 100, undefined, ["agent_runtime"]);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([first]);
    const rows = await events();
    await expect(inbox.acknowledge(companyId, String(rows[1].id))).rejects.toMatchObject({ status: 409 });
    await inbox.acknowledge(companyId, first.id);
    expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([expect.objectContaining({ id: String(rows[1].id) })]);
  });

  it.each([{}, { instructionsBundleMode: "managed", instructionsRootPath: "/missing/previous-home" }])("recovers effective managed instruction paths from disk for %j", async adapterConfig => {
    const [agent] = await db.update(agents).set({ adapterConfig }).where(eq(agents.id, agentId)).returning();
    const root = resolveManagedInstructionsRoot(agent);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "GUIDE.md"), "restored instructions");
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    expect(state).toMatchObject({ instructionsRootPath: root, instructionsEntryFile: "GUIDE.md" });
    expect(await fs.readFile(path.join(state!.instructionsRootPath!, state!.instructionsEntryFile), "utf8")).toBe("restored instructions");
  });

  it("supplies default instructions when the agent has no instruction directory", async () => {
    await db.update(agents).set({ adapterConfig: { promptTemplate: "Fallback task instructions" } }).where(eq(agents.id, agentId));
    expect(await pluginAgentRuntimeState(db, pluginId, companyId, agentId)).toMatchObject({
      instructionsRootPath: null, instructionsEntryFile: "AGENTS.md", instructionsEntryContent: "Fallback task instructions",
    });
  });

  it("resolves instructions without reading or hashing bundle contents", async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const root = resolveManagedInstructionsRoot(agent);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
    await fs.writeFile(path.join(root, "support.bin"), Buffer.alloc(1024 * 1024));
    const read = vi.spyOn(fs, "readFile");
    expect(await pluginAgentRuntimeState(db, pluginId, companyId, agentId)).toMatchObject({ instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" });
    expect(read.mock.calls.filter(([file]) => String(file).startsWith(`${root}${path.sep}`))).toEqual([]);
  });

  it("reads fresh runtime identity without building instructions, skills or connection assignments", async () => {
    const hydrate = vi.spyOn(instructionModule, "agentInstructionsService").mockImplementation(() => { throw new Error("full runtime hydration must not run"); });
    const first = await pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId);
    expect(first).toEqual({ revision: String((await events()).at(-1)!.id), instanceSecrets: {},
      agent: expect.objectContaining({ id: agentId, companyId }) });
    expect(Object.keys(first!.agent).sort()).toEqual(["companyId", "id", "lifecycleState", "lifecycleVersion", "status"]);
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", lifecycleVersion: 2 }).where(eq(agents.id, agentId));
    const paused = await pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId);
    expect(paused!.agent).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleVersion: 2 });
    expect(paused!.revision).toBe(first!.revision);
    await db.update(agents).set({ name: "Updated runtime" }).where(eq(agents.id, agentId));
    expect((await pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId))!.revision).not.toBe(first!.revision);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("keeps compact runtime reads scoped to the enabled owning plugin", async () => {
    expect(await pluginAgentRuntimeIdentity(db, pluginId, randomUUID(), agentId)).toBeNull();
    await expect(pluginAgentRuntimeIdentity(db, randomUUID(), companyId, agentId)).rejects.toMatchObject({ status: 403 });
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    await expect(pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId)).rejects.toMatchObject({ status: 403 });
    await db.delete(pluginCompanySettings).where(eq(pluginCompanySettings.pluginId, pluginId));
    await db.update(agents).set({ lifecycleRequiredPluginIds: [] }).where(eq(agents.id, agentId));
    await expect(pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId)).rejects.toMatchObject({ status: 403 });
  });

  it("returns the same identity, revision, secrets and failures as the full runtime read", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    const scope = { companyId, agentId, pluginId };
    const outcome = (read: Promise<unknown>) => read.then(value => value, (error: { status?: number }) => ({ status: error.status }));
    const same = async (company = companyId, agent = agentId, plugin = pluginId) => {
      const state = await outcome(pluginAgentRuntimeState(db, plugin, company, agent)) as Awaited<ReturnType<typeof pluginAgentRuntimeState>> | { status: number };
      const identity = await outcome(pluginAgentRuntimeIdentity(db, plugin, company, agent));
      expect(identity).toEqual(state && "revision" in state ? { revision: state.revision, instanceSecrets: state.instanceSecrets, agent: {
        id: state.agent.id, companyId: state.agent.companyId, status: state.agent.status, lifecycleState: state.agent.lifecycleState, lifecycleVersion: state.agent.lifecycleVersion } } : state);
      return identity as Awaited<ReturnType<typeof pluginAgentRuntimeIdentity>>;
    };
    await secretService(db).agentInstance.set(scope, "launcher", "first launcher");
    const first = await same();
    expect(first).toEqual({ revision: String((await events()).at(-1)!.id), instanceSecrets: { launcher: "first launcher" },
      agent: { id: agentId, companyId, status: "idle", lifecycleState: "ready", lifecycleVersion: 0 } });
    await db.insert(resourceLifecycleEvents).values([{ companyId, resourceType: "agent", resourceId: agentId, action: "pause" },
      { companyId, resourceType: "agent_runtime", resourceId: randomUUID(), action: "update" }]);
    expect((await same())!.revision).toBe(first!.revision);
    const [latest] = await db.insert(resourceLifecycleEvents).values({ companyId, resourceType: "agent_runtime", resourceId: agentId, action: "update" }).returning();
    expect((await same())!.revision).toBe(String(latest.id));
    await db.update(agents).set({ lifecycleState: "preparing", lifecycleVersion: 3 }).where(eq(agents.id, agentId));
    expect((await same())!.agent).toMatchObject({ lifecycleState: "preparing", lifecycleVersion: 3 });
    await secretService(db).agentInstance.set(scope, "launcher", "second launcher");
    expect((await same())!.instanceSecrets).toEqual({ launcher: "second launcher" });
    await secretService(db).agentInstance.set(scope, "launcher", null);
    expect((await same())!.instanceSecrets).toEqual({});
    await secretService(db).agentInstance.set(scope, "launcher", "third launcher");
    const accessEvents = async () => (await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId))).length;
    const audited = await accessEvents();
    expect(await same(randomUUID())).toBeNull();
    expect(await same(companyId, randomUUID())).toBeNull();
    expect(await same(companyId, agentId, randomUUID())).toEqual({ status: 403 });
    const manifest = { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] };
    const denials: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
      [() => db.update(plugins).set({ status: "error" }).where(eq(plugins.id, pluginId)), () => db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId))],
      [() => db.update(plugins).set({ manifestJson: { ...manifest, capabilities: ["events.subscribe"] } as never }).where(eq(plugins.id, pluginId)),
        () => db.update(plugins).set({ manifestJson: manifest as never }).where(eq(plugins.id, pluginId))],
      [() => db.update(plugins).set({ manifestJson: { ...manifest, resourceLifecycle: [] } as never }).where(eq(plugins.id, pluginId)),
        () => db.update(plugins).set({ manifestJson: manifest as never }).where(eq(plugins.id, pluginId))],
      [() => db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false }), () => db.delete(pluginCompanySettings).where(eq(pluginCompanySettings.pluginId, pluginId))],
      [() => db.update(agents).set({ lifecycleRequiredPluginIds: [randomUUID()] }).where(eq(agents.id, agentId)),
        () => db.update(agents).set({ lifecycleRequiredPluginIds: [pluginId] }).where(eq(agents.id, agentId))],
      [() => db.update(agents).set({ lifecycleRequiredPluginIds: null }).where(eq(agents.id, agentId)),
        () => db.update(agents).set({ lifecycleRequiredPluginIds: [pluginId] }).where(eq(agents.id, agentId))],
    ];
    for (const [deny, restore] of denials) {
      await deny();
      expect(await same()).toEqual({ status: 403 });
      await restore();
    }
    expect(await accessEvents()).toBe(audited);
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: true });
    expect((await same())!.instanceSecrets).toEqual({ launcher: "third launcher" });
  });

  it("reads runtime identity from a snapshot without waiting for an agent row lock", async () => {
    let locked!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
      await tx.update(agents).set({ lifecycleState: "pausing", lifecycleVersion: 5 }).where(eq(agents.id, agentId));
      await new Promise<void>(resolve => { release = resolve; locked(); });
    });
    await held;
    try {
      const read = pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("identity read waited for the agent lock")), 5_000));
      expect((await Promise.race([read, timeout]))!.agent).toMatchObject({ lifecycleState: "ready", lifecycleVersion: 0 });
    } finally {
      release();
      await writer;
    }
    expect((await pluginAgentRuntimeIdentity(db, pluginId, companyId, agentId))!.agent).toMatchObject({ lifecycleState: "pausing", lifecycleVersion: 5 });
  });

  it("uses the company reporting graph for runtime health data", async () => {
    const [manager] = await db.insert(agents).values({ companyId, name: "Manager" }).returning();
    await db.update(agents).set({ reportsTo: manager.id }).where(eq(agents.id, agentId));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.agent.orgChainHealth?.status).toBe("healthy");
    await db.update(agents).set({ reportsTo: agentId }).where(eq(agents.id, manager.id));
    expect((await pluginAgentRuntimeState(db, pluginId, companyId, agentId))!.agent.orgChainHealth?.status).toBe("invalid_org_chain");
  });

  it("scopes runtime inputs to the enabled owning plugin and returns the current revision", async () => {
    const state = await pluginAgentRuntimeState(db, pluginId, companyId, agentId);
    expect(state).toMatchObject({ revision: String((await events()).at(-1)!.id), agent: { id: agentId }, instructionsEntryFile: "AGENTS.md", instanceSecrets: {} });
    expect(await pluginAgentRuntimeState(db, pluginId, randomUUID(), agentId)).toBeNull();
    await expect(pluginAgentRuntimeState(db, randomUUID(), companyId, agentId)).rejects.toMatchObject({ status: 403 });
    await db.insert(pluginCompanySettings).values({ companyId, pluginId, enabled: false });
    await expect(pluginAgentRuntimeState(db, pluginId, companyId, agentId)).rejects.toMatchObject({ status: 403 });
  });

  it("does not broadcast legacy lifecycle events to runtime listeners", async () => {
    const notifications: string[] = [];
    const listener = await db.$client.listen("paperclip_plugin_lifecycle", payload => { notifications.push(payload); });
    try {
      await db.transaction(async tx => {
        await tx.insert(resourceLifecycleEvents).values({ companyId, resourceType: "project", resourceId: randomUUID(), action: "update" });
        await tx.execute(sql`SELECT pg_notify('paperclip_plugin_lifecycle', 'barrier')`);
      });
      await vi.waitFor(() => expect(notifications).toContain("barrier"));
      expect(notifications).toEqual(["barrier"]);
      await db.update(agents).set({ name: "Notify runtime" }).where(eq(agents.id, agentId));
      await vi.waitFor(() => expect(notifications).toEqual(["barrier", ""]));
    } finally { await listener.unlisten(); }
  });

  it("wakes delivery after a commit on an independent database client, without polling", async () => {
    const other = createDb(externalUrl ?? database.connectionString, { maxConnections: 4 });
    const initialCount = (await events()).length;
    const notifications: string[] = [];
    const createListener = databaseModule.createOwnedDatabaseListener;
    vi.spyOn(databaseModule, "createOwnedDatabaseListener").mockImplementation(owner => {
      const listener = createListener(owner);
      return { listen: (channel, onnotify, onlisten) => listener.listen(channel, payload => {
        notifications.push(payload);
        onnotify(payload);
      }, onlisten), close: () => listener.close() };
    });
    const call = vi.fn(async (_plugin, _method, event) => ({ eventId: event.id, status: "acknowledged" }));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const delivery = registerPluginLifecycleDelivery(coordinator, db, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    try {
      await delivery.ready;
      await vi.waitFor(() => expect(call).toHaveBeenCalled(), { timeout: 5000 });
      const delivered = () => call.mock.calls.filter(call => call[2].companyId === companyId);
      await vi.waitFor(async () => expect((await events()).length).toBeGreaterThan(initialCount), { timeout: 5000 });
      await vi.waitFor(async () => expect(await pluginLifecycleInbox(db, pluginId).list(companyId)).toHaveLength(0), { timeout: 5000 });
      const waitForIdle = () => vi.waitFor(() => {
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      await waitForIdle();
      await other.execute(sql`SELECT pg_notify('paperclip_plugin_lifecycle', 'startup-drained')`);
      await vi.waitFor(() => expect(notifications).toContain("startup-drained"), { timeout: 5000 });
      await waitForIdle();
      let committedEventId: string | undefined;
      await other.transaction(async tx => {
        await tx.update(agents).set({ name: "Independent writer" }).where(eq(agents.id, agentId));
        const [event] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents)
          .where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"), eq(resourceLifecycleEvents.resourceId, agentId)))
          .orderBy(sql`${resourceLifecycleEvents.id} DESC`).limit(1);
        committedEventId = String(event.id);
        expect(delivered().map(call => call[2].id)).not.toContain(committedEventId);
      });
      await vi.waitFor(() => expect(delivered().map(call => call[2].id)).toContain(committedEventId), { timeout: 5000 });
      expect(delivered().find(call => call[2].id === committedEventId)![2]).toMatchObject({ companyId, resourceId: agentId, resourceType: "agent_runtime" });
    } finally { await delivery.dispose(); await coordinator.stop(); await other.$client.end(); }
  });
  it("recovers work committed during real listener connection loss without another write", async () => {
    const target = new URL(externalUrl ?? database.connectionString);
    const upstreamHost = target.hostname; const upstreamPort = Number(target.port);
    let blocked = false;
    const sockets = new Set<Socket>();
    const proxy = createServer(client => {
      if (blocked) { client.destroy(); return; }
      const upstream = connect(upstreamPort, upstreamHost);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on("error", () => { client.destroy(); upstream.destroy(); });
        socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
      }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    target.hostname = "127.0.0.1"; target.port = String((proxy.address() as { port: number }).port);
    const listenerDb = createDb(target.toString(), { connectTimeoutSeconds: 1, maxConnections: 4 });
    const call = vi.fn(async (_plugin, _method, event) => ({ eventId: event.id, status: "acknowledged" }));
    const coordinator = createDeliveryWorkCoordinator({ owner: listenerDb, canRun: () => true, onError: () => {} });
    const delivery = registerPluginLifecycleDelivery(coordinator, listenerDb, { call, isRunning: () => true, onConfigApplied: () => () => {} } as never, new EventEmitter() as never);
    try {
      await delivery.ready;
      const inbox = pluginLifecycleInbox(db, pluginId);
      await vi.waitFor(async () => expect(await inbox.list(companyId, 100, undefined, ["agent_runtime"])).toEqual([]), { timeout: 5000 });
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 5000 });
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await db.update(agents).set({ name: "Changed while disconnected" }).where(eq(agents.id, agentId));
      const queued = (await events()).at(-1)!;
      expect(call.mock.calls.some(call => call[2].id === String(queued.id))).toBe(false);
      blocked = false;
      await vi.waitFor(() => expect(call.mock.calls.some(call => call[2].id === String(queued.id))).toBe(true), { timeout: 10000 });
    } finally {
      blocked = false; await delivery.dispose(); await coordinator.stop(); await listenerDb.$client.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 20000);

});
