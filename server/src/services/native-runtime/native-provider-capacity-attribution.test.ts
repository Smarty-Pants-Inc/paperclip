import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, issueQuestionResponseDeliveries, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput } from "../continuation-comment-input.js";
import { completedPersonMessageAnswerSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import { materializeNativeProviderCapacityRetry } from "./native-provider-capacity-retry.js";

// Agreed regression: the real materializer and PostgreSQL ANSWERED/settlement
// predicates must preserve attribution without re-delivering a consumed turn.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("capacity retry consumed-input attribution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("capacity-attribution-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  for (const kind of ["typed batch", "card"] as const) {
    it(`${kind}: successor answers -> no notice, no prompt input and no carry`, async () => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      const userId = `person-${randomUUID()}`, base = Date.now() - 900_000;
      await db.insert(companies).values({ id: companyId, name: "Capacity input regression", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", status: "active", adapterType: "paperclip_runner" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Answer my pending input", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
      const inputIds: string[] = [], inputDates: Date[] = [];
      let context: Record<string, unknown>;
      if (kind === "typed batch") {
        for (const offset of [0, 100]) {
          const [message] = await db.insert(issueComments).values({ companyId, issueId, body: `Pending question ${offset}`,
            authorType: "user", authorUserId: userId, createdAt: new Date(base + offset) }).returning();
          inputIds.push(message!.id); inputDates.push(message!.createdAt);
        }
        context = { issueId, wakeCommentId: inputIds[1], wakeCommentIds: inputIds,
          commentContinuation: true, queuedCommentSourceWakeIds: [randomUUID()],
          firstTurnQueuedInput: { commentIds: inputIds, runId: randomUUID(), wakeupRequestIds: [randomUUID()] } };
      } else {
        const [asker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
          nativeIssueId: issueId, contextSnapshot: { issueId }, createdAt: new Date(base - 2000), finishedAt: new Date(base - 1000) }).returning();
        const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: asker!.id,
          kind: "ask_user_questions", status: "answered", createdByAgentId: agentId, addresseeUserId: userId,
          createdAt: new Date(base), resolvedAt: new Date(base + 1000), resolvedByUserId: userId,
          payload: { version: 1, questions: [] } }).returning();
        inputIds.push(card!.id); inputDates.push(card!.resolvedAt!);
        context = { issueId, interactionId: card!.id, interactionIds: [card!.id], interactionStatus: "answered", source: "issue.interaction.respond" };
      }
      const [origin] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
        nativeIssueId: issueId, errorCode: "native_provider_overloaded", contextSnapshot: context,
        createdAt: new Date(base + 2000), startedAt: new Date(base + 2000), finishedAt: new Date(base + 3000) }).returning();
      if (kind === "card") await db.insert(issueQuestionResponseDeliveries).values({ companyId, issueId,
        interactionId: inputIds[0]!, targetRunId: origin!.id, correlationId: randomUUID(), payloadSha256: "0".repeat(64),
        status: "fallback_queued", deliveryMode: "wake_fallback", createdAt: new Date(base + 1500) });
      const successorId = await db.transaction(tx => materializeNativeProviderCapacityRetry({ tx: tx as unknown as Db, companyId, agentId, issueId, runId: origin!.id }));
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
      for (const stored of [successor!.contextSnapshot, wake!.payload]) {
        expect.soft(stored).toMatchObject({ [kind === "card" ? "attributionInteractionIds" : "attributionCommentIds"]: inputIds });
        for (const field of ["wakeCommentId", "wakeCommentIds", "commentId", "commentContinuation", "firstTurnQueuedInput",
          "queuedCommentSourceWakeIds", "interactionId", "interactionIds", "interactionStatus", "paperclipWakeComment", "paperclipTurnContext"]) {
          expect(stored).not.toHaveProperty(field);
        }
      }
      expect(await pendingContinuationCommentInput(db, { companyId, issueId, agentId, contextSnapshot: successor!.contextSnapshot })).toEqual({});
      await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
        finishedAt: new Date(base + 5000) }).where(eq(heartbeatRuns.id, successorId));
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date(base + 5000) }).where(eq(agentWakeupRequests.id, wake!.id));
      await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
        createdByRunId: successorId, body: "Here is the final answer to your input.", createdAt: new Date(base + 6000) });
      for (const [index, id] of inputIds.entries()) {
        const answered = completedPersonMessageAnswerSql({ id: sql`${id}::uuid`, companyId: sql`${companyId}::uuid`,
          issueId: sql`${issueId}::uuid`, createdAt: sql`${inputDates[index]!.toISOString()}::timestamptz` });
        expect.soft(await db.execute(sql`select ${answered} as answered`)).toEqual([{ answered: true }]);
      }
      await settleUnansweredPersonMessage(db, { companyId, issueId });
      await settleUnansweredPersonMessage(db, { companyId, issueId });
      const notices = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
        .filter(comment => comment.authorType === "system" && !comment.deletedAt && comment.metadata?.recoveryResponsibility !== "system");
      expect.soft(notices).toHaveLength(0);
      expect(await pendingContinuationCommentInput(db, { companyId, issueId, agentId, contextSnapshot: origin!.contextSnapshot })).toEqual({});
      console.log("CAPACITY_ATTRIBUTION_NO_REPLAY", JSON.stringify({ kind, origin: origin!.id, successor: successorId,
        inputIds, contextSnapshot: successor!.contextSnapshot, notices: notices.length, pending: [] }));
    });
  }
});
