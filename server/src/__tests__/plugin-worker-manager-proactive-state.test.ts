import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { runWithRuntimeParent } from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { companies, createDb, plugins, pluginState, pluginLogs } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import { buildHostServices, flushPluginLogBuffer } from "../services/plugin-host-services.js";
import { currentPluginInteractionOrigin } from "../services/plugin-interaction-context.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Trust-boundary regression: real stdio worker, SDK gates, host services and
// persisted plugin state. No Boat code or environment provisioning is involved.
describe("plugin worker proactive state while an agent invocation is active", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const pluginId = randomUUID(), otherPluginId = randomUUID();
  const agentCompanyId = randomUUID(), companyId = randomUUID(), unconfiguredCompanyId = randomUUID();
  const agentId = randomUUID(), runId = randomUUID(), userId = randomUUID();
  // One row per protocol family, including independently governed subfamilies.
  // Each row exercises EVERY registered method in that family, not a sample.
  const families = ["config", "localFolders", "db", "entities", "events", "http", "secrets", "activity",
    "metrics", "telemetry", "log", "span", "companies", "projects", "executionWorkspaces", "projects.managed",
    "routines.managed", "skills.managed", "issues", "issues.relations", "issues.summaries", "issues.documents",
    "approvals", "agents", "agents.managed", "agents.sessions", "goals", "access.members", "access.invites",
    "authorization.grants", "authorization.policies", "authorization.audit"];
  const familyOf = (method: string) => method.includes(".") ? method.slice(0, method.lastIndexOf(".")) : method;
  const manifest: PaperclipPluginManifestV1 = {
    id: "test.proactive-state", apiVersion: 1, version: "1.0.0", displayName: "Proactive state",
    description: "Proactive state authorization regression", author: "Paperclip", categories: ["automation"],
    capabilities: ["companies.read", "plugin.state.read", "plugin.state.write"], entrypoints: { worker: "worker.cjs" },
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-proactive-state-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: agentCompanyId, name: "Active agent company", issuePrefix: "PSA" },
      { id: companyId, name: "Configured company", issuePrefix: "PSB" },
      { id: unconfiguredCompanyId, name: "Not configured", issuePrefix: "PSC" },
    ]);
    for (const id of [pluginId, otherPluginId]) {
      await db.insert(plugins).values({ id, pluginKey: id === pluginId ? manifest.id : "test.other-state",
        packageName: `@test/${id}`, version: "1.0.0", apiVersion: 1, categories: ["automation"],
        manifestJson: manifest, status: "ready", installOrder: 1 });
    }
    await pluginRegistryService(db).upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true } });
    await pluginRegistryService(db).upsertConfig(otherPluginId, companyId, { companyId, configJson: { private: "other plugin" } });
    await db.insert(pluginState).values({ pluginId: otherPluginId, scopeKind: "company", scopeId: companyId,
      namespace: "default", stateKey: "owner", valueJson: "other plugin's state" });
  }, 180_000);

  afterAll(async () => {
    await flushPluginLogBuffer();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  }, 30_000);

  async function start(busy = true) {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const agentEntered = new Promise<void>(resolve => { entered = resolve; });
    let scopeReadsFail = false;
    const observed: { context: WorkerHostCallContext | undefined; origin: ReturnType<typeof currentPluginInteractionOrigin> }[] = [];
    const services = buildHostServices(db, pluginId, manifest.id, createPluginEventBus());
    const handlers = createHostClientHandlers({ pluginId, capabilities: manifest.capabilities, services });
    const dispatched: string[] = [];
    const contexts: { method: string; context: WorkerHostCallContext | undefined }[] = [];
    const streams: { method: string; params: Record<string, unknown> }[] = [];
    const tracedHandlers = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method,
      async (params: never, context?: WorkerHostCallContext) => {
        dispatched.push(method);
        contexts.push({ method, context });
        return handler(params, context);
      }])) as typeof handlers;
    const handle = createPluginWorkerHandle(pluginId, {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-proactive-state.cjs", import.meta.url)),
      manifest, config: {}, instanceInfo: { instanceId: "proactive-state-test", hostVersion: "1.0.0" }, apiVersion: 1,
      autoRestart: false,
      onStreamNotification: (method, params) => { streams.push({ method, params }); },
      // Read the same real configuration rows as the production loader does.
      loadProactiveCompanyScopes: async () => {
        if (scopeReadsFail) throw new Error("scope registry unavailable");
        return (await pluginRegistryService(db).listConfigs(pluginId)).map(row => row.companyId);
      },
      hostHandlers: {
        ...tracedHandlers,
        "companies.get": async (params, context) => {
          if (context?.invocationScope?.agentOrigin) {
            entered();
            await blocked;
          }
          return handlers["companies.get"](params, context);
        },
        "state.set": async (params, context) => {
          // Observe the real dispatch context, not a fixture-supplied actor.
          observed.push({ context, origin: currentPluginInteractionOrigin() });
          return handlers["state.set"](params, context);
        },
      },
    });
    await handle.start();
    const agent = busy ? handle.call("executeTool", { toolName: "hold", parameters: {},
      runContext: { companyId: agentCompanyId, agentId, runId, projectId: randomUUID() } }) : undefined;
    // Attach a rejection handler immediately, including on a failed assertion.
    const agentResult = agent?.then(value => ({ value }), error => ({ error }));
    if (busy) await agentEntered;
    return {
      observed, dispatched, contexts, streams, methods: Object.keys(handlers),
      failScopeReads: () => { scopeReadsFail = true; },
      keeper: (params: Record<string, unknown>) => runWithRuntimeParent(trace.setSpanContext(ROOT_CONTEXT, {
        traceId: "12345678901234567890123456789012", spanId: "1234567890123456", traceFlags: 1,
      }), () => handle.call("executeTool", { toolName: "keeper", parameters: params,
        runContext: { companyId, agentId, runId, projectId: randomUUID() } })),
      resume: (invocationId: string, operations: { method: string; params: Record<string, unknown> }[]) =>
        handle.call("getData", { key: "keeper-resume", params: { invocationId, operations } }),
      notify: (method: string, params: Record<string, unknown>, invocationId?: string) =>
        handle.call("getData", { key: "notification", params: { method, params, invocationId } }),
      agentRead: (params: Record<string, unknown>) => handle.call("executeTool", { toolName: "read-state", parameters: params,
        runContext: { companyId, agentId, runId, projectId: randomUUID() } }),
      personRead: (params: Record<string, unknown>) => handle.call("performAction", { key: "read-state", params,
        actorContext: { companyId, type: "user", userId, agentId: null, runId: null } }),
      timer: (method: string, params: Record<string, unknown>, invocationId?: string) =>
        handle.call("getData", { key: "timer", params: { method, params, invocationId } }),
      async stop() {
        release();
        try {
          const result = await agentResult;
          if (result && "error" in result) throw result.error;
        } finally { await handle.stop(); }
      },
    };
  }

  const stateKey = (key: string, scopeId = companyId) => ({ scopeKind: "company", scopeId, stateKey: key });
  const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
  const rows = (scopeId: string, key: string) => db.select().from(pluginState).where(and(
    eq(pluginState.pluginId, pluginId), eq(pluginState.scopeId, scopeId), eq(pluginState.stateKey, key)));

  type Keeper = { invocation: { id: string; traceparent: string; scope: { companyId: string } }; before: unknown };

  it("continues keeper state work after its hook ends without laundering identity or trace", async () => {
    const worker = await start();
    try {
      const key = stateKey("ended-keeper");
      const ended = await worker.keeper(key) as unknown as Keeper;
      expect(ended.invocation.traceparent).toBe("00-12345678901234567890123456789012-1234567890123456-01");
      // The read before the hook returns is genuinely LIVE and retains its scope.
      expect(worker.contexts.at(-1)).toMatchObject({ method: "state.get", context: {
        invocationScope: { companyId, agentOrigin: { agentId, runId } }, traceparent: ended.invocation.traceparent,
      } });
      await expect(worker.resume(ended.invocation.id, [
        { method: "state.set", params: { ...key, value: { ready: true } } },
        { method: "state.get", params: key },
      ])).resolves.toEqual([null, { ready: true }]);
      expect(worker.observed).toEqual([{ context: { invocationScope: { companyId } }, origin: undefined }]);
      expect(worker.contexts.findLast(row => row.method === "state.get")).toEqual({ method: "state.get", context: { invocationScope: { companyId } } });
      expect(await rows(companyId, "ended-keeper")).toMatchObject([{ pluginId, valueJson: { ready: true } }]);
      await flushPluginLogBuffer();
      const audit = await db.select().from(pluginLogs).where(and(eq(pluginLogs.pluginId, pluginId), eq(pluginLogs.companyId, companyId)));
      expect(audit).toContainEqual(expect.objectContaining({ message: "Plugin state call with host-derived scope",
        meta: { method: "state.set", scopeSource: "host-derived scope", actorType: "plugin", actorId: pluginId } }));
      console.info("ended keeper proof", { ended: ended.invocation, contexts: worker.contexts, observed: worker.observed,
        persisted: await rows(companyId, "ended-keeper"), audit });
      await expect(worker.timer("state.delete", key, ended.invocation.id)).resolves.toBeNull();
      expect(await rows(companyId, "ended-keeper")).toEqual([]);
    } finally { await worker.stop(); }
  });

  it("reads only its own configured-company config with untagged, ended and unknown ids", async () => {
    const worker = await start();
    try {
      const ended = await worker.keeper(stateKey("config-hook")) as unknown as Keeper;
      await expect(worker.resume(ended.invocation.id, [{ method: "config.get", params: { companyId } }]))
        .resolves.toEqual([{ enabled: true }]);
      for (const id of [undefined, ended.invocation.id, "unknown-config-id"]) {
        await expect(worker.timer("config.get", { companyId }, id)).resolves.toEqual({ enabled: true });
        expect(worker.contexts.findLast(row => row.method === "config.get")).toEqual({ method: "config.get", context: { invocationScope: { companyId } } });
        await denied(worker.timer("config.get", { companyId, pluginId: otherPluginId }, id));
        await denied(worker.timer("config.get", { companyId: unconfiguredCompanyId }, id));
      }
      await flushPluginLogBuffer();
      const configAudit = await db.select().from(pluginLogs).where(and(eq(pluginLogs.pluginId, pluginId), eq(pluginLogs.companyId, companyId)));
      expect(configAudit).toContainEqual(expect.objectContaining({ message: "Plugin config call with host-derived scope",
        meta: { method: "config.get", scopeSource: "host-derived scope", actorType: "plugin", actorId: pluginId } }));
    } finally { await worker.stop(); }
  });

  it("refuses ended-id company and plugin spoofing before state dispatch", async () => {
    const worker = await start();
    try {
      const ended = await worker.keeper(stateKey("denied-hook")) as unknown as Keeper;
      await worker.resume(ended.invocation.id, []);
      for (const method of ["state.get", "state.set", "state.delete"]) {
        for (const params of [
          { ...stateKey("ended-other"), pluginId: otherPluginId },
          stateKey("ended-other", unconfiguredCompanyId),
          { ...stateKey("ended-other"), companyId: unconfiguredCompanyId },
          { scopeKind: "agent", scopeId: agentId, stateKey: "ended-other" },
          { scopeKind: "instance", stateKey: "ended-other" },
        ]) await denied(worker.timer(method, { ...params, value: true }, ended.invocation.id));
      }
      expect(worker.observed).toEqual([]);
      expect(await rows(companyId, "ended-other")).toEqual([]);
      expect(await db.select().from(pluginState).where(eq(pluginState.pluginId, otherPluginId)))
        .toMatchObject([{ valueJson: "other plugin's state" }]);
    } finally { await worker.stop(); }
  });

  it.each(families)("refuses every ended-id method in the %s family before dispatch", async family => {
    const worker = await start();
    try {
      const ended = await worker.keeper(stateKey("family-hook")) as unknown as Keeper;
      await worker.resume(ended.invocation.id, []);
      const methods = worker.methods.filter(method => familyOf(method) === family && method !== "config.get");
      // config's only method is the explicitly permitted own-config read.
      if (family === "config") {
        await denied(worker.timer("config.get", { companyId, pluginId: otherPluginId }, ended.invocation.id));
      }
      for (const method of methods) {
        const before = worker.dispatched.length;
        await denied(worker.timer(method, { companyId, scopeKind: "company", scopeId: companyId,
          stateKey: "ended-family", filter: { companyId } }, ended.invocation.id));
        expect(worker.dispatched.slice(before), method).toEqual([]);
      }
      console.info("ended family proof", { family, methods, result: "INVOCATION_SCOPE_DENIED before dispatch" });
    } finally { await worker.stop(); }
  });

  it("refreshes ended-id state and config authority and fails closed on a registry error", async () => {
    const worker = await start();
    const registry = pluginRegistryService(db);
    try {
      const ended = await worker.keeper(stateKey("refresh-hook")) as unknown as Keeper;
      await worker.resume(ended.invocation.id, []);
      await worker.timer("state.set", { ...stateKey("refresh-ended"), value: "preserved" }, ended.invocation.id);
      await registry.deleteConfig(pluginId, companyId);
      for (const method of ["state.get", "state.set", "state.delete", "config.get"]) {
        await denied(worker.timer(method, { ...stateKey("refresh-ended"), companyId, value: "revoked" }, ended.invocation.id));
      }
      expect(await rows(companyId, "refresh-ended")).toMatchObject([{ valueJson: "preserved" }]);
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true } });
      await expect(worker.timer("config.get", { companyId }, ended.invocation.id)).resolves.toEqual({ enabled: true });
      worker.failScopeReads();
      for (const method of ["state.get", "state.set", "state.delete", "config.get"]) {
        await denied(worker.timer(method, { ...stateKey("refresh-ended"), companyId, value: "unverified" }, ended.invocation.id));
      }
      expect(await rows(companyId, "refresh-ended")).toMatchObject([{ valueJson: "preserved" }]);
    } finally {
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true } });
      await worker.stop();
    }
  });

  it("drops ended-id streams notifications even after all agent invocations end", async () => {
    const worker = await start(false);
    try {
      const ended = await worker.keeper(stateKey("idle-ended-hook")) as unknown as Keeper;
      await worker.resume(ended.invocation.id, []);
      for (const method of ["streams.open", "streams.emit", "streams.close"]) {
        await worker.notify(method, { companyId, channel: "ended", event: {} }, ended.invocation.id);
        expect(worker.streams).toEqual([]);
      }
      await denied(worker.timer("companies.get", { companyId }, ended.invocation.id));
    } finally { await worker.stop(); }
  });

  it("accepts a configured company's timer write with plugin-only scope, never the active agent's origin", async () => {
    const worker = await start();
    try {
      await expect(worker.timer("state.set", { ...stateKey("busy"), value: { ready: true } })).resolves.toBeNull();
      expect(await rows(companyId, "busy")).toMatchObject([{ pluginId, scopeKind: "company", scopeId: companyId, valueJson: { ready: true } }]);
      expect(worker.observed).toEqual([{ context: { invocationScope: { companyId } }, origin: undefined }]);
      expect(currentPluginInteractionOrigin()).toBeUndefined();
      await expect(worker.timer("state.get", stateKey("busy"))).resolves.toEqual({ ready: true });
      console.info("proactive state proof", { pluginId, companyId, context: worker.observed[0]?.context,
        agentOrigin: worker.observed[0]?.origin ?? null, persisted: await rows(companyId, "busy") });
    } finally { await worker.stop(); }
  });

  it("refuses state writes to an unconfigured company before they reach the state store", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("state.set", { ...stateKey("denied", unconfiguredCompanyId), value: true }));
      expect(await rows(unconfiguredCompanyId, "denied")).toEqual([]);
      expect(worker.observed).toEqual([]);
    } finally { await worker.stop(); }
  });

  it("still refuses non-state calls without an invocation id during an agent invocation", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("companies.get", { companyId }));
    } finally { await worker.stop(); }
  });

  it("does not grant instance or wildcard state, and treats unknown ids as untagged", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("state.set", { scopeKind: "instance", stateKey: "instance", value: true }));
      await denied(worker.timer("state.set", { scopeKind: "company", stateKey: "wildcard", value: true }));
      await expect(worker.timer("state.get", stateKey("unknown"), "unknown-invocation")).resolves.toBeNull();
      await denied(worker.timer("state.set", { ...stateKey("forged", unconfiguredCompanyId), value: true }, "unknown-invocation"));
      // A fake top-level companyId must not disguise an unconfigured state scopeId.
      await denied(worker.timer("state.set", { ...stateKey("disguised", unconfiguredCompanyId), companyId, value: true }));
      expect(worker.observed).toEqual([]);
    } finally { await worker.stop(); }
  });

  it("refuses reading another plugin's state even when its pluginId and namespace are supplied", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("state.get", { ...stateKey("owner"), pluginId: otherPluginId }));
      await denied(worker.timer("state.get", { ...stateKey("owner"), pluginId: otherPluginId,
        namespace: otherPluginId }));
      expect(await db.select().from(pluginState).where(eq(pluginState.pluginId, otherPluginId)))
        .toMatchObject([{ valueJson: "other plugin's state" }]);
    } finally { await worker.stop(); }
  });

  it("keeps writes and deletes confined to the calling plugin's own state", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("state.set", { ...stateKey("owner"), pluginId: otherPluginId, value: "not authorized" }));
      await denied(worker.timer("state.delete", { ...stateKey("owner"), pluginId: otherPluginId }));
      await worker.timer("state.set", { ...stateKey("owner"), value: "own state only" });
      const afterWrite = await db.select().from(pluginState).where(eq(pluginState.pluginId, otherPluginId));
      expect(afterWrite).toMatchObject([{ valueJson: "other plugin's state" }]);
      await expect(worker.timer("state.get", stateKey("owner"))).resolves.toBe("own state only");
      await worker.timer("state.delete", stateKey("owner"));
      await expect(worker.timer("state.get", stateKey("owner"))).resolves.toBeNull();
      const other = await db.select().from(pluginState).where(eq(pluginState.pluginId, otherPluginId));
      expect(other).toMatchObject([{ valueJson: "other plugin's state" }]);
    } finally { await worker.stop(); }
  });

  it.each(families)("refuses every untagged method in the %s family before dispatch", async family => {
    const worker = await start();
    try {
      const actualFamilies = [...new Set(worker.methods.filter(method => !method.startsWith("state.")).map(familyOf))].sort();
      expect(actualFamilies).toEqual([...families].sort());
      const methods = worker.methods.filter(method => familyOf(method) === family);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        const before = worker.dispatched.length;
        await denied(worker.timer(method, { companyId, scopeKind: "company", scopeId: companyId,
          stateKey: "untagged", filter: { companyId }, ...(method === "config.get" ? { pluginId: otherPluginId } : {}) }));
        expect(worker.dispatched.slice(before), method).toEqual([]);
      }
      console.info("untagged family proof", { family, methods, result: "INVOCATION_SCOPE_DENIED before dispatch" });
    } finally { await worker.stop(); }
  });

  it("refuses every untagged method in the streams notification family before delivery", async () => {
    const worker = await start();
    try {
      for (const method of ["streams.open", "streams.emit", "streams.close"]) {
        await worker.notify(method, { companyId, channel: "untagged", event: { private: true } });
        expect(worker.streams, method).toEqual([]);
      }
      console.info("untagged family proof", { family: "streams notifications", result: "dropped before delivery" });
    } finally { await worker.stop(); }
  });

  it("keeps a host-derived write plugin-owned on later agent and person reads, with a host-derived scope audit", async () => {
    const worker = await start();
    try {
      const key = stateKey("provenance");
      const audit = () => db.select().from(pluginLogs).where(and(eq(pluginLogs.pluginId, pluginId), eq(pluginLogs.companyId, companyId)));
      await flushPluginLogBuffer();
      const previousLogIds = new Set((await audit()).map(row => row.id));
      const newWrites = async () => (await audit()).filter(row => !previousLogIds.has(row.id) && row.meta?.method === "state.set");
      await worker.timer("state.set", { ...key, value: { keeper: true }, actorType: "user", actorId: userId, agentId });
      expect(worker.observed).toEqual([{ context: { invocationScope: { companyId } }, origin: undefined }]);
      await flushPluginLogBuffer();
      const writes = await newWrites();
      expect(writes).toHaveLength(1);
      expect(writes).toContainEqual(expect.objectContaining({ message: "Plugin state call with host-derived scope",
        meta: { method: "state.set", scopeSource: "host-derived scope", actorType: "plugin", actorId: pluginId } }));
      const saved = await rows(companyId, "provenance");
      expect(saved).toMatchObject([{ pluginId, scopeKind: "company", scopeId: companyId, valueJson: { keeper: true } }]);
      expect(Object.keys(saved[0]).sort()).toEqual(["id", "pluginId", "scopeKind", "scopeId", "namespace", "stateKey", "valueJson", "updatedAt"].sort());
      // These are real host-issued agent and user invocations, not forged RPC ids.
      // A scoped consumer can read plugin company data, but does not become its author.
      await expect(worker.agentRead(key)).resolves.toEqual({ keeper: true });
      await expect(worker.personRead(key)).resolves.toEqual({ keeper: true });
      await expect(worker.agentRead({ ...key, scopeKind: "agent", scopeId: agentId })).resolves.toBeNull();
      await flushPluginLogBuffer();
      expect(await rows(companyId, "provenance")).toEqual(saved);
      expect(await newWrites()).toEqual(writes);
      expect(worker.observed).toEqual([{ context: { invocationScope: { companyId } }, origin: undefined }]);
      console.info("later scoped read provenance proof", { saved, writes, agentRead: "same plugin value; no author promotion",
        personRead: "same plugin value; no author promotion", agentNamespaceRead: null });
    } finally { await worker.stop(); }
  });

  it("refuses a named other company even when the state scope implies the configured company", async () => {
    const worker = await start();
    try {
      for (const method of ["state.get", "state.set", "state.delete"]) {
        await denied(worker.timer(method, { ...stateKey("direct-other", unconfiguredCompanyId), value: true }));
        await denied(worker.timer(method, { ...stateKey("named-other"), companyId: unconfiguredCompanyId, value: true }));
        await denied(worker.timer(method, { ...stateKey("implied-other", unconfiguredCompanyId), companyId, value: true }));
      }
      expect(await rows(companyId, "named-other")).toEqual([]);
      expect(await rows(unconfiguredCompanyId, "implied-other")).toEqual([]);
    } finally { await worker.stop(); }
  });

  it("revokes proactive state authority when the stored company configuration is removed", async () => {
    const worker = await start();
    const registry = pluginRegistryService(db);
    try {
      await worker.timer("state.set", { ...stateKey("revoked"), value: "before removal" });
      await registry.deleteConfig(pluginId, companyId);
      await denied(worker.timer("state.set", { ...stateKey("revoked"), value: "after removal" }));
      await denied(worker.timer("state.get", stateKey("revoked")));
      await denied(worker.timer("state.delete", stateKey("revoked")));
      expect(await rows(companyId, "revoked")).toMatchObject([{ valueJson: "before removal" }]);
      expect(worker.observed).toHaveLength(1);
    } finally {
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true } });
      await worker.stop();
    }
  });

  it("keeps existing idle plugin-local namespaces without granting them to stale ids", async () => {
    const worker = await start(false);
    try {
      const ended = await worker.keeper(stateKey("idle-local-hook")) as unknown as Keeper;
      await worker.resume(ended.invocation.id, []);
      for (const scopeKind of ["instance", "agent"]) {
        const key = { scopeKind, stateKey: "idle-local", ...(scopeKind === "agent" ? { scopeId: agentId } : {}) };
        await worker.timer("state.set", { ...key, value: "existing idle authority" });
        await expect(worker.timer("state.get", key)).resolves.toBe("existing idle authority");
        await worker.timer("state.delete", key);
        for (const id of [ended.invocation.id, "unknown-local-id"]) {
          for (const method of ["state.get", "state.set", "state.delete"]) {
            await denied(worker.timer(method, { ...key, value: "not authorized" }, id));
          }
        }
      }
    } finally { await worker.stop(); }
  });

  it("leaves the idle-server proactive state and non-state behavior unchanged", async () => {
    const worker = await start(false);
    try {
      await worker.timer("state.set", { ...stateKey("idle"), value: "idle" });
      await expect(worker.timer("state.get", stateKey("idle"))).resolves.toBe("idle");
      await expect(worker.timer("companies.get", { companyId })).resolves.toMatchObject({ id: companyId });
      await denied(worker.timer("state.set", { ...stateKey("idle-denied", unconfiguredCompanyId), value: true }));
      await denied(worker.timer("state.set", { ...stateKey("idle-disguised", unconfiguredCompanyId), companyId, value: true }));
      expect(await rows(unconfiguredCompanyId, "idle-disguised")).toEqual([]);
    } finally { await worker.stop(); }
  });
});
