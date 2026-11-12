import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consumeChildBridgeLease, type AnyChildBridgeLease, type ChildToolEvent } from "./host.js";
import { acknowledgeChildSelection, childAdmissionError } from "./selection.js";

export type LoadChildTracing = (entry: string, pi: ExtensionAPI) => Promise<void>;
const loadTracing: LoadChildTracing = async (entry, pi) => {
  const module = await import(pathToFileURL(entry).href) as { default?: (pi: ExtensionAPI) => unknown };
  if (typeof module.default !== "function") childAdmissionError("tracing_invalid", "Admitted Langfuse entry must export a Pi extension factory.");
  await module.default(pi);
};

/** Required extension factory. Binding is read ONLY during SDK startup's scoped env window. */
export default async function childBridge(pi: ExtensionAPI): Promise<void> {
  try {
    let bindings: unknown;
    try { bindings = JSON.parse(process.env.PI_SUBAGENT_EXTENSION_BINDINGS ?? "null"); }
    catch { childAdmissionError("binding_invalid", "Child extension bindings are not valid JSON."); }
    await installChildBridge(pi, consumeChildBridgeLease(bindings));
  } catch (error) {
    // Pi's loader can swallow a factory failure and omit that extension. Throwing here would
    // REMOVE the only tool gate. Keep a successfully loaded, permanently denying factory.
    const reason = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, ctx) => { ctx.abort(); throw error; });
    pi.on("input", () => ({ action: "handled" }));
    pi.on("before_agent_start", (_event, ctx) => { ctx.abort(); throw error; });
    pi.on("tool_call", () => ({ block: true, reason: `Required child bridge unavailable: ${reason}` }));
  }
}

/** Injected separately for controlled offline children; no private SDK/package imports. */
export async function installChildBridge(pi: ExtensionAPI, lease: AnyChildBridgeLease, load: LoadChildTracing = loadTracing): Promise<void> {
  if (lease.isRevoked()) childAdmissionError("revoked", "Parent origin was revoked before child extension load.");
  // Load during the factory, not session_start: Langfuse's own startup handlers must run too.
  await load(lease.closure.langfuseExtensionPath, pi);
  let ready = false, closed = false, active = false;
  let childSessionId = "", childTurnId = "";
  let confirmSettlement: (() => void) | undefined;
  const calls = new Map<string, { event: ChildToolEvent; accepted: boolean; used: boolean }>();
  const isRevoked = () => closed || lease.isRevoked();
  const readback = (ctx: ExtensionContext) => acknowledgeChildSelection(lease.selection, { sessionId: ctx.sessionManager.getSessionId(), model: ctx.model, thinkingLevel: pi.getThinkingLevel() });

  pi.on("session_start", async (_event, ctx) => {
    if (ready || isRevoked()) childAdmissionError("revoked", "Child bridge cannot reuse startup or revoked authority.");
    const ack = readback(ctx);
    // Async descriptors may survive on disk. A resumed session is NOT a fresh live binding.
    if (lease.transport === "socket" && ctx.sessionManager.getBranch().some(entry => entry.type === "message")) childAdmissionError("binding_missing", "Retained/restarted child resume requires a fresh live binding.");
    childSessionId = ack.childSessionId;
    confirmSettlement = lease.attach(childSessionId, () => ctx.abort());
    if (lease.transport === "in-process") await lease.sink.childReady(Object.freeze({ ...ack, origin: lease.origin, selection: lease.selection }));
    if (isRevoked()) childAdmissionError("revoked", "Child origin was revoked while host acknowledged startup.");
    ready = true;
  });
  pi.on("input", (_event, ctx) => {
    if (!ready || isRevoked()) return { action: "handled" };
    try { readback(ctx); }
    catch { ctx.abort(); return { action: "handled" }; }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    try {
      if (!ready || isRevoked()) childAdmissionError("revoked", "Child cannot prompt with missing or revoked authority.");
      readback(ctx);
    } catch (error) { ctx.abort(); throw error; }
  });
  pi.on("agent_start", () => { active = true; });
  pi.on("turn_start", async (event, ctx) => {
    if (!ready || isRevoked()) { ctx.abort(); return; }
    childTurnId = "";
    try {
      readback(ctx);
      active = true;
      // The agreed remote seam admits starts under captured PARENT Origin only. It does not
      // allocate/journal a host child turn; keep this native-only label explicitly distinct.
      const turnId = lease.transport === "in-process"
        ? await lease.sink.startTurn(Object.freeze({ origin: lease.origin, selection: lease.selection, childSessionId, turnIndex: event.turnIndex }))
        : `native:${childSessionId}:${event.turnIndex}`;
      if (typeof turnId !== "string" || !turnId.trim()) childAdmissionError("turn_missing", "Host did not acknowledge a child turn identity.");
      if (!isRevoked()) childTurnId = turnId;
      else ctx.abort();
    } catch (error) { ctx.abort(); throw error; }
  });
  pi.on("tool_execution_start", async event => {
    const existing = calls.get(event.toolCallId);
    const announcement: ChildToolEvent = Object.freeze({ type: "tool_execution_start", origin: lease.origin, selectionId: lease.selection.selectionId, childSessionId, childTurnId, toolCallId: event.toolCallId, toolName: event.toolName, revoked: isRevoked() });
    // Retain tombstones. Repeating a start must not reset a consumed call's local gate.
    const call = existing ?? { event: announcement, accepted: false, used: false };
    if (!existing) calls.set(event.toolCallId, call);
    const announced = !existing && await lease.announce(event.toolCallId);
    const accepted = lease.transport === "in-process"
      ? (announced || isRevoked()) && await lease.sink.toolExecutionStart(announcement)
      : announced;
    if (!existing && accepted && ready && !isRevoked() && childTurnId && childTurnId === announcement.childTurnId) call.accepted = true;
  });
  pi.on("tool_call", (event, ctx) => {
    const call = calls.get(event.toolCallId);
    if (!ready || isRevoked() || !childTurnId || !call?.accepted || call.used || call.event.childTurnId !== childTurnId || call.event.toolName !== event.toolName) {
      return { block: true, reason: "Child call lacks an active host-acknowledged native start, or its origin is revoked." };
    }
    readback(ctx);
    call.used = true;
  });
  pi.on("tool_execution_end", async event => {
    const call = calls.get(event.toolCallId);
    if (call && lease.transport === "in-process") await lease.sink.toolExecutionEnd(Object.freeze({ ...call.event, type: "tool_execution_end", revoked: isRevoked(), isError: event.isError }));
  });
  pi.on("agent_settled", () => {
    active = false; closed = true;
    confirmSettlement?.();
  });
  pi.on("session_shutdown", () => {
    closed = true;
    // A shutdown callback alone is not proof an active request actually settled.
    if (!active) confirmSettlement?.();
  });
}
