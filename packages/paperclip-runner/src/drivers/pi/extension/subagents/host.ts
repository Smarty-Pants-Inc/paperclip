import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Origin, ParentOrigin } from "./bind-types.js";
import { announce, socketAnnounce } from "./seam.js";
import { childAdmissionError, validateChildSelection, type ChildModelCatalog, type ChildSelection, type ChildSelectionAck } from "./selection.js";
import { validateRoleTemplate } from "./role-template.js";

export const CHILD_BRIDGE_BINDING = "paperclip.subagents/1";
export interface ChildClosure { readonly langfuseExtensionPath: string }
export interface SelectionReceipt { readonly origin: ParentOrigin; readonly selection: ChildSelection }
export interface ChildReadyReceipt extends SelectionReceipt, ChildSelectionAck {}
export interface ChildTurn extends SelectionReceipt { readonly childSessionId: string; readonly turnIndex: number }
export interface ChildToolEvent {
  readonly type: "tool_execution_start" | "tool_execution_end";
  readonly origin: ParentOrigin;
  readonly selectionId: string;
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly revoked: boolean;
  readonly isError?: boolean;
}
/** Authenticated host adapter, not tool arguments. Host owns announcement/grant/replay enforcement. */
export interface ChildBridgeSink {
  recordSelection(receipt: SelectionReceipt): Promise<void>;
  childReady(receipt: ChildReadyReceipt): Promise<void>;
  /** Host allocates and journals a child turn identity; SDK turnIndex is not a host turn ID. */
  startTurn(event: ChildTurn): Promise<string>;
  /** Resolve true only after the host journal ACK. A write/enqueue without ACK is insufficient. */
  toolExecutionStart(event: ChildToolEvent): Promise<boolean>;
  toolExecutionEnd(event: ChildToolEvent): Promise<void>;
}
export interface ChildBridgeLease extends SelectionReceipt {
  readonly transport: "in-process";
  readonly closure: ChildClosure;
  readonly sink: ChildBridgeSink;
  announce(toolCallId: string): boolean | Promise<boolean>;
  isRevoked(): boolean;
  attach(sessionId: string, abort: () => void | Promise<void>): () => void;
}
export interface StopReceipt {
  readonly status: "settled" | "abort-requested" | "uncertain";
  readonly unconfirmedChildSessions: string[];
  /** This local scope has no remote runner handles. Only lifecycle.stopAll can prove these. */
  readonly unconfirmedAsyncSelections: string[];
  readonly errors: string[];
}

export interface SocketChildBridgeLease extends Omit<ChildBridgeLease, "transport" | "sink"> {
  readonly transport: "socket";
}
export type AnyChildBridgeLease = ChildBridgeLease | SocketChildBridgeLease;
interface SocketBinding extends SelectionReceipt {
  readonly schema: 1;
  readonly sessionId: string;
  readonly ownerPid: number;
  readonly closure: ChildClosure;
}
// Pi resets extension-module caches between SDK children. Share only one-shot leases/tombstones,
// NEVER a mutable current run. Socket binding JSON carries evidence, NOT an authority grant.
const registryKey = Symbol.for("paperclip.pi.child-bridge.leases.v1");
const processRegistry = globalThis as typeof globalThis & { [registryKey]?: Map<string, ChildBridgeLease> };
const leases = processRegistry[registryKey] ??= new Map<string, ChildBridgeLease>();
const consumedKey = Symbol.for("paperclip.pi.child-bridge.socket-consumed.v1");
const socketRegistry = globalThis as typeof globalThis & { [consumedKey]?: Set<string> };
const consumedSocketTickets = socketRegistry[consumedKey] ??= new Set<string>();
export function consumeChildBridgeLease(bindings: unknown): AnyChildBridgeLease {
  const entry = (bindings as Record<string, { ticket?: unknown; socket?: SocketBinding }> | null)?.[CHILD_BRIDGE_BINDING];
  const ticket = entry?.ticket;
  if (typeof ticket !== "string") childAdmissionError("binding_missing", "Required child bridge binding is missing.");
  const lease = leases.get(ticket);
  if (!lease) {
    const binding = entry?.socket;
    if (!binding || binding.schema !== 1 || !Number.isSafeInteger(binding.ownerPid) || binding.ownerPid <= 0
        || binding.ownerPid === process.pid || consumedSocketTickets.has(ticket) || !binding.sessionId
        || !process.env.PAPERCLIP_PI_BIND_SOCKET) childAdmissionError("binding_missing", "Child bridge lease is missing, consumed, or has no live bind socket.");
    assertOrigin(binding.origin);
    if (!isAbsolute(binding.closure?.langfuseExtensionPath ?? "") || !binding.selection?.effectiveModel || !binding.selection.selectionId || !binding.selection.effort) childAdmissionError("binding_invalid", "Async child startup evidence is incomplete.");
    consumedSocketTickets.add(ticket);
    const origin = Object.freeze({ ...binding.origin });
    const selection = Object.freeze({ ...binding.selection });
    const closure = Object.freeze({ ...binding.closure });
    const sessionId = binding.sessionId;
    let closed = false, attached = false;
    return Object.freeze({
      transport: "socket" as const, origin, selection, closure,
      // Native child effects are admitted only by the active parent's captured authority.
      // A retained/restarted old origin cannot borrow a later bind/run through this socket.
      announce: (toolCallId: string) => closed ? false : socketAnnounce({ sessionId, toolCallId, origin }),
      isRevoked: () => closed,
      attach(_sessionId: string, _abort: () => void | Promise<void>) {
        if (closed || attached) childAdmissionError("binding_missing", "Async child startup binding was reused.");
        attached = true;
        // Async cancellation uses pi-subagents public RPC stop, not an invented remote handle.
        return () => { closed = true; };
      },
    });
  }
  leases.delete(ticket);
  if (lease.isRevoked()) childAdmissionError("revoked", "Child origin was revoked before startup.");
  return lease;
}

