import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueAttachments, issueComments, issues } from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";

import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import { sanitizeQuarantinedCommentForHigherTrust } from "../source-trust.js";
import { PROVIDER_TURN_ACCEPTED_EVENT_TYPES } from "./provider-attempt-outcome.js";
import { reconcileContinuousSessionInput } from "./continuous-session-input.js";
import { queuedInteractionId, readQueuedInteractionResponse } from "../queued-interaction-response.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { commandTextBytes, FIRST_TURN_QUEUED_INPUT_MAX_BYTES, NativeTurnPromptExceedsCommandBoundError, nativePromptRefusalRemedies } from "./native-turn-budget.js";

/**
 * Queued input for a run's first provider turn.
 *
 * A user's message that arrives while a run is still preparing waits as a
 * deferred wake behind that run. Interrupting the run for it throws away the
 * whole preparation. Instead, the run takes the waiting messages into the
 * turn it is about to start: the runner calls `claimFirstTurnQueuedInput`
 * immediately before `turn.start`, and the claim and the first-turn input are
 * sealed in one transaction on the run row.
 *
 * The claim does not remove the messages from their deferred wake. It records
 * a receipt in the run's context. A message counts as delivered only after the
 * provider accepted that run's turn (`deliveredQueuedCommentIds`). If the run
 * ends before that, the receipt proves nothing and the deferred wake still
 * holds the message, so the next run delivers it exactly once. A restart
 * before the turn was accepted repeats the same claim from the receipt.
 */
export const FIRST_TURN_QUEUED_INPUT_KEY = "firstTurnQueuedInput";
export const FIRST_TURN_QUEUED_INPUT_SCHEMA = "paperclip.first-turn-queued-input.v1";

