import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { agents, companies, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseNativeExecutionInput, type NativeExecutionInput, type PersistedNativeSession, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { NativeFailedBeforeProviderTurnError } from "./failed-before-provider-turn.js";
import { currentNativeControllerIdentity, evaluateNativeControllerTakeover, hasNativeExecutionStartEvidence, recordLegacyHostFallbackProof } from "./native-restart-recovery.js";
import { NativeControllerRecoveryWaitingError, readNativeControllerRecovery } from "./native-controller-recovery.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { readyPortableTaskSource } from "../plugin-task-ownership.js";
import { PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS } from "@paperclipai/adapter-utils";
import { currentControllerBootId } from "../controller-process-identity.js";
import { currentProcessProbe, proveOwnerGone } from "../owner-proof.js";
import { logActivity } from "../activity-log.js";
import { PROCESS_IDENTITY_RECORDED } from "../native-process-start-events.js";

export const WARM_OWNER_RECHECK_MS = 5_000;
const WARM_OWNER_CLOSE_MARGIN_MS = 2 * 60_000;

export async function liveWarmSessionOwnerRetryAt(input: {
  owner: Pick<typeof nativeRunFinalizations.$inferSelect, "controllerBootId" | "controllerPid" | "controllerHostHash"
    | "controllerProcessStartedAt" | "updatedAt">;
  finishedAt: Date | null;
  idleTimeoutMs: number | null;
  now?: Date;
}): Promise<Date | null> {
  const { owner } = input;
  const now = input.now ?? new Date();
  if (!owner.controllerBootId || owner.controllerBootId === currentControllerBootId()) return null;
  const releasedAt = (input.finishedAt ?? owner.updatedAt).getTime();
  const closesBy = releasedAt + (input.idleTimeoutMs ?? PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS) + WARM_OWNER_CLOSE_MARGIN_MS;
  if (closesBy <= now.getTime()) return null;
  const proof = await proveOwnerGone({
    kind: "local", scope: "native_warm_session", generation: null, host: null,
    processSpace: owner.controllerHostHash, processSpaceUnrecorded: owner.controllerHostHash == null,
    bootId: owner.controllerBootId, pid: owner.controllerPid,
    processStartedAt: owner.controllerProcessStartedAt?.toISOString() ?? null,
    touchedAt: owner.updatedAt.toISOString(),
  }, { ...currentProcessProbe(), readOnly: true });
  if (proof.verdict !== "alive") return null;
  return new Date(Math.min(now.getTime() + WARM_OWNER_RECHECK_MS, closesBy));
}

export async function waitForLiveWarmSessionOwner(input: {
  db: Db;
  execution: NativeExecutionInput;
  priorRunId: string;
  checkpointedAt: () => Promise<Date | null>;
}): Promise<void> {
  const { binding } = input.execution;
  const [owner] = await input.db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, input.priorRunId), eq(nativeRunFinalizations.companyId, binding.companyId))).limit(1);
  if (!owner) return;
  const [prior] = await input.db.select({ finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.priorRunId), eq(heartbeatRuns.companyId, binding.companyId),
    eq(heartbeatRuns.agentId, binding.agentId))).limit(1);
  const finishedAt = prior?.finishedAt ?? null;
  const retryAt = await liveWarmSessionOwnerRetryAt({ owner, finishedAt,
    idleTimeoutMs: input.execution.session.lifecyclePolicy.idleTimeoutMs ?? null });
  if (!retryAt || !owner.controllerBootId) return;
  const checkpointedAt = await input.checkpointedAt();
  if (checkpointedAt && finishedAt && checkpointedAt >= finishedAt) return;
  throw new NativeControllerRecoveryWaitingError(retryAt, { runId: input.priorRunId, controllerBootId: owner.controllerBootId });
}

