import { and, desc, eq, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { QueuedCommentMutationError } from "../modules/wake-queue/application/queued-comment-use-cases.js";
import { userStopBoundaryAt } from "./run-cancellation.js";

/** Both reorder writers call this under the issue lock, before any writes.
 * Use the same latest issue/agent run and Stop clock as run-control, never
 * requestedAt: chat reorders deliberately permute those mutable send slots.
 */
export async function assertQueuedCommentStopLinePreserved(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string | null;
  comments: ReadonlyArray<{ id: string; createdAt: Date | string }>;
  orderedIds: string[];
}): Promise<void> {
  if (!input.agentId) return;
  const [source] = await db.select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
    resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    or(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`, eq(heartbeatRuns.nativeIssueId, input.issueId)),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!source || source.status !== "cancelled") return;
  const boundary = userStopBoundaryAt(source);
  if (!boundary) return;
  const postStop = new Map(input.comments.map(comment =>
    [comment.id, new Date(comment.createdAt).getTime() > boundary.getTime()]));
  // Each id must keep every opposite-side id on the same side of itself.
  // Counting opposite-side predecessors also handles a queue that was already
  // interleaved before this guard shipped; equal label sequences alone would
  // let two pre-Stop ids swap across a post-Stop id in such a saved queue.
  const oppositeBefore = new Map<string, number>();
  let pre = 0, post = 0;
  for (const comment of input.comments) {
    const after = postStop.get(comment.id)!;
    oppositeBefore.set(comment.id, after ? pre : post);
    if (after) post++; else pre++;
  }
  pre = 0; post = 0;
  const crossing = input.orderedIds.some(id => {
    const after = postStop.get(id)!;
    const before = after ? pre : post;
    if (after) post++; else pre++;
    return oppositeBefore.get(id) !== before;
  });
  if (crossing) {
    throw new QueuedCommentMutationError("queued_comment_stop_line_crossing",
      "Queued messages cannot be moved across the Stop line");
  }
}
