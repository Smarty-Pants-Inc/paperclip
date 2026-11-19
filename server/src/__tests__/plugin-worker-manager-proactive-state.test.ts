import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, plugins, pluginState } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import { buildHostServices } from "../services/plugin-host-services.js";
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
  const agentId = randomUUID(), runId = randomUUID();
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
    await db.insert(pluginState).values({ pluginId: otherPluginId, scopeKind: "company", scopeId: companyId,
      namespace: "default", stateKey: "owner", valueJson: "other plugin's state" });
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  }, 30_000);

  async function start(busy = true) {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const agentEntered = new Promise<void>(resolve => { entered = resolve; });
    const observed: { context: WorkerHostCallContext | undefined; origin: ReturnType<typeof currentPluginInteractionOrigin> }[] = [];
    const services = buildHostServices(db, pluginId, manifest.id, createPluginEventBus());
    const handlers = createHostClientHandlers({ pluginId, capabilities: manifest.capabilities, services });
    const handle = createPluginWorkerHandle(pluginId, {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-proactive-state.cjs", import.meta.url)),
      manifest, config: {}, instanceInfo: { instanceId: "proactive-state-test", hostVersion: "1.0.0" }, apiVersion: 1,
      autoRestart: false,
      // Read the same real configuration rows as the production loader does.
      loadProactiveCompanyScopes: async () => (await pluginRegistryService(db).listConfigs(pluginId)).map(row => row.companyId),
      hostHandlers: {
        ...handlers,
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
      observed,
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

  it("does not grant instance state, wildcard state, or a forged invocation id", async () => {
    const worker = await start();
    try {
      await denied(worker.timer("state.set", { scopeKind: "instance", stateKey: "instance", value: true }));
      await denied(worker.timer("state.set", { scopeKind: "company", stateKey: "wildcard", value: true }));
      await denied(worker.timer("state.set", { ...stateKey("forged"), value: true }, "unknown-invocation"));
      // A fake top-level companyId must not disguise an unconfigured state scopeId.
      await denied(worker.timer("state.set", { ...stateKey("disguised", unconfiguredCompanyId), companyId, value: true }));
      expect(worker.observed).toEqual([]);
    } finally { await worker.stop(); }
  });

  it("keeps writes and deletes confined to the calling plugin's own state", async () => {
    const worker = await start();
    try {
      await worker.timer("state.set", { ...stateKey("owner"), pluginId: otherPluginId, value: "own state only" });
      await expect(worker.timer("state.get", stateKey("owner"))).resolves.toBe("own state only");
      await worker.timer("state.delete", stateKey("owner"));
      await expect(worker.timer("state.get", stateKey("owner"))).resolves.toBeNull();
      const other = await db.select().from(pluginState).where(eq(pluginState.pluginId, otherPluginId));
      expect(other).toMatchObject([{ valueJson: "other plugin's state" }]);
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