export type RemoteWarmSessionRecovery = {
  identity: Record<string, string>;
  checkpoint: PersistedNativeSession;
  previousExecution: NativeExecutionInput;
  reuseProcess: boolean;
  releasedSource?: DurableRecoveryIdentity;
  releasedSourceRunner?: { version: string; digest: string };
  portableSourceTaskId?: string;
  remote: { providerLeaseId: string; remoteCwd: string };
  revalidate: (leaseOwner: string) => Promise<void>;
};

/** Protocol events that mean work started and may still be live or waiting. */
const POST_TERMINAL_LIVE_WORK = new Set(["turn.started", "turn.accepted", "run.attached", "tool.execution.started",
  "semantic_tool.input", "runtime_request.created"]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function postTerminalEvents(control: Record<string, unknown>): unknown[] {
  const events = Array.isArray(control.committedEvents) ? control.committedEvents : [];
  const terminalIndex = events.findLastIndex(event => record(event).eventType === "run.terminal");
  return terminalIndex < 0 ? [] : events.slice(terminalIndex + 1);
}

/** A session is settled when its commands finished and nothing is live or waiting.
 * Events after the terminal describe the past, so refusing cannot undo them: they
 * are reported instead. Every event must still authenticate as this session's. */
const RUNNER_LIFECYCLE_COMMAND_TYPES = new Set(["runner.suspend", "runner.drain", "runner.shutdown"]);

function outcomeUnknown(command: Record<string, unknown>): boolean {
  return command.status === "indeterminate" ||
    (command.status === "failed" && (record(command.result).code === "execution_indeterminate" ||
      record(record(command.result).result).code === "execution_indeterminate"));
}

export function unsettledControllerCommands(commands: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const lastCompletedTurnStart = Math.max(-1, ...commands
    .filter(command => command.type === "turn.start" && command.status === "completed")
    .map(command => Number(command.controllerSeq)));
  return commands.filter(command => {
    if (command.status === "completed") return false;
    if (outcomeUnknown(command)) {
      return !(command.type === "turn.start" && Number(command.controllerSeq) < lastCompletedTurnStart);
    }
    return !((command.status === "failed" || command.status === "rejected") &&
      !RUNNER_LIFECYCLE_COMMAND_TYPES.has(String(command.type)));
  });
}

export function isSettledRemoteWarmControlState(control: Record<string, unknown>, identity: Record<string, unknown>): boolean {
  const commands = control.commands;
  const events = control.committedEvents;
  if (!Array.isArray(commands) || unsettledControllerCommands(commands.map(record)).length > 0 ||
      !Array.isArray(events) || Object.entries(identity).some(([key, value]) => record(control.identity)[key] !== value)) return false;
  const terminalIndex = events.findLastIndex(event => record(event).eventType === "run.terminal");
  if (terminalIndex < 0) return false;
  const matchesSession = (event: unknown) => {
    const envelope = record(record(event).envelope);
    return envelope.runId === identity.runId && envelope.normalizedSessionId === identity.normalizedSessionId;
  };
  if (!matchesSession(events[terminalIndex])) return false;
  return events.slice(terminalIndex + 1).every(event => {
    const envelope = record(record(event).envelope);
    const notification = record(envelope.payload);
    const payload = record(notification.payload);
    const eventType = record(event).eventType;
    // An active goal keeps a run going, and its next turn can start at any moment.
    const live = (typeof eventType === "string" && POST_TERMINAL_LIVE_WORK.has(eventType)) ||
      ((eventType === "session.goal.snapshot" || eventType === "session.goal.updated") &&
        (payload.workingNow !== false || record(payload.goal).status === "active"));
    return !live && matchesSession(event) &&
      Object.entries(identity).every(([key, value]) => envelope[key] === value) &&
      (notification.schema === "paperclip.prp.event.v1" || notification.schema === "paperclip.prp.event.v2") &&
      notification.eventType === eventType &&
      notification.sourceInstanceId === identity.runnerInstanceId && notification.sourceKind === "runner" &&
      notification.runId === identity.runId && notification.normalizedSessionId === identity.normalizedSessionId;
  });
}

/** Event types recorded after the prior run's terminal, for the next run's log. */
export function summarizePostTerminalEvents(control: Record<string, unknown>): string | null {
  const counts = new Map<string, number>();
  for (const event of postTerminalEvents(control)) {
    const type = String(record(event).eventType);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts.size === 0 ? null : [...counts].map(([type, count]) => `${type} x${count}`).join(", ");
}

/** A failed attachment suspends the Runner under the attaching run while the journal
 * still names its predecessor. A same-run retry cannot prove either owner, so report
 * the failure that caused this state rather than the resulting identity mismatch. */
export function describeOwnFailedAttachment(recoveryHistory: unknown): string {
  const history = Array.isArray(recoveryHistory) ? recoveryHistory : [];
  const cause = record(history.at(-1)).stderrTail;
  return `runner_state_identity_mismatch: prior_attach_failed: ${typeof cause === "string" && cause ? cause : "unknown"}`;
}

/** Explains a failed attachment to whoever diagnoses it. The stored failure is
 * already redacted and bounded; other failures produce no explanation. */
export function describeFailedAttachment(failureMessage: unknown): string | null {
  if (typeof failureMessage !== "string" || !/\brun\.attach (failed|requires)\b/.test(failureMessage)) return null;
  const encoded = /"message":("(?:[^"\\]|\\.)*")/.exec(failureMessage)?.[1];
  let cause = failureMessage;
  try { if (encoded) cause = JSON.parse(encoded) as string; } catch { /* Keep the whole failure. */ }
  return `This run could not attach to its provider session: ${cause}. A later run may start a new provider thread.`;
}

export type WarmRecoveryRefusal = "identity_incomplete" | "target_not_resumed_sandbox" | "owner_unsettled" | "execution_mismatch"
  | "checkpoint_unsettled" | "journal_unsettled" | "controller_not_stopped" | "prior_lease_mismatch"
  | "current_run_not_admitted" | "current_owner_changed" | "owner_changed" | "current_lease_changed"
  | "backup_without_reusable_lease" | "metadata_format";

/** A typed refusal (possibly wrapped in the stock predecessor failure), not an arbitrary I/O error. */
export class NativeWarmRecoveryRefusalError extends Error {
  constructor(readonly reason: WarmRecoveryRefusal) {
    super(`runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; warm_recovery_refused=${reason}`);
    this.name = "NativeWarmRecoveryRefusalError";
  }
}

/** Admission refusals are not transport failures and must not enter generic recovery. */
export class NativeContinuationAdmissionRefusalError extends NativeWarmRecoveryRefusalError {
  readonly code = "native_continuation_admission_refused";
  constructor(reason: "backup_without_reusable_lease" | "metadata_format", readonly predecessorRunId: string | null) {
    super(reason);
    this.name = "NativeContinuationAdmissionRefusalError";
    this.message = reason === "backup_without_reusable_lease"
      ? "runner_harness_state_mismatch: backup_without_reusable_lease" : "native_controller_recovery_unsupported:metadata_format";
  }
}

/** One bounded decision owner for both early controller and late harness admission.
 * The stage must independently authenticate the exact selected checkpoint, its
 * conversation and safe source isolation. Never search older history or loop. */
export async function admitNativeContinuationRefusal(input: {
  db: Db;
  binding: NativeExecutionInput["binding"];
  refusal: NativeContinuationAdmissionRefusalError;
  providerLeaseId: string | null;
  /** Host preparation of this new sandbox failed before any process launch. */
  beforeProviderTurn?: boolean;
  restoreSameSession: () => Promise<boolean>;
}): Promise<void> {
  let cause: unknown = input.refusal;
  try {
    if (await input.restoreSameSession()) return;
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.message === "native_session_cancelled")) throw error;
    cause = new AggregateError([input.refusal, error], "Saved session restoration refused");
  }
  // Never turn an uncertain provider attempt or Stop into a fresh continuation.
  const [run] = await input.db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.binding.runId), eq(heartbeatRuns.companyId, input.binding.companyId),
    eq(heartbeatRuns.agentId, input.binding.agentId), eq(heartbeatRuns.nativeIssueId, input.binding.issueId))).limit(1);
  if (!run || run.result?.nativeCancellation || run.result?.startupCancellation || run.result?.firstTurnDispatchCommitted) throw input.refusal;
  if (await hasNativeExecutionStartEvidence(input.db, { companyId: input.binding.companyId, id: input.binding.runId })) {
    if (!input.beforeProviderTurn) throw input.refusal;
    // onSessionAdmission records intent before host preparation. Intent alone
    // is not a launch; every actual process/provider/tool event still blocks.
    const [started] = await input.db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, input.binding.companyId), eq(heartbeatRunEvents.runId, input.binding.runId),
      or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType,
        ["adapter.invoke", PROCESS_IDENTITY_RECORDED, "tool.execution.started"])))).limit(1);
    if (started) throw input.refusal;
  }
  // Commit the visible break before executor teardown can throw a different
  // cleanup error. Completion uses this same idempotent publisher.
  await publishNativeFreshSessionNotice(input.db, input.binding);
  const fresh = new NativePredecessorRetirementUnprovenError(input.refusal.predecessorRunId,
    input.providerLeaseId, cause, true);
  throw input.beforeProviderTurn ? new NativeFailedBeforeProviderTurnError(input.providerLeaseId, fresh) : fresh;
}

