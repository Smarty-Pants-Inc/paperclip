import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { fastResponseHistoryBody, type TaskHistoryComment, type TaskHistoryVisibleRow, type TaskHistoryVisibleTurn } from "@paperclipai/shared";
import { isLowTrustQuarantined, resolveActorSourceTrustForIssue, sanitizeQuarantinedCommentForHigherTrust,
  type SourceTrustIssueContext } from "../source-trust.js";
import { nativeFinalReplyKey } from "../heartbeat-run-summary.js";
import { composeNativeVisibleReply, type VisibleAssistantReply } from "./native-visible-reply.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function short(value: unknown): string {
  const valueText = text(value)?.trim() ?? "";
  // Structured results stay structured upstream; never serialize them into the thread.
  if (/^[{[]/.test(valueText)) return "";
  return valueText.replace(/\s+/g, " ").slice(0, 240);
}
type EventRow = { seq: number; eventType: string; payload: unknown };
// Canonical activity cards have safe labels, not provider payload/JSON summaries.
const activityKinds: Record<string, { id: string; name: string }> = {
  research: { id: "researchId", name: "Research" }, delegation: { id: "delegationId", name: "Subagent" },
  plan: { id: "planId", name: "Plan" }, model: { id: "routeId", name: "Model" },
  artifact: { id: "artifactId", name: "Artifact" }, review: { id: "reviewId", name: "Review mode" },
  hook: { id: "hookId", name: "Hook" }, safety: { id: "reviewId", name: "Auto-review" },
  memory: { id: "citationId", name: "Memory" }, terminal: { id: "executionId", name: "Terminal input" },
  wait: { id: "waitId", name: "Intentional wait" },
};

/** One settled row per visible activity, anchored where it first appeared. */
function visibleToolRows(events: readonly EventRow[], reply: VisibleAssistantReply, settled: boolean, runId: string): TaskHistoryVisibleRow[] {
  const rows = new Map<string, Extract<TaskHistoryVisibleRow, { type: "tool" | "activity" }>>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.seq < reply.fromSeq || event.seq > reply.throughSeq) continue;
    const envelope = record(record(event.payload).prpEvent), payload = record(envelope.payload), item = record(payload.item);
    if (envelope.runId !== undefined && envelope.runId !== runId) continue;
    if (envelope.schema !== undefined && envelope.schema !== "paperclip.prp.event.v1") continue;
    if (envelope.eventType !== undefined && envelope.eventType !== event.eventType) continue;
    if (reply.turnId && envelope.turnId && reply.turnId !== envelope.turnId) continue;
    if (reply.normalizedSessionId && envelope.normalizedSessionId && reply.normalizedSessionId !== envelope.normalizedSessionId) continue;
    const source = text(envelope.sourceEventId);
    if (source && seen.has(source)) continue;
    if (source) seen.add(source);
    const kind = (text(item.type) ?? text(payload.kind) ?? text(item.kind) ?? "").replaceAll("_", "").toLowerCase();
    const execution = event.eventType.startsWith("tool.execution.");
    const reasoning = kind === "reasoning";
    const activity = text(payload.schema)?.startsWith("paperclip.") ? activityKinds[event.eventType.split(".")[0]!] : undefined;
    const id = (activity && (text(payload[activity.id]) ?? text(payload.proposalId) ?? text(payload.verificationId))) ?? text(payload.executionId) ?? text(item.tool_use_id) ?? text(envelope.itemId) ?? text(payload.itemId) ?? text(item.id);
    if (!id) continue;
    const key = `${envelope.normalizedSessionId ?? reply.normalizedSessionId ?? ""}:${envelope.turnId ?? reply.turnId ?? ""}:${activity?.name ?? ""}:${id}`;
    const previous = rows.get(key);
    if (!execution && !reasoning && !activity && !["tooluse", "toolresult", "toolcall"].includes(kind) && !previous) continue;
    const thought = reasoning || previous?.name === "Thought through the task";
    const type = thought || activity ? "activity" : previous?.type ?? "tool";
    const status = text(payload.status) ?? text(item.status);
    const completed = status === "completed" || status === "closed" || payload.complete === true
      || (event.eventType.endsWith(".completed") && (execution || thought || activity || kind === "toolresult" || item.result !== undefined || payload.output !== undefined))
      || Boolean(activity && !/\.(started|progressed|updated)$/.test(event.eventType));
    const nextStatus = payload.isError === true || item.isError === true || item.is_error === true || (status === "failed" || status === "denied")
      ? "failed" : status === "interrupted" || status === "cancelled" ? "interrupted"
        : ["running", "pending", "waiting", "in_progress"].includes(status ?? "") ? "running"
          : completed ? "completed" : previous?.status ?? "running";
    const result = record(item.result);
    const content = Array.isArray(result.content) ? result.content.map(value => short(record(value).text)).find(Boolean) : "";
    const summary = short(payload.summary) || short(payload.description) || short(payload.query) || short(payload.explanation)
      || short(payload.reason) || short(payload.rationale) || short(result.summary) || short(result.message)
      || short(result.text) || content || short(item.result) || short(payload.output) || short(payload.subject) || short(payload.target)
      || short(result.disposition) || (typeof payload.exitCode === "number" ? `Exit code ${payload.exitCode}` : "")
      || previous?.summary || (payload.transport === "process" ? short(payload.name) : "");
    const operation = text(payload.operation);
    const processName = operation && (operation === "search" || text(payload.target))
      ? ({ read: "Read", search: "Grep", list: "Glob" } as Record<string, string>)[operation] : null;
    const name = thought ? "Thought through the task" : activity?.name ?? (payload.transport === "process" ? processName ?? "Bash"
      : text(item.name) ?? text(payload.name) ?? previous?.name ?? operation ?? "Tool");
    if (name === "paperclip_finish") { rows.delete(key); continue; }
    rows.set(key, { type, itemId: id, seq: previous?.seq ?? event.seq, throughSeq: event.seq, name,
      status: nextStatus, summary: thought ? "" : summary });
  }
  return [...rows.values()].map(row => {
    const status = settled && row.status === "running" ? "interrupted" : row.status;
    return { ...row, status, summary: row.summary || (row.type === "tool" ? status : "") };
  });
}