const DEFERRED_WAKE_STATUS = "deferred_issue_execution";
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const COMMENT_WAKE_REASONS = new Set(["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FirstTurnQueuedInputReceipt = {
  schema: typeof FIRST_TURN_QUEUED_INPUT_SCHEMA;
  runId: string;
  wakeupRequestIds: string[];
  commentIds: string[];
  /** Card answers are typed receipts, not editable issue comments. Optional for v1 readers. */
  interactionIds?: string[];
  claimedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
}

/**
 * The receipt this exact run sealed. A retry copies its predecessor's context,
 * so a receipt naming another run is inert.
 */
export function readFirstTurnQueuedInputReceipt(run: { id: string; contextSnapshot?: unknown }): FirstTurnQueuedInputReceipt | null {
  const receipt = record(record(run.contextSnapshot)[FIRST_TURN_QUEUED_INPUT_KEY]);
  if (receipt.schema !== FIRST_TURN_QUEUED_INPUT_SCHEMA || receipt.runId !== run.id) return null;
  const claimedAt = nonEmptyString(receipt.claimedAt);
  if (!claimedAt) return null;
  return {
    schema: FIRST_TURN_QUEUED_INPUT_SCHEMA,
    runId: run.id,
    wakeupRequestIds: stringIds(receipt.wakeupRequestIds),
    commentIds: stringIds(receipt.commentIds),
    interactionIds: stringIds(receipt.interactionIds),
    claimedAt,
  };
}

/** Message ids a live run already took into its first turn; queue views hide them. */
export function firstTurnClaimedCommentIds(run: { id: string; status?: string | null; contextSnapshot?: unknown } | null | undefined): Set<string> {
  if (!run || (run.status !== undefined && run.status !== "running")) return new Set();
  const receipt = readFirstTurnQueuedInputReceipt(run);
  return new Set([...(receipt?.commentIds ?? []), ...(receipt?.interactionIds ?? [])]);
}

/**
 * Whether a deferred wake is plain user input that the run's first turn may
 * take. Interaction answers, interrupt intents, independent continuations and
 * chat-conversation wakes keep their own delivery contracts. Only the run's
 * responsible user's own messages qualify, so taking them cannot change the
 * run's execution authority.
 *
 * A user's message can join an earlier automatic wake that was already waiting
 * behind the task, which keeps that wake's system requester. The messages, not
 * the wake's origin, carry the authority: every caller also requires each one
 * to be the responsible user's own (`firstTurnEligibleComment`). Another
 * user's or an agent's wake keeps its own delivery.
 */
export function deferredWakeJoinsFirstTurn(
  wake: { agentId: string; status: string; requestedByActorType: string | null; requestedByActorId: string | null; reason: string | null; payload: unknown },
  run: { agentId: string; responsibleUserId: string | null },
): boolean {
  const payload = record(wake.payload);
  const context = record(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  const reason = nonEmptyString(context.wakeReason) ?? nonEmptyString(wake.reason);
  const requester = wake.requestedByActorType === "user"
    ? wake.requestedByActorId === run.responsibleUserId
    : wake.requestedByActorType === "system" || wake.requestedByActorType === null;
  return wake.status === DEFERRED_WAKE_STATUS &&
    wake.agentId === run.agentId &&
    Boolean(run.responsibleUserId) && requester &&
    reason !== null && COMMENT_WAKE_REASONS.has(reason) &&
    payload.nativeInputRefusalHold !== true &&
    !payload.interactionId && !context.interactionId && !context.interactionStatus &&
    !payload.queuedCommentInterrupt && context.resumeIntent !== true &&
    !deferredWakeIsChatRequest(payload) &&
    queuedCommentIdsFromWakePayload(payload).length > 0;
}

/**
 * Whether a deferred wake carries a chat request. A chat wake keeps its own
 * delivery: the run it starts binds that request's source, so its tools act on
 * what the request asked for. `deferredWakeChatRequestSql` is the same test in SQL.
 */
export function deferredWakeIsChatRequest(payloadValue: unknown): boolean {
  const payload = record(payloadValue);
  return Boolean(nonEmptyString(record(payload[DEFERRED_WAKE_CONTEXT_KEY]).chatConversationId) ||
    nonEmptyString(payload.externalChatProvider));
}

function deferredWakeChatRequestSql(payload: typeof agentWakeupRequests.payload) {
  return sql`(nullif(btrim(${payload}->${DEFERRED_WAKE_CONTEXT_KEY}->>'chatConversationId'), '') is not null
    or nullif(btrim(${payload}->>'externalChatProvider'), '') is not null)`;
}

/**
 * Whether a chat request waits as a deferred wake behind the agent's current
 * run on this task. Work that would continue the current run in a fresh session
 * yields to it, because that continuation would keep the older request's source.
 */
export async function hasQueuedChatRequest(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS), isNull(agentWakeupRequests.runId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    deferredWakeChatRequestSql(agentWakeupRequests.payload),
  )).limit(1);
  return Boolean(wake);
}

type QueuedMessage = { id: string; body: string; createdAt: Date; kind?: "interaction" };

/** Same authority and fresh-session fences as ordinary queued person input. */
async function readFirstTurnInteraction(tx: Db, binding: { companyId: string; issueId: string; agentId: string },
  wake: typeof agentWakeupRequests.$inferSelect, responsibleUserId: string) {
  const payload = record(wake.payload), context = record(payload[DEFERRED_WAKE_CONTEXT_KEY]);
  const interactionId = queuedInteractionId(payload);
  const requester = wake.requestedByActorType === "user" ? wake.requestedByActorId === responsibleUserId
    : wake.requestedByActorType === "system" || wake.requestedByActorType === null;
  if (payload.nativeInputRefusalHold === true || !interactionId || !requester || queuedCommentIdsFromWakePayload(payload).length > 0 ||
      (Array.isArray(payload.interactionIds) && payload.interactionIds.some(id => id !== interactionId)) ||
      payload.resumeIntent === true || context.resumeIntent === true || payload.forceFreshSession === true || context.forceFreshSession === true ||
      payload.queuedCommentInterrupt || deferredWakeIsChatRequest(payload)) return null;
  // Only the continuous Pi publication path settles sealed interaction input.
  const [agent] = await tx.select({ config: agents.adapterConfig }).from(agents).where(and(
    eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId))).limit(1);
  if (agent?.config.provider !== "pi_rpc" || resolveSessionContinuity("pi_rpc", agent.config.sessionContinuity) !== "continuous") return null;
  const response = await readQueuedInteractionResponse(tx, binding.companyId, binding.issueId, payload);
  if (!response || response.toolActionOutcome || response.source.requiresFreshSession ||
      response.comment.authorUserId !== responsibleUserId || response.comment.authorAgentId) return null;
  return { id: response.comment.id, body: response.comment.body, createdAt: new Date(response.comment.createdAt), kind: "interaction" as const };
}