export async function publishNativeFreshSessionNotice(db: Db,
  binding: Pick<NativeExecutionInput["binding"], "companyId" | "agentId" | "issueId" | "runId">): Promise<void> {
  const { companyId, agentId, issueId, runId } = binding;
  const notices = await db.transaction(async tx => {
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("no key update");
    const [marker] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.createdByRunId, runId), isNotNull(issueComments.conversationSessionGeneration))).limit(1);
    if (!task || marker) return [];
    const now = new Date();
    return tx.insert(issueComments).values([
      { companyId, issueId, createdByRunId: runId, authorType: "system", createdAt: now,
        body: `The saved session could not be restored; continuing in a new session. [Details of this attempt](/agents/${agentId}/runs/${runId}). Earlier messages remain available.` },
      { companyId, issueId, createdByRunId: runId, authorType: "system", createdAt: new Date(now.getTime() + 1),
        body: "New session", conversationSessionGeneration: task.conversationSessionGeneration },
    ]).returning();
  });
  for (const notice of notices) await logActivity(db, { companyId, actorType: "system", actorId: "native-runtime",
    agentId, runId, issueId, action: "issue.comment_added", entityType: "issue", entityId: issueId,
    details: { commentId: notice.id, bodySnippet: notice.body.slice(0, 120), source: "pi_retirement_fallback" } }).catch(() => undefined);
}