/** Shared read surface for native tools and semantic tools. Authority stays with their callers. */
export async function readNativeTaskHistory(db: Db, input: {
  companyId: string; issue: SourceTrustIssueContext; limit: unknown; cursor?: unknown; lowTrustReader: boolean;
}) {
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 200)) : 50;
  const scope = and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issue.id));
  let before: { id: string; createdAt: Date } | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.cursor))
      throw new Error("paperclip_task_history_cursor_invalid");
    [before] = await db.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments)
      .where(and(scope, eq(issueComments.id, input.cursor)));
    if (!before) throw new Error("paperclip_task_history_cursor_invalid");
  }
  const page = await db.select({ id: issueComments.id, body: issueComments.body, origin: issueComments.origin,
    sourceTrust: issueComments.sourceTrust, authorAgentId: issueComments.authorAgentId, authorUserId: issueComments.authorUserId,
    createdAt: issueComments.createdAt, updatedAt: issueComments.updatedAt,
    createdByRunId: issueComments.createdByRunId, clientRequestId: issueComments.clientRequestId }).from(issueComments)
    .where(and(scope, isNull(issueComments.deletedAt), before ? or(lt(issueComments.createdAt, before.createdAt),
      and(eq(issueComments.createdAt, before.createdAt), lt(issueComments.id, before.id))) : undefined))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(limit + 1);
  const hasMore = page.length > limit, rows = page.slice(0, limit);
  const runIds = [...new Set(rows.flatMap(row => row.authorAgentId && row.createdByRunId ? [row.createdByRunId] : []))];
  const runs = runIds.length ? await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, nativeSessionId: heartbeatRuns.nativeSessionId, resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, runIds),
      eq(heartbeatRuns.runtimeMode, "native"), or(eq(heartbeatRuns.nativeIssueId, input.issue.id),
        and(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.issueId, input.issue.id))))) : [];
  const transcripts = new Map<string, EventRow[]>();
  for (const run of runs) {
    const trust = await resolveActorSourceTrustForIssue({ db, issue: input.issue,
      actor: { actorType: "agent", actorId: run.agentId, agentId: run.agentId, runId: run.id } });
    if (!input.lowTrustReader && isLowTrustQuarantined(trust)) continue;
    transcripts.set(run.id, await db.select({ seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType,
      payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.agentId, run.agentId), eq(heartbeatRunEvents.runId, run.id))).orderBy(asc(heartbeatRunEvents.seq)));
  }
  const comments: TaskHistoryComment[] = rows.toReversed().map(({ updatedAt: _updatedAt, clientRequestId, ...row }) => {
    const visible = input.lowTrustReader ? row : sanitizeQuarantinedCommentForHigherTrust(row);
    const comment = { ...visible, body: fastResponseHistoryBody(visible) };
    // Promoting one sanitized comment is not permission to expose its raw run.
    if (!input.lowTrustReader && (isLowTrustQuarantined(row.sourceTrust) || row.sourceTrust?.disposition === "promoted")) return comment;
    const run = runs.find(run => run.id === row.createdByRunId && run.agentId === row.authorAgentId);
    const events = run && transcripts.get(run.id);
    if (!run || !events?.length || row.origin === "fast_response") return comment;
    const replies = record(record(run.resultJson).continuousReplies);
    const mappedItem = Object.entries(replies).find(([, value]) => record(value).commentId === row.id)?.[0];
    const final = events.find(event => {
      const envelope = record(record(event.payload).prpEvent), payload = record(envelope.payload), item = record(payload.item);
      const id = text(envelope.itemId) ?? text(payload.itemId) ?? text(item.id);
      if (!id || event.eventType !== "item.completed" || (payload.channel ?? item.channel) !== "final") return false;
      const key = nativeFinalReplyKey(run.id, id);
      return mappedItem ? mappedItem === id : clientRequestId === key || clientRequestId?.startsWith(`${key}:`);
    });
    const reply = composeNativeVisibleReply(events, { runId: run.id, normalizedSessionId: run.nativeSessionId,
      ...(final ? { throughSeq: final.seq, finalEvent: { seq: final.seq, prpEvent: record(final.payload).prpEvent } } : {}) });
    if (!reply) return comment;
    // Notes written during a run are not automatically that run's visible reply.
    if (!final && record(record(run.resultJson).presentationDecision).commentId !== row.id && reply.text !== row.body &&
        clientRequestId !== reply.replyKey) return comment;
    const visibleTurn: TaskHistoryVisibleTurn = { runId: run.id, turnId: reply.turnId, normalizedSessionId: reply.normalizedSessionId,
      fromSeq: reply.fromSeq, throughSeq: reply.throughSeq, text: reply.text,
      rows: [...reply.visibleItems.map(item => ({ type: "text" as const, ...item })),
        ...visibleToolRows(events, reply, Boolean(final) || !["running", "queued"].includes(run.status), run.id)]
        .sort((a, b) => a.seq - b.seq) };
    return { ...comment, visibleTurn };
  });
  return { rows, comments, limit, returnedCount: comments.length, hasMore, nextCursor: hasMore ? rows.at(-1)!.id : null };
}
