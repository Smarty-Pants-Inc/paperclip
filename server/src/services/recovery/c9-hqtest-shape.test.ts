import { randomUUID } from "node:crypto";
import {
  agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import {
  settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition, unansweredPersonMessageCondition,
} from "./unanswered-person-message.js";

// The exact hq-test warm1/warm2 shape (platform-lead's DB read, 03:06Z):
// a person's last comment; the run carrying it (wakeCommentIds = exactly that
// comment) failed native_session_interrupted with finalization terminal_failure
// (attempt 1, next_attempt_at NULL); the issue is todo; one ACTIVE board-owned
// active_run_watchdog recovery action and one RESOLVED system one; no wakes.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("hq-test warm1/warm2 shape", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c9-hqtest-shape-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(chat: boolean) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `person-${randomUUID()}`;
    const base = Date.now() - 10 * 60_000;
    await db.insert(companies).values({ id: companyId, name: "hq-test shape", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Warm Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "warm chat", status: "todo", assigneeAgentId: agentId,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, body: "Are you there?", authorType: "user",
      authorUserId: userId, createdAt: new Date(base), updatedAt: new Date(base) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, errorCode: "native_session_interrupted",
      error: "native_session_recovery_failed: runner_remote_state_unavailable",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: message!.id, wakeCommentIds: [message!.id] },
      createdAt: new Date(base + 1_000), startedAt: new Date(base + 1_000), finishedAt: new Date(base + 10_000) }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: run!.id, phase: "terminal_failure", attempt: 1,
      nextAttemptAt: null });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      ownerType: "system", cause: "native_continuation_requires_reconciliation", fingerprint: `system:${run!.id}`,
      evidence: { runId: run!.id }, nextAction: "Reconcile the native continuation.", resolvedAt: new Date(base + 20_000) });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", cause: "native_session_interrupted", fingerprint: `board:${run!.id}`, evidence: { runId: run!.id },
      nextAction: "Inspect the original provider failure and explicitly resolve the ambiguous session state; do not open a replacement provider session" });
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(comment => comment.metadata?.recoveryResponsibility !== "system");
    return { companyId, agentId, issueId, messageId: message!.id, runId: run!.id, visible };
  }

  it.each([true, false])("chat=%s: discovery, the worker flag, the sweep and the decision (exactly one notice)", async chat => {
    const f = await seed(chat);
    const discovered = (await db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, f.issueId), unansweredPersonMessageCondition(issues.id, issues.companyId)))).length > 0;
    const flagged = (await db.select({ issueId: issueComments.issueId }).from(issueComments)
      .where(and(inArray(issueComments.issueId, [f.issueId]), unansweredPersonMessageCommentCondition()))).length > 0;
    const direct = await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(Date.now() - 1) });
    const afterDirect = (await f.visible()).length;
    let sweepError: string | null = null;
    let sweep: unknown = null;
    try {
      sweep = await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
        skipExternalConversationSettlement: true, skipRelatedRecovery: true, unanswered: flagged });
    } catch (error) { sweepError = String(error); }
    const notices = await f.visible();
    console.log("HQTEST_SHAPE", JSON.stringify({ chat, discovered, flagged, direct, afterDirect, sweepError,
      unansweredMessagesNoticed: (sweep as Record<string, unknown> | null)?.unansweredMessagesNoticed ?? null,
      notices: notices.map(n => ({ body: n.body, reason: n.metadata?.authorizationReason })) }));
    expect(discovered).toBe(true);
    expect(flagged).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it.each([true, false])("chat=%s: the real stranded sweep alone (as the worker calls it) gives exactly one notice", async chat => {
    const f = await seed(chat);
    let sweepError: string | null = null;
    try {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
        skipExternalConversationSettlement: true, skipRelatedRecovery: true, unanswered: true });
    } catch (error) { sweepError = String(error); }
    const notices = await f.visible();
    console.log("HQTEST_SWEEP", JSON.stringify({ chat, sweepError, notices: notices.map(n => n.metadata?.authorizationReason) }));
    expect(sweepError).toBeNull();
    expect(notices).toHaveLength(1);
  });
});
