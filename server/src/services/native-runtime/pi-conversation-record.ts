import { randomUUID } from "node:crypto";
import { and, desc, eq, lte, ne } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { canBypassFailedNativePredecessor, type FailedNativePredecessorProbe } from "./native-provider-work-proof.js";

/** Server-owned metadata; never handed to a provider as adapter configuration. */
export const PI_CONVERSATION_KEY = "__paperclipPiConversation";
export interface PiConversationBoundary {
  provider: string;
  cwd: string | null;
  remoteCwd?: string | null;
  workspaceId: string | null;
  trust: string;
}
export interface PiConversationRecord {
  schema: "paperclip.pi-conversation.v1";
  id: string;
  generation: number;
  boundary: PiConversationBoundary;
  previousId: string | null;
  reason: string;
  runId: string;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function readPiConversation(params: Record<string, unknown> | null | undefined): PiConversationRecord | null {
  const value = params?.[PI_CONVERSATION_KEY] as PiConversationRecord | undefined;
  if (value === undefined) return null;
  if (!value || value.schema !== "paperclip.pi-conversation.v1" || !uuid(value.id) || !uuid(value.runId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1 || !value.boundary
    || typeof value.boundary.provider !== "string" || typeof value.boundary.trust !== "string"
    || !(value.boundary.cwd === null || typeof value.boundary.cwd === "string")
    || !(value.boundary.remoteCwd == null || typeof value.boundary.remoteCwd === "string")
    || !(value.boundary.workspaceId === null || typeof value.boundary.workspaceId === "string")
    || typeof value.reason !== "string" || !(value.previousId === null || uuid(value.previousId))) {
    throw new Error("pi_conversation_record_invalid");
  }
  return value;
}

/** Runtime generations (model, effort, resources, lifecycle) do not own identity. */
export function piConversationBoundaryChange(previous: PiConversationBoundary, next: PiConversationBoundary): string | null {
  if (previous.provider !== next.provider) return "provider_changed";
  if (previous.cwd !== next.cwd || (previous.remoteCwd ?? null) !== (next.remoteCwd ?? null) || previous.workspaceId !== next.workspaceId) return "workspace_changed";
  if (previous.trust !== next.trust) return "trust_changed";
  return null;
}

/** Old executors could mint a different normalized id on each setup failure.
 * Only affirmative pre-spawn failures may be walked back, within the same
 * company/agent/task and explicit conversation generation. An ambiguous row is
 * a named hold, not permission to silently start a new conversation. */
async function legacyPiConversationOwner(db: Pick<Db, "select" | "execute">, owner: typeof heartbeatRuns.$inferSelect,
  generation: unknown, predecessorEnvironmentRuntime?: FailedNativePredecessorProbe) {
  if (owner.status !== "failed" || owner.runnerProfileJson?.sessionCheckpoint != null) return owner;
  const candidates = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, owner.companyId), eq(heartbeatRuns.agentId, owner.agentId),
    eq(heartbeatRuns.nativeIssueId, owner.nativeIssueId!), lte(heartbeatRuns.createdAt, owner.createdAt),
    ne(heartbeatRuns.id, owner.id),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(31);
  for (const candidate of [owner, ...candidates]) {
    const execution = candidate.runnerProfileJson?.nativeExecutionInput as {
      provider?: { kind?: string }; session?: { normalizedSessionId?: string };
      binding?: { runId?: string; companyId?: string; agentId?: string; issueId?: string };
    } | undefined;
    if (candidate.runtimeMode !== "native" || !uuid(candidate.nativeSessionId) || execution?.provider?.kind !== "pi_rpc"
      || execution.session?.normalizedSessionId !== candidate.nativeSessionId || execution.binding?.runId !== candidate.id
      || execution.binding.companyId !== owner.companyId || execution.binding.agentId !== owner.agentId
      || execution.binding.issueId !== owner.nativeIssueId
      || candidate.contextSnapshot?.conversationSessionGeneration !== generation) {
      throw new Error("pi_conversation_legacy_predecessor_unproven");
    }
    if (candidate.status === "succeeded" && candidate.runnerProfileJson?.sessionCheckpoint != null) return candidate;
    if (candidate.status !== "failed" || candidate.runnerProfileJson?.sessionCheckpoint != null
      || !await canBypassFailedNativePredecessor(db, { companyId: owner.companyId, runId: candidate.id, predecessorEnvironmentRuntime })) {
      throw new Error("pi_conversation_legacy_predecessor_unproven");
    }
  }
  if (candidates.length === 31) throw new Error("pi_conversation_legacy_predecessor_window_exhausted");
  // Every historical row was proved pre-spawn, so no saved Pi checkpoint is
  // being bypassed. The existing legacy-unverified path creates one notice.
  return null;
}

/** Single mint owner. Caller supplies an already company-scoped issue and run.
 * Issue → run → task lock order also fences explicit chat resets and Stop. */
export async function selectPiConversation(db: Db, input: {
  companyId: string; agentId: string; issueId: string; runId: string;
  boundary: PiConversationBoundary;
  predecessorEnvironmentRuntime?: FailedNativePredecessorProbe;
}): Promise<PiConversationRecord> {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId))).for("update");
    if (!issue || !run || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId
      || run.status !== "running" || run.resultJson?.startupCancellation
      || (issue.conversationAgentId && (issue.conversationAgentId !== input.agentId
        || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration))) {
      throw new Error("pi_conversation_authority_refused");
    }
    const scope = and(eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
      eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, input.issueId));
    // The issue lock serializes first creation too, before a task row exists.
    const [session] = await tx.select().from(agentTaskSessions).where(scope).for("update");
    let previous = readPiConversation(session?.sessionParamsJson);
    let legacyId = session?.sessionParamsJson?.sessionId;
    if (legacyId != null && !uuid(legacyId)) throw new Error("pi_conversation_record_invalid");
    const legacyProvenanceId = legacyId;
    const { readFreshContinuationSessionBoundary } = await import("../fresh-continuation-fallback.js");
    const fresh = await readFreshContinuationSessionBoundary(tx, run, input.issueId);
    // Consume only the recorded, fenced fallback for the thread we still own.
    // Once rotated, sourceSessionId no longer matches, including later turns
    // and same-run replays. Generic freshness/config flags never authorize it.
    const freshBoundary = fresh && (previous?.id ?? legacyId ?? run.nativeSessionId) === fresh.sourceSessionId ? fresh : null;
    let legacyUnverified = false;
    if (previous && legacyId && legacyId !== previous.id) throw new Error("pi_conversation_identity_conflict");
    if (!previous && uuid(legacyId) && !freshBoundary) {
      const [lastRun] = session?.lastRunId ? await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, session.lastRunId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      )) : [run.nativeSessionId === legacyId ? run : undefined];
      // Never reinterpret a foreign/stale task-session pointer as lineage.
      const boundLastRun = lastRun?.nativeSessionId === legacyId && lastRun.nativeIssueId === input.issueId;
      const owner = boundLastRun ? await legacyPiConversationOwner(tx, lastRun,
        run.contextSnapshot?.conversationSessionGeneration, input.predecessorEnvironmentRuntime) : lastRun;
      if (boundLastRun && owner && owner.id !== lastRun.id) legacyId = owner.nativeSessionId;
      const execution = owner?.runnerProfileJson?.nativeExecutionInput as {
        provider?: { kind?: string }; workspace?: { cwd?: string }; session?: { normalizedSessionId?: string };
        binding?: { issueId?: string; runId?: string; executionWorkspaceId?: string };
      } | undefined;
      if (!owner || owner.nativeSessionId !== legacyId || execution?.binding?.issueId !== input.issueId
        || execution.binding.runId !== owner.id || execution.session?.normalizedSessionId !== legacyId || typeof execution.provider?.kind !== "string") {
        // A pre-record row whose owner can't be verified (existing prod rows)
        // must not fail every turn on its issue: don't adopt the unverified
        // id; start a recorded conversation, as today's selection would.
        legacyUnverified = true;
        legacyId = undefined;
      }
      if (!legacyUnverified && typeof legacyId === "string" && owner && execution?.provider?.kind && execution.binding) previous = { schema: "paperclip.pi-conversation.v1", id: legacyId, generation: 1,
        boundary: { ...input.boundary, provider: execution.provider.kind === "codex" ? "codex_app_server" : execution.provider.kind,
          cwd: execution.workspace?.cwd ?? null,
          workspaceId: execution.binding.executionWorkspaceId === owner.id ? null : execution.binding.executionWorkspaceId ?? null },
        reason: "adopted_existing_conversation", previousId: null, runId: owner.id };
    }
    if (!previous && input.boundary.provider !== "pi_rpc") throw new Error("pi_conversation_record_missing");
    const reason = freshBoundary ? `fresh_continuation:${freshBoundary.recoveryActionId}` : null;
    if (reason && (run.nativeSessionId || run.runnerProfileJson?.nativeExecutionInput !== undefined
      || run.runnerProfileJson?.sessionCheckpoint != null || run.runnerProfileJson?.nativeControllerRecovery != null
      || run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null || run.sessionIdAfter !== null)) {
      throw new Error("pi_conversation_admitted_boundary_changed");
    }
    if (run.nativeSessionId && previous && run.nativeSessionId !== previous.id) throw new Error("pi_conversation_identity_conflict");
    // A replay of this immutable run cannot reinterpret newly edited settings.
    if (previous?.runId === input.runId && reason) throw new Error("pi_conversation_admitted_boundary_changed");
    const id = reason ? randomUUID() : previous?.id ?? run.nativeSessionId ?? legacyId ?? randomUUID();
    if (!uuid(id)) throw new Error("pi_conversation_identity_missing");
    const record: PiConversationRecord = previous && !reason ? previous : {
      schema: "paperclip.pi-conversation.v1", id, generation: (previous?.generation ?? 0) + 1,
      boundary: input.boundary, previousId: previous?.id ?? (freshBoundary ? freshBoundary.sourceSessionId : null),
      reason: reason ?? (legacyUnverified ? "legacy_binding_unverified" : legacyId || run.nativeSessionId ? "adopted_existing_conversation" : "first_message"), runId: input.runId,
    };
    const sessionParamsJson = { ...session?.sessionParamsJson, sessionId: id, [PI_CONVERSATION_KEY]: record };
    if (session) await tx.update(agentTaskSessions).set({ sessionParamsJson, updatedAt: new Date() }).where(eq(agentTaskSessions.id, session.id));
    else await tx.insert(agentTaskSessions).values({ companyId: input.companyId, agentId: input.agentId,
      adapterType: "paperclip_runner", taskKey: input.issueId, sessionParamsJson });
    if (freshBoundary) {
      const { writePiSessionHistoryLossNotice } = await import("./pi-session-recovery-notice.js");
      await writePiSessionHistoryLossNotice(db, tx, { ...input,
        authorizationReason: `fresh_provider_thread:${freshBoundary.recoveryActionId}`,
        body: "The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed." });
    }
    if (legacyUnverified) {
      // The issue lock and this transaction make the notice and first recorded
      // conversation atomic. Replays/later turns read the record, not the legacy
      // pointer, so they cannot repeat it (or lose it after a failed selection).
      const { writePiSessionHistoryLossNotice } = await import("./pi-session-recovery-notice.js");
      await writePiSessionHistoryLossNotice(db, tx, { ...input,
        authorizationReason: `legacy_binding_unverified:${id}:${legacyProvenanceId}`,
        body: "My earlier conversation could not be restored (it predates conversation records). Starting a new one." });
    }
    return record;
  });
}

/** Pointer publishers update runtime metadata, never erase or silently rotate C. */
export function preservePiConversation(params: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null): Record<string, unknown> | null {
  const conversation = readPiConversation(params);
  if (!conversation) return next;
  if (next?.sessionId != null && next.sessionId !== conversation.id) throw new Error("pi_conversation_identity_conflict");
  return { ...next, sessionId: conversation.id, [PI_CONVERSATION_KEY]: conversation };
}
