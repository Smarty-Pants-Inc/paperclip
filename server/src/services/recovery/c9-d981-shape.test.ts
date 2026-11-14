import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as blockerModule from "../execution-blocker.js";
import { heartbeatService } from "../heartbeat.js";
import { UNRESTORED_FILES_NEXT_ACTION } from "../legacy-execution-recovery.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";

// PROD d981 (adopt-lead 03:13Z): a warm chat after the env move. Person comment
// -> run FAILED runner_remote_authority_archive_failed; the saved files could
// not be restored, so the recovery writer (legacy-execution-recovery.ts:225-255)
// left a RESOLVED, board-owned, replay-blocked active_run_watchdog hold whose
// nextAction is upstream's UNRESTORED_FILES_NEXT_ACTION (#21348): "... Press
// Retry ..." while Retry is NOT offered (canRetry=false). The platform kept
// re-queueing a wake that never ran. The person saw only that banner.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("d981 shape: unrestored saved files, Retry not offered", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c9-d981-shape-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `person-${randomUUID()}`;
    const base = Date.now() - 10 * 60_000;
    await db.insert(companies).values({ id: companyId, name: "d981 shape", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Warm Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "warm chat", status: "todo", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, body: "Can you check the build?", authorType: "user",
      authorUserId: userId, createdAt: new Date(base), updatedAt: new Date(base) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, errorCode: "native_session_interrupted", error: "runner_remote_authority_archive_failed",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: message!.id, wakeCommentIds: [message!.id] },
      createdAt: new Date(base + 1_000), startedAt: new Date(base + 1_000), finishedAt: new Date(base + 10_000) }).returning();
    // The exact shape legacy-execution-recovery.ts writes for an unrestored workspace.
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", status: "resolved", outcome: "blocked", ownerType: "board",
      fingerprint: `native-workspace:${run!.id}`, attemptCount: 1, resolvedAt: new Date(base + 20_000),
      evidence: { runId: run!.id, originalFailureCode: "native_session_interrupted", workspaceRestoreFailure: "restore_unsafe_archive",
        continuationDelivery: "invalidated",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: run!.id, replay: "blocked", actionOutcome: "unknown",
          recordedAt: new Date(base + 20_000).toISOString() } },
      nextAction: UNRESTORED_FILES_NEXT_ACTION });
    // The re-wake the platform kept queueing; it never ran.
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_continuation_needed",
      status: "queued", payload: { issueId } });
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(comment => comment.metadata?.recoveryResponsibility !== "system");
    return { companyId, agentId, issueId, messageId: message!.id, runId: run!.id, visible };
  }

  it("the banner names only an action the person can take: Retry is not offered, so it says to create a new task", async () => {
    const f = await seed();
    const blocker = await blockerModule.getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).not.toBeNull();
    expect(blocker!.canRetry).toBe(false);
    expect(blocker!.nextAction).toContain("saved files could not be put back");
    expect(blocker!.nextAction).not.toMatch(/\bRetry\b/);
    expect(blocker!.nextAction).toContain("Create a new task to continue the work.");
  });

  it("withoutUnavailableRetry: unchanged when Retry is offered; Retry instructions replaced when it is not", () => {
    const rewrite = (blockerModule as Record<string, unknown>).withoutUnavailableRetry as
      ((text: string, retryOffered: boolean) => string) | undefined;
    expect(typeof rewrite).toBe("function");
    expect(rewrite!(UNRESTORED_FILES_NEXT_ACTION, true)).toBe(UNRESTORED_FILES_NEXT_ACTION);
    expect(rewrite!(UNRESTORED_FILES_NEXT_ACTION, false)).toBe("The task's saved files could not be put back after the run stopped. "
      + "They are kept where they were and are not applied. Create a new task to continue the work.");
    expect(rewrite!("Saved work recovered. Retry or send a message to continue.", false))
      .toBe("Saved work recovered. Send a message to continue.");
    expect(rewrite!("Saved work recovered. Retry or send a message to continue.", true))
      .toBe("Saved work recovered. Retry or send a message to continue.");
    expect(rewrite!("Send a new chat message to continue this conversation.", false))
      .toBe("Send a new chat message to continue this conversation.");
  });

  it("B': the banner does not silence the message; after the bound it gets exactly one notice", async () => {
    const f = await seed();
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
      skipExternalConversationSettlement: true, skipRelatedRecovery: true, unanswered: true });
    expect(await f.visible()).toHaveLength(0);
    const later = new Date(Date.now() + 3 * 60_000);
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: later });
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: later });
    const notices = await f.visible();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${f.messageId}`);
  });
});
