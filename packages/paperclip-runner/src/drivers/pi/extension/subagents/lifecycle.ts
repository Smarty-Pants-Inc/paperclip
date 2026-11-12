import { randomUUID } from "node:crypto";
import * as defaultSeam from "./seam.js";
import type { ParkReady, StoppedChildren, SubagentSeam } from "./seam.js";

export const SESSION_LIVENESS_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const storeKey = Symbol.for("paperclip.pi.session-liveness.providers.v1");
export interface LivenessProvider { name: string; sessionId: string; isActive(): boolean }
export interface LivenessRegistry { version: 1; register(provider: LivenessProvider): () => void }
type ObservedRegistry = LivenessRegistry & { [storeKey]: Set<LivenessProvider> };
const globals = globalThis as unknown as Record<symbol, unknown>;
export interface SubagentEventBus {
  on(name: string, fn: (data: unknown) => void): () => void;
  emit(name: string, data: unknown): void;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

/** Install BEFORE pi-subagents session_start. Never wrap/overwrite another host's registry:
 * its register-only protocol cannot reveal pre-existing providers, so an opaque registry blocks.
 */
function livenessRegistry(): unknown {
  if (globals[SESSION_LIVENESS_KEY] === undefined) {
    const providers = new Set<LivenessProvider>();
    const registry: ObservedRegistry = { version: 1, [storeKey]: providers,
      register(provider) {
        if (!provider || typeof provider.name !== "string" || typeof provider.sessionId !== "string" || typeof provider.isActive !== "function") throw new Error("Invalid session-liveness provider.");
        providers.add(provider); return () => { providers.delete(provider); };
      },
    };
    globals[SESSION_LIVENESS_KEY] = registry;
  }
  return globals[SESSION_LIVENESS_KEY];
}

export function createSubagentLifecycle(input: {
  sessionId: string;
  events: SubagentEventBus;
  /** Pi's own parent abort stops attached foreground work. Host fences admission FIRST.
   * Resolve only when parent abort has been awaited; signal bounds the active stop operation.
   */
  abortParent(signal: AbortSignal): void | Promise<void>;
  seam?: Pick<SubagentSeam, "registerParkReadyContributor" | "registerStopChildren">;
  timeoutMs?: number;
  rpcTimeoutMs?: number;
}) {
  if (!input.sessionId) throw new Error("A session-qualified child lifecycle is required.");
  const registry = livenessRegistry();
  const lifetime = new AbortController();
  let stopping: Promise<StoppedChildren> | undefined;
  let uncertainty: string[] = [];
  const liveness = (): ParkReady => {
    const reasons: string[] = [];
    if (lifetime.signal.aborted) reasons.push("lifecycle-disposed");
    if (globals[SESSION_LIVENESS_KEY] !== registry) reasons.push("liveness-registry-replaced");
    const observable = registry as Partial<ObservedRegistry> | null;
    if (!observable || observable.version !== 1 || !(observable[storeKey] instanceof Set)) reasons.push("liveness-registry-unobservable");
    const providers = observable?.[storeKey] instanceof Set ? [...observable[storeKey]].filter(p => p.sessionId === input.sessionId) : [];
    if (!providers.some(p => p.name === "pi-subagents")) reasons.push("pi-subagents-liveness-unregistered");
    for (const provider of providers) {
      try { if (provider.isActive() !== false) reasons.push(`active:${provider.name}`); }
      catch { reasons.push(`unavailable:${provider.name}`); }
    }
    return { ready: reasons.length === 0, reasons };
  };
  const parkReady = (): ParkReady => {
    const state = liveness();
    const reasons = [...state.reasons, ...uncertainty.map(id => `stop-uncertain:${id}`), ...(stopping ? ["children-stopping"] : [])];
    return { ready: reasons.length === 0, reasons };
  };

  // Subscribe before emit. Timers bound active requests only; no idle polling/reconnect loop.
  const rpc = (method: "status" | "stop", params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (finished) return;
      finished = true; off?.(); clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error("Subagent RPC aborted or timed out."));
    off = input.events.on(`subagents:rpc:v1:reply:${requestId}`, raw => {
      const reply = object(raw);
      if (reply.version !== 1 || reply.requestId !== requestId) return;
      if (reply.success !== true) finish(new Error("Subagent RPC refused."));
      else finish(undefined, object(reply.data));
    });
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, input.rpcTimeoutMs ?? 3000);
    if (signal.aborted) { abort(); return; }
    try { input.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });

  async function performStop(signal?: AbortSignal): Promise<StoppedChildren> {
    const timeout = new AbortController();
    const active = AbortSignal.any([lifetime.signal, timeout.signal, ...(signal ? [signal] : [])]);
    const deadline = setTimeout(() => timeout.abort(), input.timeoutMs ?? 5000);
    const targets = new Map<string, { instance?: string; observed: boolean; stopSent: boolean; instanceChanged?: boolean }>();
    const blockers = new Set<string>();
    const proofs = new Map<string, Record<string, unknown>>();
    let revision = 0;
    const wakes = new Set<() => void>();
    const changed = () => { revision++; for (const wake of [...wakes]) wake(); };
    const subscriptions = [
      input.events.on("subagent:process-terminal", raw => {
        const proof = object(raw);
        if (proof.version === 1 && typeof proof.runId === "string") proofs.set(proof.runId, proof);
        changed();
      }),
      ...["async-started", "async-complete", "child-status", "jobs-changed"].map(name => input.events.on(`subagent:${name}`, changed)),
    ];
    const waitForChange = (prior: number) => new Promise<void>(resolve => {
      const done = () => { wakes.delete(done); active.removeEventListener("abort", done); resolve(); };
      wakes.add(done); active.addEventListener("abort", done, { once: true });
      if (revision !== prior || active.aborted) done();
    });
    const observe = (id: string, raw: unknown, targeted: boolean) => {
      const target = targets.get(id)!;
      const proof = object(raw);
      if (proof.version !== 1 || proof.runId !== id || typeof proof.runnerProcessInstanceId !== "string" || !proof.runnerProcessInstanceId) return;
      if (target.instance && target.instance !== proof.runnerProcessInstanceId) {
        if (targeted) { target.instanceChanged = true; target.observed = false; }
        return;
      }
      if (target.instanceChanged) return;
      if (!target.instance && targeted) target.instance = proof.runnerProcessInstanceId;
      if (target.instance === proof.runnerProcessInstanceId && proof.state === "observed") target.observed = true;
    };
    const targetedStatus = async (id: string) => {
      try {
        const status = await rpc("status", { id }, active);
        observe(id, object(object(status.details).lifecycleStatus).processTerminal, true);
      } catch { /* An event may still prove this exact instance; no ACK becomes settlement. */ }
      observe(id, proofs.get(id), false);
    };
    try {
      // Bound even an uncooperative abort callback; a timeout remains uncertainty, never success.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Parent abort not confirmed before deadline."));
        active.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          if (active.aborted) throw new Error("Parent abort canceled.");
          return input.abortParent(active);
        }).then(resolve, reject).finally(() => active.removeEventListener("abort", abort));
        if (active.aborted) abort();
      });
      do {
        const prior = revision;
        const status = await rpc("status", {}, active);
        const snapshot = object(status.asyncSnapshot), omitted = object(snapshot.omitted);
        if (snapshot.version !== 1 || snapshot.kind !== "pi-subagents.async-status-snapshot" || !Array.isArray(snapshot.runs)) {
          blockers.add("async-snapshot-unavailable"); break;
        }
        // 0.88.0 status has NO cursor/page contract (rpc.js:604-631). Do not invent offsets:
        // stop visible roots, but retain omitted roots/children/bytes as explicit uncertainty.
        if (omitted.runs !== 0 || omitted.children !== 0 || omitted.byteLimitExceeded !== false) blockers.add("async-snapshot-incomplete");
        for (const raw of snapshot.runs) {
          const run = object(raw);
          if (typeof run.id !== "string" || !run.id) { blockers.add("async-run-identity-missing"); continue; }
          if (!targets.has(run.id)) targets.set(run.id, { observed: false, stopSent: false });
        }
        // One unavailable target must not withhold stop delivery to the other async roots.
        await Promise.all([...targets].map(async ([id, target]) => {
          await targetedStatus(id); // Pin runner instance before stop/events can race it.
          if (!target.stopSent && !active.aborted) {
            target.stopSent = true;
            try { await rpc("stop", { id }, active); }
            catch { /* Accepted/failed stop is not terminal proof either way. */ }
            await targetedStatus(id);
          }
          observe(id, proofs.get(id), false);
        }));
        if ([...targets.values()].every(target => target.observed) && liveness().ready) break;
        if (blockers.size) break;
        await waitForChange(prior);
      } while (!active.aborted);
    } catch { blockers.add("child-stop-unconfirmed"); }
    finally {
      clearTimeout(deadline); subscriptions.forEach(off => off());
      for (const wake of [...wakes]) wake();
    }
    const settled = [...targets].filter(([, target]) => target.observed).map(([id]) => id);
    const uncertain = [...targets].filter(([, target]) => !target.observed).map(([id]) => id);
    if (!liveness().ready) blockers.add("session-liveness");
    // If an active stop was canceled, even an otherwise empty/idle snapshot is not a stop proof.
    if (active.aborted && !uncertain.length && !blockers.size) blockers.add("child-stop-canceled");
    return { settled, uncertain: [...uncertain, ...blockers] };
  }
  function stopAll(_reason: string, signal?: AbortSignal): Promise<StoppedChildren> {
    if (stopping) return stopping;
    stopping = performStop(signal).then(result => { uncertainty = result.uncertain; return result; }).finally(() => { stopping = undefined; });
    return stopping;
  }
  const seam = input.seam ?? defaultSeam;
  const offPark = seam.registerParkReadyContributor(signal => signal.aborted ? { ready: false, reasons: ["park-query-aborted"] } : parkReady());
  let offStop: () => void;
  try { offStop = seam.registerStopChildren(signal => stopAll("host stop_children", signal)); }
  catch (error) { offPark(); throw error; }
  return { parkReady, stopAll, dispose() { lifetime.abort(); offPark(); offStop(); } };
}
