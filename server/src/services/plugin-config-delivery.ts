import type { Db } from "@paperclipai/db";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerHandle, PluginWorkerManager } from "./plugin-worker-manager.js";

interface CompanyDelivery {
  active: Promise<void>;
  next?: Promise<void>;
}

/** A ready event identifies a process, not a reusable worker handle. */
interface ConfigGeneration {
  worker: PluginWorkerHandle;
  delivered: Map<string, { rowId: string; updatedAt: number }>;
  pending: Map<string, CompanyDelivery>;
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

  async function apply(pluginId: string, companyId: string, generation: ConfigGeneration): Promise<void> {
    if (!isCurrent(pluginId, generation)) return;
    // Read only when admitted work starts, never from an old list snapshot.
    const row = await registry.getConfig(pluginId, companyId);
    if (!isCurrent(pluginId, generation) || !row) return;
    const revision = row.updatedAt.getTime();
    const last = generation.delivered.get(companyId);
    if (last?.rowId === row.id && revision <= last.updatedAt) return;
    await manager.call(pluginId, "configChanged", {
      companyId,
      revision,
      config: (row.configJson ?? {}) as Record<string, unknown>,
    });
    if (isCurrent(pluginId, generation)) {
      generation.delivered.set(companyId, { rowId: row.id, updatedAt: revision });
    }
  }

  function deliver(pluginId: string, companyId: string, generation = current(pluginId)): Promise<void> {
    if (!generation || !isCurrent(pluginId, generation)) return Promise.resolve();
    const target = generation;
    const previous = target.pending.get(companyId);
    if (previous) {
      // One active operation and at most one successor per company. All callers
      // arriving before that successor starts share its fresh authoritative read,
      // including under failure; do not retain a promise chain per request.
      if (previous.next) return previous.next;
      previous.next = previous.active.catch(() => {}).then(() => {
        previous.next = undefined;
        return start(previous);
      });
      return previous.next;
    }
    const entry: CompanyDelivery = { active: Promise.resolve() };
    target.pending.set(companyId, entry);
    return start(entry);

    function start(entry: CompanyDelivery): Promise<void> {
      const work = apply(pluginId, companyId, target);
      entry.active = work;
      const cleanup = () => {
        if (!entry.next && target.pending.get(companyId) === entry) {
          target.pending.delete(companyId);
        }
      };
      // Use both settlement handlers: a rejected delivery is not applied, and
      // cleanup must not create an unobserved rejected finally() promise.
      void work.then(cleanup, cleanup);
      return work;
    }
  }

  return { current, deliver };
}
