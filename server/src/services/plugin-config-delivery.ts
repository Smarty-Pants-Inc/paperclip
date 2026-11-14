import type { Db } from "@paperclipai/db";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerHandle, PluginWorkerManager } from "./plugin-worker-manager.js";

/** A ready event identifies a process, not a reusable worker handle. */
interface ConfigGeneration {
  worker: PluginWorkerHandle;
  delivered: Map<string, { rowId: string; updatedAt: number }>;
  pending: Map<string, Promise<void>>;
}

const deliveries = new WeakMap<PluginWorkerManager, ReturnType<typeof createConfigDelivery>>();

/** Shared by activation, crash replay and settings saves for this manager. */
export function pluginConfigDelivery(db: Db, manager: PluginWorkerManager) {
  let delivery = deliveries.get(manager);
  if (!delivery) {
    delivery = createConfigDelivery(db, manager);
    deliveries.set(manager, delivery);
  }
  return delivery;
}

function createConfigDelivery(db: Db, manager: PluginWorkerManager) {
  const registry = pluginRegistryService(db);
  const generations = new WeakMap<PluginWorkerHandle, ConfigGeneration>();
  const reset = (worker: PluginWorkerHandle): ConfigGeneration => {
    const generation = { worker, delivered: new Map(), pending: new Map() };
    generations.set(worker, generation);
    return generation;
  };
  // Registered before the loader's replay listener, so every ready event
  // invalidates outstanding reads/queues even when the handle is reused.
  manager.onWorkerReady?.((pluginId) => {
    const worker = manager.getWorker(pluginId);
    if (worker) reset(worker);
  });

  function current(pluginId: string): ConfigGeneration | undefined {
    const worker = manager.getWorker(pluginId);
    if (!worker || worker.status !== "running") return undefined;
    return generations.get(worker) ?? reset(worker);
  }

  const isCurrent = (pluginId: string, generation: ConfigGeneration) =>
    manager.getWorker(pluginId) === generation.worker &&
    generation.worker.status === "running" &&
    generations.get(generation.worker) === generation;

  async function deliver(pluginId: string, companyId: string, generation = current(pluginId)): Promise<void> {
    if (!generation || !isCurrent(pluginId, generation)) return;
    const previous = generation.pending.get(companyId);
    const work = (async () => {
      // Serialize only this company: a slow A must not block saving B.
      await previous?.catch(() => {});
      if (!isCurrent(pluginId, generation)) return;
      // List snapshots identify companies only. Re-read the authoritative row
      // after waiting, so saves and deletions during replay are respected.
      const row = await registry.getConfig(pluginId, companyId);
      if (!isCurrent(pluginId, generation) || !row) return;
      const revision = row.updatedAt.getTime();
      const last = generation.delivered.get(companyId);
      if (last?.rowId === row.id && revision <= last.updatedAt) return;
      await manager.call(pluginId, "configChanged", {
        companyId,
        config: (row.configJson ?? {}) as Record<string, unknown>,
      });
      generation.delivered.set(companyId, { rowId: row.id, updatedAt: revision });
    })();
    generation.pending.set(companyId, work);
    try { await work; }
    finally {
      if (generation.pending.get(companyId) === work) generation.pending.delete(companyId);
    }
  }

  return { current, deliver };
}
