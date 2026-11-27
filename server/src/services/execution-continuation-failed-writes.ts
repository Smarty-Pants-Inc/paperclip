import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRunEvents, type Db } from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

type Action = NonNullable<ExecutionContinuationEnvelope["completedActions"]>[number];
type Receipt = { action: Action; digest: unknown };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const key = (runId: string, receiptId: string) => JSON.stringify([runId, receiptId]);

/** Only repeated, durably identified failed HTTP writes may lose middle copies.
 * Keep the first and last answer whole, including uncertainty and retry advice.
 * Old receipts have no call time/target: recover their exact call identity from
 * semantic input events, never guess from a route template or a run timestamp.
 * New API activity records carry the receipt id and need no event fallback.
 */
export async function foldRepeatedFailedWrites(db: Db, companyId: string, issueId: string, receipts: Receipt[]): Promise<Action[]> {
  const failed = receipts.filter(({ action, digest }) => {
    const response = object(action.result);
    return /^(POST|PUT|PATCH|DELETE) \/api\//.test(action.operationId)
      && typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
      && typeof response.status === "number"
      // An error field bars success-shortening, but by itself does not prove
      // that an explicitly successful 2xx request failed (error may be null).
      && (response.ok === false || response.status < 200 || response.status >= 300);
  });
  const bodyDigest = (result: unknown) => {
    const response = object(result);
    // data is the HTTP body; retryAfter/outcome/guidance belong to the whole
    // answer retained at both ends. Without an inline body, require equality
    // of the complete answer rather than guessing at saved artifact contents.
    const body = Object.hasOwn(response, "data") ? response.data : result;
    return createHash("sha256").update(JSON.stringify(body) ?? "null").digest("hex");
  };
  const counts = new Map<string, number>();
  const requestKey = ({ action, digest }: Receipt) => JSON.stringify([action.operationId, digest, object(action.result).status, bodyDigest(action.result)]);
  for (const candidate of failed) {
    const identity = requestKey(candidate);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const candidates = failed.filter(value => counts.get(requestKey(value))! >= 3);
  if (candidates.length < 3) return receipts.map(value => value.action);
  const byReceipt = new Map(candidates.map(value => [key(value.action.runId, value.action.receiptId), value]));
  const runIds = [...new Set(candidates.map(value => value.action.runId))];
  type Evidence = { target: string; at: string; order: number };
  const evidence = new Map<string, Evidence>();
  const bind = (runId: string, receiptId: unknown, operationId: unknown, digest: unknown, pathParams: unknown, at: Date, order: number) => {
    if (typeof receiptId !== "string") return;
    const identity = key(runId, receiptId), candidate = byReceipt.get(identity);
    if (!candidate || operationId !== candidate.action.operationId || digest !== candidate.digest || !Number.isFinite(at.getTime())) return;
    const params: Record<string, unknown> = { companyId, ...object(pathParams) };
    let resolved = true;
    const target = candidate.action.operationId.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = params[name];
      if (typeof value !== "string" || !value) { resolved = false; return ""; }
      return encodeURIComponent(value);
    });
    if (resolved && !evidence.has(identity)) evidence.set(identity, { target, at: at.toISOString(), order });
  };
  const calls = await db.select({ runId: activityLog.runId, createdAt: activityLog.createdAt, details: activityLog.details })
    .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, "runner.api_called"), inArray(activityLog.runId, runIds))).orderBy(activityLog.createdAt, activityLog.id);
  for (const [index, call] of calls.entries()) {
    const details = object(call.details);
    if (call.runId) bind(call.runId, details.receiptId, details.operationId, details.requestFingerprint, details.pathParams, call.createdAt, index);
  }
  const legacyRuns = [...new Set(candidates.filter(value => !evidence.has(key(value.action.runId, value.action.receiptId))).map(value => value.action.runId))];
  if (legacyRuns.length) {
    // Project only call identity, digest and path parameters, not request bodies
    // or the rest of the run trace. The raw saved inputs remain untouched.
    const inputs = await db.select({ runId: heartbeatRunEvents.runId, createdAt: heartbeatRunEvents.createdAt, seq: heartbeatRunEvents.seq,
      callId: sql<unknown>`${heartbeatRunEvents.payload}->'semantic_tool'->>'callId'`,
      operationId: sql<unknown>`${heartbeatRunEvents.payload}->'semantic_tool'->'input'->>'operationId'`,
      digest: sql<unknown>`${heartbeatRunEvents.payload}->'semantic_tool'->'content'->>'digest'`,
      pathParams: sql<unknown>`${heartbeatRunEvents.payload}->'semantic_tool'->'input'->'pathParams'` })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, companyId), inArray(heartbeatRunEvents.runId, legacyRuns),
        eq(heartbeatRunEvents.eventType, "semantic_tool.input"),
        sql`${heartbeatRunEvents.payload}->'semantic_tool'->>'operationId' = 'call_api'`,
        sql`${heartbeatRunEvents.payload}->'semantic_tool'->>'phase' = 'input'`))
      .orderBy(heartbeatRunEvents.createdAt, heartbeatRunEvents.seq, heartbeatRunEvents.id);
    for (const input of inputs) if (typeof input.callId === "string" && typeof input.digest === "string" && input.digest.startsWith("sha256:")) {
      bind(input.runId, createHash("sha256").update(input.callId).digest("hex"), input.operationId, input.digest.slice(7), input.pathParams, input.createdAt, input.seq);
    }
  }
  const groups = new Map<string, Array<{ action: Action; index: number; evidence: Evidence }>>();
  for (const [index, { action, digest }] of receipts.entries()) {
    const known = evidence.get(key(action.runId, action.receiptId));
    if (!known) continue;
    const groupKey = JSON.stringify([known.target, digest, object(action.result).status, bodyDigest(action.result)]);
    const group = groups.get(groupKey) ?? [];
    group.push({ action, index, evidence: known }); groups.set(groupKey, group);
  }
  const replacements = new Map<number, Action[]>(), removed = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.evidence.at.localeCompare(b.evidence.at) || a.evidence.order - b.evidence.order);
    const first = group[0]!, last = group.at(-1)!;
    const runs = [...new Set(group.map(value => value.action.runId))];
    const boundedRuns = runs.slice(0, 8).join(", ") + (runs.length > 8 ? `, +${runs.length - 8} more` : "");
    const line = `The same request failed ${group.length - 2} more times between ${first.evidence.at} and ${last.evidence.at} (runs: ${boundedRuns}).`;
    replacements.set(group.reduce((index, value) => Math.min(index, value.index), Infinity), [first.action, { ...group[1]!.action, result: line }, last.action]);
    for (const value of group) removed.add(value.index);
  }
  return receipts.flatMap(({ action }, index) => replacements.get(index) ?? (removed.has(index) ? [] : [action]));
}