function assertOrigin(origin: ParentOrigin): void {
  if (!origin || !Number.isSafeInteger(origin.epoch) || origin.epoch < 0 || [origin.runId, origin.turnId, origin.callId].some(value => typeof value !== "string" || !value.trim())) childAdmissionError("origin_invalid", "A host-verified committed parent origin and outer call are required.");
}
export function createSubagentScope(input: {
  readonly origin: ParentOrigin;
  readonly closure: ChildClosure;
  readonly sink: ChildBridgeSink;
  readonly sessionId?: string;
  /** Controlled tests may inject the exact seam; production defaults to extension announce(). */
  readonly announce?: (toolCallId: string, origin: Readonly<Origin>) => boolean;
}) {
  assertOrigin(input.origin);
  if (!isAbsolute(input.closure.langfuseExtensionPath)) childAdmissionError("closure_invalid", "Langfuse entry must be an absolute importable path from the admitted closure.");
  const origin = Object.freeze({ epoch: input.origin.epoch, runId: input.origin.runId, turnId: input.origin.turnId, callId: input.origin.callId });
  const closure = Object.freeze({ ...input.closure });
  const sink = input.sink;
  const parentSessionId = input.sessionId;
  const authorityOrigin = Object.freeze({ epoch: origin.epoch, runId: origin.runId, turnId: origin.turnId });
  const announceStart = input.announce ?? announce;
  const tickets = new Set<string>(), selections = new Set<string>(), asyncSelections = new Set<string>();
  const children = new Map<string, { abort: () => void | Promise<void>; confirmed: boolean }>();
  let revoked = false;
  let revocation: Promise<StopReceipt> | undefined;
  const errors: string[] = [];
  const assertActive = () => { if (revoked) childAdmissionError("revoked", "Parent origin is revoked; no new child work is admitted."); };
  const stopReceipt = (): StopReceipt => ({
    status: errors.length || asyncSelections.size ? "uncertain" : [...children.values()].every(child => child.confirmed) ? "settled" : "abort-requested",
    unconfirmedChildSessions: [...children].filter(([, child]) => !child.confirmed).map(([id]) => id),
    unconfirmedAsyncSelections: [...asyncSelections],
    errors: [...errors],
  });
  return {
    async prepare(input: { roleText: string; selection: unknown; async?: boolean }, catalog: ChildModelCatalog) {
      assertActive();
      if (input.async && !parentSessionId) childAdmissionError("binding_missing", "Async children require the live parent sessionId for the bind socket.");
      const role = validateRoleTemplate(input.roleText);
      const selection = validateChildSelection(input.selection, catalog);
      if (selection.roleDigest !== role.digest) childAdmissionError("role_digest_mismatch", "Selection role digest differs from the unchanged reusable template.");
      if (selections.has(selection.selectionId)) childAdmissionError("selection_reused", "Every leaf needs a fresh selectionId.");
      selections.add(selection.selectionId);
      await sink.recordSelection(Object.freeze({ origin, selection }));
      assertActive();
      const ticket = randomUUID();
      const lease: ChildBridgeLease = Object.freeze({
        transport: "in-process" as const, origin, selection, closure, sink,
        announce: (toolCallId: string) => !revoked && announceStart(toolCallId, authorityOrigin),
        isRevoked: () => revoked,
        attach(sessionId: string, abort: () => void | Promise<void>) {
          assertActive();
          if (children.has(sessionId)) childAdmissionError("identity_reused", "Child session identity is already attached to this origin.");
          const child = { abort, confirmed: false };
          children.set(sessionId, child);
          return () => { child.confirmed = true; };
        },
      });
      leases.set(ticket, lease);
      tickets.add(ticket);
      if (input.async) asyncSelections.add(selection.selectionId);
      // These are supported package fields, not the spec's unshipped executionMetadata option.
      const socket: SocketBinding | undefined = input.async ? Object.freeze({ schema: 1, sessionId: parentSessionId!, ownerPid: process.pid, origin, selection, closure }) : undefined;
      return Object.freeze({ model: selection.model, async: input.async === true, options: Object.freeze({ extensionBindings: Object.freeze({ [CHILD_BRIDGE_BINDING]: Object.freeze({ ticket, ...(socket ? { socket } : {}) }) }) }) });
    },
    revoke(): Promise<StopReceipt> {
      if (revocation) return revocation;
      revoked = true; // Fence BEFORE invoking any abort callback or yielding to the host.
      for (const ticket of tickets) leases.delete(ticket);
      tickets.clear();
      revocation = Promise.all([...children].filter(([, child]) => !child.confirmed).map(async ([id, child]) => {
        try { await child.abort(); }
        catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
      })).then(stopReceipt);
      return revocation;
    },
    stopReceipt,
  };
}