function ownsFirstTurnIssue(issue: { executionRunId: string | null; assigneeAgentId: string | null;
  conversationAgentId: string | null; conversationState: string | null; conversationSessionGeneration: number | null } | undefined,
  run: { id: string; agentId: string; contextSnapshot: unknown }) {
  return Boolean(issue && issue.executionRunId === run.id && issue.assigneeAgentId === run.agentId &&
    (!issue.conversationAgentId || (issue.conversationAgentId === run.agentId && issue.conversationState === "active" &&
      record(run.contextSnapshot).conversationSessionGeneration === issue.conversationSessionGeneration)));
}

// A validator may decline an unmeasured composition without refusing the turn.
type ValidateFirstTurnInput = (text: string | null) => void | false;

function renderWholeFirstTurnQueuedInput(messages: readonly QueuedMessage[], validate?: ValidateFirstTurnInput): string | null {
  if (messages.length === 0) return null;
  const text = [
    "New messages from the user arrived while this run was starting. They were not in the request above. Handle each of them in this turn, oldest first, together with that request:",
    ...messages.map((message, index) => [
      `[Message ${index + 1} of ${messages.length} · ${message.kind ?? "comment"} ${message.id} · ${message.createdAt.toISOString()}]`,
      message.body,
    ].join("\n")),
  ].join("\n\n");
  // Decide whether this composition can claim anything before applying a size
  // limit: even an oversized message stays owed on an unmeasured composition.
  if (validate?.(text) === false) return null;
  // A person's words are indivisible, including card answers.
  const bytes = commandTextBytes(text);
  if (bytes > FIRST_TURN_QUEUED_INPUT_MAX_BYTES)
    throw new NativeTurnPromptExceedsCommandBoundError(messages.length === 1 && messages[0]!.kind === "interaction"
      ? { kind: "human_response", bytes: Buffer.byteLength(messages[0]!.body), remedies: nativePromptRefusalRemedies("human_response") } : { kind: "queued_input", bytes, remedies: nativePromptRefusalRemedies("queued_input") });
  return text;
}

function selectFirstTurnQueuedInput(messages: readonly QueuedMessage[], validate?: ValidateFirstTurnInput) {
  let text: string | null = null, count = 0;
  // No queued input needs no pre-seal bound. The final command is still guarded.
  for (let end = 1; end <= messages.length; end++) {
    try {
      const candidate = renderWholeFirstTurnQueuedInput(messages.slice(0, end), validate);
      if (candidate === null) break;
      text = candidate;
      count = end;
    } catch (error) {
      // A large later message must not stall earlier whole messages. Only a
      // first message that cannot fit refuses; every unselected ID stays owed.
      if (count === 0 && error instanceof NativeTurnPromptExceedsCommandBoundError && error.promptCause?.kind === "queued_input" && messages[0]?.kind === "interaction")
        throw new NativeTurnPromptExceedsCommandBoundError({ kind: "human_response", bytes: Buffer.byteLength(messages[0].body), remedies: nativePromptRefusalRemedies("human_response") });
      if (count === 0 || !(error instanceof NativeTurnPromptExceedsCommandBoundError)) throw error;
      break;
    }
  }
  return { text, messages: messages.slice(0, count) };
}

