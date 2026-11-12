import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ParentOrigin } from "./bind-types.js";
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
  /** Resolve true only after fd-3 host ledger ACK. A write/enqueue without ACK is insufficient. */
  toolExecutionStart(event: ChildToolEvent): Promise<boolean>;
  toolExecutionEnd(event: ChildToolEvent): Promise<void>;
}
export interface ChildBridgeLease extends SelectionReceipt {
  readonly closure: ChildClosure;
  readonly sink: ChildBridgeSink;
  isRevoked(): boolean;
  attach(sessionId: string, abort: () => void | Promise<void>): () => void;
}
export interface StopReceipt {
  readonly status: "settled" | "abort-requested" | "uncertain";
  readonly unconfirmedChildSessions: string[];
  readonly errors: string[];
}

// Pi resets extension-module caches between SDK children. Share only one-shot leases, NEVER a
// mutable "current run". The decided in-process route deliberately fails closed in detached hosts.
const registryKey = Symbol.for("paperclip.pi.child-bridge.leases.v1");
const processRegistry = globalThis as typeof globalThis & { [registryKey]?: Map<string, ChildBridgeLease> };
const leases = processRegistry[registryKey] ??= new Map<string, ChildBridgeLease>();
export function consumeChildBridgeLease(bindings: unknown): ChildBridgeLease {
  const entry = (bindings as Record<string, { ticket?: unknown }> | null)?.[CHILD_BRIDGE_BINDING];
  const ticket = entry?.ticket;
  if (typeof ticket !== "string") childAdmissionError("binding_missing", "Required child bridge binding is missing.");
  const lease = leases.get(ticket);
  if (!lease) childAdmissionError("binding_missing", "Child bridge lease is missing, consumed, or belongs to another process.");
  leases.delete(ticket);
  if (lease.isRevoked()) childAdmissionError("revoked", "Child origin was revoked before startup.");
  return lease;
}

export function createSubagentScope(input: {
  readonly origin: ParentOrigin;
  readonly closure: ChildClosure;
  readonly sink: ChildBridgeSink;
}) {
  if (!Number.isSafeInteger(input.origin.epoch) || input.origin.epoch < 0 || [input.origin.runId, input.origin.turnId, input.origin.callId].some(value => typeof value !== "string" || !value.trim())) childAdmissionError("origin_invalid", "A host-verified committed parent origin and outer call are required.");
  if (!isAbsolute(input.closure.langfuseExtensionPath)) childAdmissionError("closure_invalid", "Langfuse entry must be an absolute importable path from the admitted closure.");
  const origin = Object.freeze({ epoch: input.origin.epoch, runId: input.origin.runId, turnId: input.origin.turnId, callId: input.origin.callId });
  const closure = Object.freeze({ ...input.closure });
  const sink = input.sink;
  const tickets = new Set<string>(), selections = new Set<string>();
  const children = new Map<string, { abort: () => void | Promise<void>; confirmed: boolean }>();
  let revoked = false;
  let revocation: Promise<StopReceipt> | undefined;
  const errors: string[] = [];
  const assertActive = () => { if (revoked) childAdmissionError("revoked", "Parent origin is revoked; no new child work is admitted."); };
  const stopReceipt = (): StopReceipt => ({
    status: errors.length ? "uncertain" : [...children.values()].every(child => child.confirmed) ? "settled" : "abort-requested",
    unconfirmedChildSessions: [...children].filter(([, child]) => !child.confirmed).map(([id]) => id),
    errors: [...errors],
  });
  return {
    async prepare(input: { roleText: string; selection: unknown }, catalog: ChildModelCatalog) {
      assertActive();
      const role = validateRoleTemplate(input.roleText);
      const selection = validateChildSelection(input.selection, catalog);
      if (selection.roleDigest !== role.digest) childAdmissionError("role_digest_mismatch", "Selection role digest differs from the unchanged reusable template.");
      if (selections.has(selection.selectionId)) childAdmissionError("selection_reused", "Every leaf needs a fresh selectionId.");
      selections.add(selection.selectionId);
      await sink.recordSelection(Object.freeze({ origin, selection }));
      assertActive();
      const ticket = randomUUID();
      const lease: ChildBridgeLease = Object.freeze({
        origin, selection, closure, sink,
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
      // These are supported package fields, not the spec's unshipped executionMetadata option.
      return Object.freeze({ model: selection.model, async: false as const, options: Object.freeze({ extensionBindings: Object.freeze({ [CHILD_BRIDGE_BINDING]: Object.freeze({ ticket }) }) }) });
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
