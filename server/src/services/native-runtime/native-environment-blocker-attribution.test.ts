// ENVIRONMENT-BLOCKER twin of rf-5's rf5-capacity-retry judge (stack tA, R3-1): the real
// materializeNativeEnvironmentBlockerRetry (and unit 1's cut lane, the same shared function)
// keeps the origin's own pending input for ANSWERED attribution only. Typed + card.
import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { materializeNativeEnvironmentBlockerRetry, materializeNativeMidStreamCutRetry } from "./native-provider-capacity-retry.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE } from "./native-environment-blocker.js";
import { pendingContinuationCommentInput } from "../continuation-comment-input.js";
import { completedPersonMessageAnswerSql } from "../person-message-answer.js";
import { heartbeatService } from "../heartbeat.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("environment-blocker / cut-lane retry: consumed-input attribution (R3-1 twin)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("envblocker-attribution-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const lanes = { environment: { materialize: materializeNativeEnvironmentBlockerRetry, errorCode: NATIVE_ENVIRONMENT_BLOCKER_CODE },
    cut: { materialize: materializeNativeMidStreamCutRetry, errorCode: "native_run_failed" } } as const;
  for (const lane of ["environment", "cut"] as const) for (const kind of ["typed", "card"] as const)
    it(`${lane} retry: pending ${kind} input -> actual successor final -> ANSWERED by own input, no false notice, nothing replayed`, async () => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `user-${randomUUID()}`, base = Date.now() - 900_000;
      await db.insert(companies).values({ id: companyId, name: "Env retry attribution", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "active", adapterType: "paperclip_runner",
        adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Answer my pending input", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
      let inputId: string, inputAt: Date;
      if (kind === "typed") {
        const [m] = await db.insert(issueComments).values({ companyId, issueId, body: "Please answer my saved question.", authorType: "user", authorUserId: userId, createdAt: new Date(base) }).returning();
        inputId = m!.id; inputAt = m!.createdAt;
      } else {
        const [asker] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId }, createdAt: new Date(base - 2000), finishedAt: new Date(base - 1000) }).returning();
        const [q] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: asker!.id, kind: "ask_user_questions", status: "answered", createdByAgentId: agentId, addresseeUserId: userId,
          createdAt: new Date(base), resolvedAt: new Date(base + 1000), resolvedByUserId: userId, payload: { version: 1, questions: [] } }).returning();
        inputId = q!.id; inputAt = q!.resolvedAt!;
      }
      const context = { issueId, ...(kind === "typed" ? { wakeCommentId: inputId, wakeCommentIds: [inputId], commentContinuation: true,
        firstTurnQueuedInput: { commentIds: [inputId], runId: randomUUID(), wakeupRequestIds: [randomUUID()] } }
        : { interactionId: inputId, interactionStatus: "answered", source: "issue.interaction.respond" }) };
      const [origin] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId, errorCode: lanes[lane].errorCode, contextSnapshot: context,
        createdAt: new Date(base + 2000), startedAt: new Date(base + 2000), finishedAt: new Date(base + 3000) }).returning();
      const successorId = await db.transaction(async tx => lanes[lane].materialize({ tx: tx as unknown as Db, companyId, agentId, issueId, runId: origin!.id }));
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorId));
      expect(successor!.retryOfRunId).toBe(origin!.id);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
      for (const stored of [successor!.contextSnapshot, wake!.payload]) {
        expect.soft(stored).toMatchObject({ [kind === "card" ? "attributionInteractionIds" : "attributionCommentIds"]: [inputId] });
        // Attribution ONLY: nothing a prompt builder or the first-turn seal reads.
        for (const field of ["wakeCommentId", "wakeCommentIds", "commentId", "commentContinuation", "firstTurnQueuedInput",
          "queuedCommentSourceWakeIds", "interactionId", "interactionIds", "interactionStatus", "paperclipWakeComment", "paperclipTurnContext"]) expect(stored, field).not.toHaveProperty(field);
      }
      expect(await pendingContinuationCommentInput(db, { companyId, issueId, agentId, contextSnapshot: successor!.contextSnapshot })).toEqual({});
      await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativeIssueId: issueId, error: null, errorCode: null, finishedAt: new Date(base + 5000) }).where(eq(heartbeatRuns.id, successorId));
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date(base + 5000) }).where(eq(agentWakeupRequests.id, successor!.wakeupRequestId!));
      await db.insert(issueComments).values({ companyId, issueId, body: "Here is the final answer to your saved input.", authorType: "agent", authorAgentId: agentId, createdByRunId: successorId, createdAt: new Date(base + 6000) });
      const answeredSql = completedPersonMessageAnswerSql({ id: sql`${inputId}::uuid`, companyId: sql`${companyId}::uuid`, issueId: sql`${issueId}::uuid`, createdAt: sql`${inputAt.toISOString()}::timestamptz` });
      expect.soft(await db.execute(sql`select ${answeredSql} as answered`)).toEqual([{ answered: true }]);
      await settleUnansweredPersonMessage(db, { companyId, issueId }); await settleUnansweredPersonMessage(db, { companyId, issueId });
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId, skipRelatedRecovery: true, skipExternalConversationSettlement: true, unanswered: true } as never);
      const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(n => n.authorType === "system" && !n.deletedAt && n.metadata?.recoveryResponsibility !== "system");
      console.log("ENV_BLOCKER_RETRY_TWIN", JSON.stringify({ lane, kind, inputId, origin: origin!.id, successor: successorId, contextSnapshot: successor!.contextSnapshot, notices: notes.map(n => ({ id: n.id, body: n.body })) }));
      expect(notes, "the actual successor answered the pending input; no false notice").toHaveLength(0);
      expect(await pendingContinuationCommentInput(db, { companyId, issueId, agentId, contextSnapshot: origin!.contextSnapshot }), "ANSWERED input is never carried again").toEqual({});
    });
});