export function renderFirstTurnQueuedInput(messages: readonly QueuedMessage[]): string | null {
  return selectFirstTurnQueuedInput(messages).text;
}

/**
 * The one rule for which queued comment a first turn may take: a live, plain
 * comment written directly by the run's responsible user, with no files. The
 * prompt carries text only; a message with files keeps its own delivery, which
 * stages those files for the turn that reads it.
 */
function firstTurnEligibleComment(input: { companyId: string; issueId: string; responsibleUserId: string }) {
  return and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorUserId, input.responsibleUserId),
    isNull(issueComments.authorAgentId), isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`btrim(${issueComments.body}) <> '/new'`,
    sql`not exists (select 1 from ${issueAttachments} where ${issueAttachments.companyId} = ${input.companyId}
      and ${issueAttachments.issueCommentId} = ${issueComments.id})`);
}

async function readQueuedMessages(
  tx: Db,
  input: { companyId: string; issueId: string; agentId: string; responsibleUserId: string; commentIds: string[]; excludeDelivered: boolean },
): Promise<QueuedMessage[]> {
  if (input.commentIds.length === 0) return [];
  const rows = await tx.select({
    id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt,
    sourceTrust: issueComments.sourceTrust,
  }).from(issueComments).where(and(inArray(issueComments.id, input.commentIds), firstTurnEligibleComment(input)));
  const delivered = input.excludeDelivered
    ? await deliveredQueuedCommentIds(tx, { companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
      commentIds: rows.map(row => row.id) })
    : new Set<string>();
  const byId = new Map(rows.map(row => [row.id, row]));
  return input.commentIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row || delivered.has(id)) return [];
    const safe = sanitizeQuarantinedCommentForHigherTrust({ ...row, sourceTrust: row.sourceTrust as SourceTrustMetadata | null });
    return [{ id, body: safe.body, createdAt: row.createdAt }];
  });
}

/**
 * Seals the first provider turn's input. Returns the queued messages to add to
 * that turn, or null. Called once per turn start, immediately before
 * `turn.start`; repeated calls for the same run return the same messages.
 */
