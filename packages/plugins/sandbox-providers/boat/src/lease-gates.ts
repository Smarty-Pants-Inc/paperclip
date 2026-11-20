import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginDefinition } from "@paperclipai/plugin-sdk";

// Daytona plugin.ts:1520-1692: scoped ref-counted activity/teardown gates and
// admission state. Boat has no SDK handle/session cache, so gate the public
// hooks and check admission before each side-effecting HTTP call instead.
type Gate = { promise: Promise<void>; release(): void; refCount: number };
function gateStore() {
  const gates = new Map<string, Gate>();
  return {
    current: (key: string) => gates.get(key),
    idle: async () => { await Promise.all([...gates.values()].map(gate => gate.promise)); },
    begin(key: string): Gate {
      const existing = gates.get(key);
      if (existing) { existing.refCount++; return existing; }
      let release!: () => void;
      const gate = { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release(), refCount: 1 };
      gates.set(key, gate); return gate;
    },
    end(key: string, gate: Gate) { if (--gate.refCount > 0) return; if (gates.get(key) === gate) gates.delete(key); gate.release(); },
  };
}
const activity = gateStore(), teardown = gateStore();
const admission = new Map<string, { closed: boolean; revision: number }>();
const current = new AsyncLocalStorage<{ key: string; revision: number; allowClosed: boolean }>();
function state(key: string) { return admission.get(key) ?? { closed: false, revision: 0 }; }
function close(key: string) { admission.set(key, { closed: true, revision: state(key).revision + 1 }); }
function open(key: string) { admission.set(key, { closed: false, revision: state(key).revision }); }
async function boundedWait(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Boat lease activity did not drain within 30 seconds; retry the exact lease.")), 30_000); })]); }
  finally { clearTimeout(timer); }
}
export function assertBoatActivityAdmission(): void {
  const operation = current.getStore();
  if (!operation) return;
  const now = state(operation.key);
  if (now.revision !== operation.revision || (!operation.allowClosed && now.closed)) throw new Error("Boat sandbox lease is no longer active.");
}
export async function withBoatLeaseActivity<T>(key: string, fn: () => Promise<T>, allowClosed = false): Promise<T> {
  while (true) {
    if (!allowClosed && state(key).closed) throw new Error("Boat sandbox lease is no longer active.");
    const stopping = teardown.current(key);
    if (stopping) { await boundedWait(stopping.promise); continue; }
    const gate = activity.begin(key);
    try {
      if (teardown.current(key)) continue;
      return await current.run({ key, revision: state(key).revision, allowClosed }, fn);
    } finally { activity.end(key, gate); }
  }
}
export function gateBoatHooks(definition: PluginDefinition, keyFor: (params: any, id: string) => string): PluginDefinition {
  const result = { ...definition };
  const syncActivity = gateStore();
  const sync = new Set(["onEnvironmentSyncIn", "onEnvironmentSyncOut"]);
  let shuttingDown = false;
  const active = new Set(["onEnvironmentExecute", "onEnvironmentSyncIn", "onEnvironmentSyncOut", "onEnvironmentRealizeWorkspace", "onEnvironmentRunnerIngressEndpoint"]);
  const terminal = new Set(["onEnvironmentReleaseLease", "onEnvironmentStopLease", "onEnvironmentDestroyLease"]);
  for (const [name, hook] of Object.entries(definition)) {
    if (typeof hook !== "function") continue;
    if (!active.has(name) && !terminal.has(name) && name !== "onEnvironmentAcquireLease" && name !== "onEnvironmentResumeLease" && name !== "setup" && name !== "onShutdown") continue;
    Object.defineProperty(result, name, { enumerable: true, value: async (params: any) => {
      const invoke = async (): Promise<any> => Reflect.apply(hook, definition, [params]);
      if (name === "setup") { shuttingDown = false; return invoke(); }
      if (name === "onShutdown") {
        shuttingDown = true;
        await boundedWait(syncActivity.idle());
        return invoke();
      }
      if (sync.has(name) && shuttingDown) throw new Error("Boat provider is shutting down");
      if (name === "onEnvironmentAcquireLease") {
        const lease = await invoke(); if (lease.providerLeaseId) open(keyFor(params, lease.providerLeaseId)); return lease;
      }
      const id = params.providerLeaseId ?? params.lease?.providerLeaseId;
      if (!id) return invoke();
      const key = keyFor(params, id);
      if (terminal.has(name)) {
        const gate = teardown.begin(key); close(key);
        try {
          // Stop must still cancel commands promptly, but never archive while a
          // sync hook owns transfer/staging state. Closing admission above
          // prevents new sync calls and fences further sends by admitted calls.
          const transferring = syncActivity.current(key);
          if (transferring) await boundedWait(transferring.promise);
          if (name !== "onEnvironmentStopLease" && !params.cancelActiveWork) {
            const running = activity.current(key); if (running) await boundedWait(running.promise);
          }
          return await invoke();
        } finally { teardown.end(key, gate); }
      }
      if (name === "onEnvironmentResumeLease") {
        if (state(key).closed && activity.current(key)) throw new Error("The stopped Boat sandbox is still settling cancelled work. Retry shortly.");
        return withBoatLeaseActivity(key, async () => { const lease = await invoke(); assertBoatActivityAdmission(); if (lease.providerLeaseId) open(key); return lease; }, true);
      }
      return withBoatLeaseActivity(key, async () => {
        if (!sync.has(name)) return invoke();
        const gate = syncActivity.begin(key);
        try { return await invoke(); } finally { syncActivity.end(key, gate); }
      });
    } });
  }
  return result;
}
