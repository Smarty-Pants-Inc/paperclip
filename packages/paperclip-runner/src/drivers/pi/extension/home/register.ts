import { PiNativeAdmissionError } from "../../pi-native-config.js";
import { admitNativeHome, type NativeHomeAdmissionInput } from "./admission.js";
import { buildNativeHomeLoadReceipt, type NativeHomeToolInfo } from "./load-receipt.js";
import type { NativeHomeSettings } from "./manifest.js";

/** Code-lead's exact seam; no import of extension/index.ts and no private Pi host API. */
export interface HomeAdmissionRequest { sessionId: string; epoch: number; runId: string; signal: AbortSignal }
export type RegisterHomeAdmission = (fn: (input: HomeAdmissionRequest) => { digest: string } | Promise<{ digest: string }>) => () => void;
interface NativeHomeContext { sessionManager: { getSessionId(): string } }
export interface NativeHomePi {
  getAllTools(): readonly NativeHomeToolInfo[];
  getSettings(): NativeHomeSettings;
  on(event: "session_start", handler: (event: { reason?: string }, ctx: NativeHomeContext) => void | Promise<void>): (() => void) | void;
  on(event: "session_shutdown", handler: (event: { reason?: string }) => void): (() => void) | void;
}
export interface NativeHomeConfiguration {
  /** Import VERSION from the running Pi host, not a separately installed package. */
  piVersion: string;
  /** Initial native manifest/effective-settings readback, with immutable roots held by the launcher. */
  collect(input: { sessionId: string; signal: AbortSignal }): Promise<Pick<NativeHomeAdmissionInput, "manifest" | "required" | "environment">>;
}

/**
 * Compose synchronously in the extension factory, then configure with the native collector.
 * An unconfigured registration rejects every bind. No timers, processes, persisted receipts,
 * hypothetical upstream loader hooks, or active-tool assumptions are introduced here.
 */
export function registerNativeHome(pi: NativeHomePi, registerHomeAdmission: RegisterHomeAdmission) {
  let configuration: NativeHomeConfiguration | undefined;
  let sessionId: string | undefined, generation = 0, startupFatal = false, disposed = false;
  let startupHome: ReturnType<NativeHomeConfiguration["collect"]> | undefined;
  const startupController = new AbortController();
  const unregisterStart = pi.on("session_start", async (event, ctx) => {
    generation++; sessionId = ctx.sessionManager.getSessionId();
    if (event.reason === "startup") {
      startupFatal = true;
      startupHome = configuration?.collect({ sessionId, signal: startupController.signal });
      await startupHome;
    }
    if (event.reason === "reload") { startupFatal = false; startupHome = undefined; }
  });
  const unregisterShutdown = pi.on("session_shutdown", event => {
    generation++; sessionId = undefined; startupController.abort();
    if (event.reason === "quit" || event.reason === "reload") dispose();
  });
  const unregisterAdmission = registerHomeAdmission(async input => {
    input.signal.throwIfAborted();
    const current = configuration, currentGeneration = generation;
    if (disposed || !current) throw new PiNativeAdmissionError("pi_home_not_configured", "Native home admission has no native manifest collector.");
    if (!sessionId || input.sessionId !== sessionId) throw new PiNativeAdmissionError("pi_home_load_receipt_stale", "The bind is not for the resident's current native session.");
    if (!startupFatal || !startupHome) throw new PiNativeAdmissionError("pi_home_startup_rule_invalid", "Admission needs the initial CLI startup snapshot; configure before session_start and restart after /reload.");
    // Never recollect new package bytes and attribute them to factories already loaded in this
    // resident. New/resume/fork reuse the startup identity and revalidate its bytes at each bind.
    const home = await startupHome;
    const loadReceipt = await buildNativeHomeLoadReceipt({ ...home, sessionId: input.sessionId, piVersion: current.piVersion, tools: pi.getAllTools(), settings: pi.getSettings(), signal: input.signal });
    const { digest } = await admitNativeHome({ ...home, sessionId: input.sessionId, loadReceipt, signal: input.signal });
    input.signal.throwIfAborted();
    if (disposed || generation !== currentGeneration || sessionId !== input.sessionId) throw new PiNativeAdmissionError("pi_home_load_receipt_stale", "Native session changed during home admission.");
    return { digest };
  });
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; sessionId = undefined; configuration = undefined; startupHome = undefined;
    startupController.abort(); unregisterAdmission(); unregisterStart?.(); unregisterShutdown?.();
  }
  return {
    configure(value: NativeHomeConfiguration) {
      if (disposed || sessionId || startupHome) throw new PiNativeAdmissionError("pi_home_not_configured", "Native home configuration is sealed at session_start.");
      configuration = { piVersion: value.piVersion, collect: value.collect };
    },
    dispose,
  };
}