export function isNativeWarmRecoveryRefusal(error: unknown): boolean {
  return error instanceof NativeWarmRecoveryRefusalError ||
    (error instanceof NativePredecessorRetirementUnprovenError && error.cause instanceof NativeWarmRecoveryRefusalError);
}

export async function inspectRemoteWarmSessionRecovery(input: {
  db: Db;
  execution: NativeExecutionInput;
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  identity: Record<string, unknown>;
  readControlState: () => Record<string, unknown>;
  matchesExecution: (previous: NativeExecutionInput) => boolean;
  loadCheckpoint: (previous: NativeExecutionInput) => PersistedNativeSession | null;
  canReuseProcess: (previous: NativeExecutionInput) => boolean;
  portableSourceTaskId?: string;
}): Promise<RemoteWarmSessionRecovery | null> {
  const { binding } = input.execution;
  const { target } = input;
  let settledPredecessor: { runId: string; providerLeaseId: string } | null = null;
  const deny = (reason: WarmRecoveryRefusal): never => {
    const refusal = new NativeWarmRecoveryRefusalError(reason);
    if (settledPredecessor) {
      throw new NativePredecessorRetirementUnprovenError(settledPredecessor.runId, settledPredecessor.providerLeaseId, refusal);
    }
    throw refusal;
  };
  const refuseCurrentRun = (reason: WarmRecoveryRefusal): never => {
    throw new NativeWarmRecoveryRefusalError(reason);
  };
  const identity: Record<string, string> = {};
  for (const key of ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"]) {
    const value = input.identity[key];
    if (typeof value !== "string" || !value) return deny("identity_incomplete");
    identity[key] = value;
  }
  // A Runner lives in the sandbox it started in. A created or replacement
  // sandbox (for example after a restart or deploy replaced the controller)
  // holds no Runner to adopt, so live adoption steps aside. Ordinary admission
  // then retires the finished owner or keeps it held with a named reason.
  if (!input.portableSourceTaskId && target.transport === "sandbox" && ["created", "replacement"].includes(target.sandboxLeaseAcquisition?.outcome ?? "")) {
    return null;
  }
  if (target.transport !== "sandbox" || !target.leaseId || !target.environmentId ||
      !target.providerKey || !target.sandboxLeaseAcquisition ||
      (!input.portableSourceTaskId && target.sandboxLeaseAcquisition.outcome !== "resumed") ||
      identity.runId === binding.runId) return deny("target_not_resumed_sandbox");
  const providerLeaseId = target.sandboxLeaseAcquisition.providerLeaseId;
  const sourceProviderLeaseId = input.portableSourceTaskId ?? providerLeaseId;
  const [prior] = await input.db.select({ run: heartbeatRuns, owner: nativeRunFinalizations })
    .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(eq(heartbeatRuns.id, identity.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
  if (!prior || prior.run.status !== "succeeded" || !prior.owner.resultId || !prior.owner.controllerPid ||
      !prior.owner.controllerProcessStartedAt || !prior.owner.controllerBootId) return deny("owner_unsettled");
  const previous = parseNativeExecutionInput(prior.run.runnerProfileJson?.nativeExecutionInput);
  if (previous.binding.runId !== identity.runId || !input.matchesExecution(previous)) return deny("execution_mismatch");
  if (prior.owner.leaseOwner && prior.owner.leaseExpiresAt && prior.owner.leaseExpiresAt > new Date()) {
    throw new NativeControllerRecoveryWaitingError(prior.owner.leaseExpiresAt);
  }
  if (prior.owner.phase !== "committed" || prior.owner.leaseOwner) return deny("owner_unsettled");
  const liveOwnerRetryAt = await liveWarmSessionOwnerRetryAt({ owner: prior.owner, finishedAt: prior.run.finishedAt,
    idleTimeoutMs: previous.session?.lifecyclePolicy?.idleTimeoutMs ?? null });
  if (liveOwnerRetryAt) {
    throw new NativeControllerRecoveryWaitingError(liveOwnerRetryAt, { runId: identity.runId, controllerBootId: prior.owner.controllerBootId });
  }
  if (sourceProviderLeaseId === providerLeaseId) settledPredecessor = { runId: identity.runId, providerLeaseId };
  const checkpoint = input.loadCheckpoint(previous);
  if (!checkpoint || checkpoint.identity.runId !== identity.runId ||
      checkpoint.identity.companyId !== binding.companyId || checkpoint.identity.issueId !== binding.issueId ||
      checkpoint.identity.agentId !== binding.agentId || checkpoint.identity.sessionId !== identity.normalizedSessionId ||
      checkpoint.driverKind !== previous.session.driverKind || !checkpoint.providerSessionId ||
      checkpoint.activeTurnId !== null || checkpoint.pendingRuntimeRequests?.length !== 0) return deny("checkpoint_unsettled");
  const control = input.readControlState();
  if (!isSettledRemoteWarmControlState(control, identity)) return deny("journal_unsettled");
  const assertPriorStopped = async () => {
    const persistedRecovery = readNativeControllerRecovery(prior.run.runnerProfileJson?.nativeControllerRecovery,
      prior.run.runnerProfileJson?.sessionCheckpoint);
    // A PID in another webserver container cannot prove life or death. New
    // durable controllers are fenced by the database lease and current turn.
    const stopped = await evaluateNativeControllerTakeover({ owner: prior.owner, now: new Date(), requireStoppedController: true,
      remoteLeaseFenced: persistedRecovery !== null });
    if (!stopped.allowed) return deny("controller_not_stopped");
    await recordLegacyHostFallbackProof(input.db, prior.run, stopped, "remote_warm_session_recovery");
  };
  await assertPriorStopped();
  const priorLeases = await input.db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, binding.companyId), eq(environmentLeases.heartbeatRunId, identity.runId),
    eq(environmentLeases.issueId, binding.issueId), eq(environmentLeases.environmentId, target.environmentId),
    eq(environmentLeases.provider, target.providerKey), eq(environmentLeases.providerLeaseId, sourceProviderLeaseId),
  ));
  if (priorLeases.length !== 1 || priorLeases[0].metadata?.remoteCwd !== target.remoteCwd ||
      !["released", "expired", "active", ...(input.portableSourceTaskId ? ["retained"] : [])].includes(priorLeases[0].status)) {
    return deny("prior_lease_mismatch");
  }
  return {
    identity, checkpoint, previousExecution: previous, reuseProcess: input.canReuseProcess(previous),
    portableSourceTaskId: input.portableSourceTaskId,
    remote: { providerLeaseId, remoteCwd: target.remoteCwd },
    revalidate: async leaseOwner => {
      await assertPriorStopped();
      if (input.portableSourceTaskId &&
          (await readyPortableTaskSource(input.db, binding.companyId, target.leaseId!, identity))?.taskId !== input.portableSourceTaskId) {
        return deny("prior_lease_mismatch");
      }
      const controller = await currentNativeControllerIdentity();
      const [current] = await input.db.select({ run: heartbeatRuns, owner: nativeRunFinalizations, issue: issues, agent: agents, company: companies })
        .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
        .innerJoin(issues, eq(issues.id, heartbeatRuns.nativeIssueId))
        .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
        .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
        .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
      const [lease] = await input.db.select().from(environmentLeases).where(and(
        eq(environmentLeases.id, target.leaseId!), eq(environmentLeases.companyId, binding.companyId),
        eq(environmentLeases.heartbeatRunId, binding.runId), eq(environmentLeases.issueId, binding.issueId),
      ));
      const [priorOwner] = await input.db.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.runId, identity.runId), eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
      ));
      if (!current || current.run.status !== "running" || current.run.resultJson?.nativeCancellation ||
          current.company.status !== "active" || current.agent.lifecycleState !== "ready" ||
          ["paused", "terminated", "pending_approval"].includes(current.agent.status) ||
          current.issue.executionRunId !== binding.runId || current.issue.assigneeAgentId !== binding.agentId ||
          current.issue.status !== "in_progress") return refuseCurrentRun("current_run_not_admitted");
      if (current.owner.leaseOwner !== leaseOwner || !current.owner.leaseExpiresAt ||
          current.owner.leaseExpiresAt <= new Date() || current.owner.resultId ||
          current.owner.controllerBootId !== controller.bootId || current.owner.controllerPid !== controller.pid) {
        return refuseCurrentRun("current_owner_changed");
      }
      if (!priorOwner || priorOwner.leaseOwner || priorOwner.phase !== "committed" ||
          priorOwner.resultId !== prior.owner.resultId || priorOwner.controllerBootId !== prior.owner.controllerBootId) {
        return deny("owner_changed");
      }
      if (!lease || lease.status !== "active" ||
          lease.environmentId !== target.environmentId || lease.provider !== target.providerKey ||
          lease.providerLeaseId !== providerLeaseId || lease.metadata?.remoteCwd !== target.remoteCwd) return deny("current_lease_changed");
    },
  };
}