export async function claimFirstTurnQueuedInput(
  db: Db,
  binding: { companyId: string; runId: string; issueId: string; agentId: string },
  validateTurnInput?: ValidateFirstTurnInput,
  options: { finalGuardInstalled?: boolean } = {},
): Promise<string | null> {
  await reconcileContinuousSessionInput(db, binding);
  return db.transaction(async (tx) => {
    // Redact on this transaction's own connection: a second pool connection
    // while the seal holds its locks can wait forever on a one-connection pool.
    const redact = async (messages: QueuedMessage[]) => messages.length === 0 ? [] :
      createRunSecretRedactionRegistry(tx as unknown as Db).redactForIssue(binding.companyId, binding.issueId,
        [...new Map(messages.map(message => [message.id, message])).values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    // Lock in the queue routes' order (task, queue, run) so a concurrent
    // Interrupt and this seal serialize instead of deadlocking.
    const [issue] = await tx.select({ conversationAgentId: issues.conversationAgentId, executionRunId: issues.executionRunId,
      assigneeAgentId: issues.assigneeAgentId, conversationState: issues.conversationState,
      conversationSessionGeneration: issues.conversationSessionGeneration })
      .from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update").limit(1);
    const wakes = !issue ? [] : await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, binding.companyId), eq(agentWakeupRequests.agentId, binding.agentId),
      eq(agentWakeupRequests.status, DEFERRED_WAKE_STATUS),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${binding.issueId}`,
    )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id)).for("update");
    const [run] = await tx.select({
      id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
      runtimeMode: heartbeatRuns.runtimeMode, responsibleUserId: heartbeatRuns.responsibleUserId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      resultJson: heartbeatRuns.resultJson,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId))).for("update").limit(1);
    if (!run || run.status !== "running" || run.runtimeMode !== "native" || !run.responsibleUserId) return null;
    const receipt = readFirstTurnQueuedInputReceipt(run);
    // A restart before the provider accepted the turn repeats the sealed input.
    if (receipt) {
      const messages = await readQueuedMessages(tx as unknown as Db, { ...binding, responsibleUserId: run.responsibleUserId,
        commentIds: receipt.commentIds, excludeDelivered: false });
      for (const wake of wakes.filter(wake => receipt.wakeupRequestIds.includes(wake.id))) {
        const response = await readFirstTurnInteraction(tx as unknown as Db, binding, wake, run.responsibleUserId);
        if (response && receipt.interactionIds?.includes(response.id)) messages.push(response);
      }
      // Replay the whole receipt without a new pre-seal estimate. A receipt
      // seals IDs, not bounded bytes: bodies, cwd and skills are re-read. This
      // replay skips the validator WITHOUT checking finalGuardInstalled. That
      // is correct on guarded backends: the final guard still measures the
      // actual command before persistence/dispatch, NOT because the receipt
      // proves today's command was already bounded. This is no byte-bound
      // guarantee for an arbitrary unguarded/injected backend.
      return renderWholeFirstTurnQueuedInput(await redact(messages));
    }
    // Conversation input pending at this seal is part of the submitted user
    // message too. Only later arrivals belong to the live-turn steer path.
    const ownsIssue = ownsFirstTurnIssue(issue, run);
    const joining = !ownsIssue ? [] : wakes.filter(wake => deferredWakeJoinsFirstTurn(wake, run) &&
      record(record(wake.payload)[DEFERRED_WAKE_CONTEXT_KEY]).forceFreshSession !== true &&
      (wake.payload?.preDispatchInputOnly !== true || !issue?.conversationAgentId ||
        record(wake.payload?._paperclipWakeContext).conversationSessionGeneration === issue.conversationSessionGeneration));
    // Passive pre-dispatch receipts join the next admitted turn; ordinary
    // conversation input retains its existing first-turn and interaction rules.
    const handback = joining.some(wake => wake.payload?.preDispatchInputOnly === true);
    const ownInput = new Set([
      ...queuedCommentIdsFromWakePayload({ _paperclipWakeContext: run.contextSnapshot }),
      record(run.contextSnapshot).wakeCommentId,
    ]);
    const interactions: Array<QueuedMessage & { wakeId: string }> = [];
    if (ownsIssue) for (const wake of wakes) {
      const response = await readFirstTurnInteraction(tx as unknown as Db, binding, wake, run.responsibleUserId);
      if (response) interactions.push({ ...response, wakeId: wake.id });
    }
    const commentIds = [...new Set(joining.flatMap(wake => queuedCommentIdsFromWakePayload(wake.payload)))].filter(id => !ownInput.has(id));
    const pressedAt = nonEmptyString(record(record(run.resultJson).personStopHeld).pressedAt);
    const taken = (await readQueuedMessages(tx as unknown as Db, { ...binding, responsibleUserId: run.responsibleUserId,
      commentIds, excludeDelivered: true })).filter(message => !pressedAt || message.createdAt.getTime() <= Date.parse(pressedAt));
    // Render before sealing: once the receipt commits, nothing can fail
    // between it and the turn input that the receipt describes.
    if (handback) taken.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const takenInteractions = interactions.filter(message => !pressedAt || message.createdAt.getTime() <= Date.parse(pressedAt));
    const candidates = await redact([...taken, ...takenInteractions]);
    const validate: ValidateFirstTurnInput = text => {
      const result = validateTurnInput?.(text);
      // Only a positive signal from the backend that installed the final
      // command guard permits whole-message admission without an estimate.
      // Measured refusals still throw; the renderer still enforces its limit.
      return result === false && options.finalGuardInstalled !== true ? false : undefined;
    };
    const { text, messages: selected } = selectFirstTurnQueuedInput(candidates, validate);
    if (candidates.length > 0 && text === null) {
      // An ordinary deferred wake keeps its independent next-run delivery.
      // Do not seal an empty receipt: no queued input was admitted or claimed.
      // Passive handbacks have ONLY this first-turn route. Without either a
      // measured composition or a positively installed final guard, refuse
      // truthfully without consuming input; never guess a backend is guarded.
      if (handback) throw new NativeTurnPromptExceedsCommandBoundError({ kind: "unmeasured_composition", bytes: 0, remedies: nativePromptRefusalRemedies("unmeasured_composition") });
      return null;
    }
    const selectedComments = selected.filter(message => message.kind !== "interaction");
    const selectedInteractions = takenInteractions.filter(message => selected.some(candidate => candidate.id === message.id));
    // Seal even when nothing joined: later messages wait for the turn boundary.
    const sealed: FirstTurnQueuedInputReceipt = {
      schema: FIRST_TURN_QUEUED_INPUT_SCHEMA,
      runId: run.id,
      wakeupRequestIds: joining.filter(wake => queuedCommentIdsFromWakePayload(wake.payload)
        .some(id => selectedComments.some(message => message.id === id))).map(wake => wake.id).concat(selectedInteractions.map(message => message.wakeId)),
      commentIds: selectedComments.map(message => message.id),
      interactionIds: [...new Set(selectedInteractions.map(message => message.id))],
      claimedAt: new Date().toISOString(),
    };
    await tx.update(heartbeatRuns).set({
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ [FIRST_TURN_QUEUED_INPUT_KEY]: sealed,
        ...(handback ? { preDispatchInputHandback: true } : {}) })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    return text;
  });
}

/**
 * True while a running native run can still take queued input into its first
 * turn: it has not sealed that input and no provider turn was accepted. A run
 * saved by a release without the seal counts as started once its provider
 * accepted a turn, so a mid-turn Interrupt keeps its old meaning.
 */
export async function runAcceptsFirstTurnQueuedInput(
  tx: Pick<Db, "select">,
  run: { id: string; companyId: string; status: string; runtimeMode: string | null; runtimeModeResolvedAt?: Date | null;
    runnerProfileJson?: unknown; contextSnapshot?: unknown },
): Promise<boolean> {
  if (run.status !== "running") return false;
  const preparingNative = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    record(record(run.runnerProfileJson).adapterDispatch).adapterType === "paperclip_runner";
  if (run.runtimeMode !== "native" && !preparingNative) return false;
  if (readFirstTurnQueuedInputReceipt(run)) return false;
  const [accepted] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, [...PROVIDER_TURN_ACCEPTED_EVENT_TYPES]))).limit(1);
  return !accepted;
}

/** The wake facts `deferredWakeJoinsFirstTurn` reads, without the rest of a large payload. */
export const firstTurnWakeColumns = {
  agentId: agentWakeupRequests.agentId,
  reason: agentWakeupRequests.reason,
  requestedByActorType: agentWakeupRequests.requestedByActorType,
  requestedByActorId: agentWakeupRequests.requestedByActorId,
};

/** The lean payload fields `deferredWakeJoinsFirstTurn` reads, for a `jsonb_build_object` projection. */
export function firstTurnWakePayloadFields(payload: typeof agentWakeupRequests.payload) {
  return sql`'interactionId', ${payload}->'interactionId',
    'queuedCommentInterrupt', ${payload}->'queuedCommentInterrupt'->'requestedAt',
    'externalChatProvider', ${payload}->'externalChatProvider'`;
}

/** The lean `_paperclipWakeContext` fields `deferredWakeJoinsFirstTurn` reads. */
export function firstTurnWakeContextFields(payload: typeof agentWakeupRequests.payload) {
  return sql`'wakeReason', ${payload}->'_paperclipWakeContext'->'wakeReason',
    'interactionId', ${payload}->'_paperclipWakeContext'->'interactionId',
    'interactionStatus', ${payload}->'_paperclipWakeContext'->'interactionStatus',
    'resumeIntent', ${payload}->'_paperclipWakeContext'->'resumeIntent',
    'chatConversationId', ${payload}->'_paperclipWakeContext'->'chatConversationId'`;
}

/**
 * The messages in one deferred queue that the running run's first turn takes:
 * the ones it already sealed, or, while it is still starting, the ones its
 * claim will take under the same rule as `claimFirstTurnQueuedInput`. A queue
 * view shows these as sent instead of waiting for Steer, which cannot reach a
 * run whose provider session (for example a booting sandbox) is not up yet.
 * Presentation only: delivery still belongs to the claim and the deferred wake.
 */
export async function firstTurnQueuedCommentIds(
  tx: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    wake: { agentId: string; status: string; reason: string | null; requestedByActorType: string | null;
      requestedByActorId: string | null; payload: unknown };
  },
): Promise<string[]> {
  const { wake } = input;
  if (wake.status !== DEFERRED_WAKE_STATUS) return [];
  const wakeIds = queuedCommentIdsFromWakePayload(wake.payload);
  if (wakeIds.length === 0) return [];
  // Read only the receipt and dispatch choice; a run snapshot can be large.
  const [row] = await tx.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt, responsibleUserId: heartbeatRuns.responsibleUserId,
    dispatchAdapterType: sql<string | null>`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`,
    receipt: sql<unknown>`${heartbeatRuns.contextSnapshot}->${FIRST_TURN_QUEUED_INPUT_KEY}`,
    conversationGeneration: sql<number | null>`${heartbeatRuns.contextSnapshot}->'conversationSessionGeneration'`,
    executionRunId: issues.executionRunId, conversationAgentId: issues.conversationAgentId,
    assigneeAgentId: issues.assigneeAgentId, conversationState: issues.conversationState,
    conversationSessionGeneration: issues.conversationSessionGeneration,
  }).from(heartbeatRuns)
    .leftJoin(issues, and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  if (!row || row.status !== "running" || row.agentId !== wake.agentId) return [];
  const run = { ...row, runnerProfileJson: { adapterDispatch: { adapterType: row.dispatchAdapterType } },
    contextSnapshot: { [FIRST_TURN_QUEUED_INPUT_KEY]: row.receipt, conversationSessionGeneration: row.conversationGeneration } };
  const receipt = readFirstTurnQueuedInputReceipt(run);
  if (receipt) {
    const sealed = new Set(receipt.commentIds);
    return wakeIds.filter(id => sealed.has(id));
  }
  if (!ownsFirstTurnIssue(row, run) || !run.responsibleUserId) return [];
  if (!deferredWakeJoinsFirstTurn(wake, run) ||
      record(record(wake.payload)[DEFERRED_WAKE_CONTEXT_KEY]).forceFreshSession === true) return [];
  if (!(await runAcceptsFirstTurnQueuedInput(tx, run))) return [];
  const eligible = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    inArray(issueComments.id, wakeIds),
    firstTurnEligibleComment({ companyId: input.companyId, issueId: input.issueId, responsibleUserId: run.responsibleUserId })));
  const ids = new Set(eligible.map(row => row.id));
  return wakeIds.filter(id => ids.has(id));
}

/**
 * True when the first turn would take every pending message in this queue,
 * under the same rule as the claim. Another user's message, an agent's, or one
 * with files keeps its own delivery, so Interrupt must still apply.
 */
export async function firstTurnTakesAllQueuedComments(
  tx: Pick<Db, "select">,
  input: { companyId: string; issueId: string; responsibleUserId: string | null; commentIds: string[] },
): Promise<boolean> {
  if (input.commentIds.length === 0 || !input.responsibleUserId) return false;
  const rows = await tx.select({
    id: issueComments.id,
    eligible: sql<boolean>`coalesce((${firstTurnEligibleComment({ ...input, responsibleUserId: input.responsibleUserId })}), false)`,
  }).from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, input.commentIds), isNull(issueComments.deletedAt)));
  return rows.length > 0 && rows.every(row => row.eligible === true);
}
