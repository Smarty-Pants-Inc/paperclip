import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { ensureFreshContinuation } from "../services/fresh-continuation-fallback.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const suite = recoveryPostgresSupport.supported ? describe : describe.skip;
const HOUR = 3_600_000;

// RED-first integration: exercise production discovery, recovery and actual
// heartbeat admission. An occupied slot keeps the successor queued, so no
// provider or external service executes.
suite("chat-gap round-2 production path", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chatgap-r2-e2e-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 240_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(status: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const runId = randomUUID(), messageId = randomUUID();
    const at = (hours: number) => new Date(Date.now() - hours * HOUR);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.test`, emailVerified: true,
      createdAt: at(6), updatedAt: at(6) });
    await db.insert(companies).values({ id: companyId, name: "Round-2 chat fixture", issuePrefix: `R${companyId.slice(0, 7)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", adapterType: "paperclip_runner", status: "idle",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Unanswered person message", status, assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", createdAt: at(6), updatedAt: at(3) });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorUserId: userId, authorType: "user",
      body: "Please answer this question.", createdAt: at(5), updatedAt: at(5) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "native", nativeIssueId: issueId,
      status: "failed", errorCode: "native_continuation_requires_reconciliation", nativePhase: "terminal_failure",
      responsibleUserId: userId, createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, taskId: issueId, wakeCommentId: messageId } });
    return { companyId, agentId, issueId, userId, runId, messageId, at };
  }
  async function occupySlot(f: Awaited<ReturnType<typeof seed>>) {
    const occupiedIssue = randomUUID();
    await db.insert(issues).values({ id: occupiedIssue, companyId: f.companyId, title: "Occupied slot", status: "in_progress", assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: occupiedIssue,
      status: "running", contextSnapshot: { issueId: occupiedIssue } });
  }
  async function finalize(f: Awaited<ReturnType<typeof seed>>) {
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
  }
  async function createRecoveryHold(f: Awaited<ReturnType<typeof seed>>) {
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${f.runId}`,
      nextAction: "Reconcile the unfinished native run before continuing.", maxAttempts: 3, createdAt: f.at(4),
      evidence: { runId: f.runId, originalFailureCode: "native_continuation_requires_reconciliation",
        nativeFailureBlock: { runId: f.runId, statusVersion: 4 } } });
  }
  async function assertNoContinuation(f: Awaited<ReturnType<typeof seed>>) {
    const heartbeat = heartbeatService(db);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    const records = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId)));
    const record = records.find(row => row.evidence.freshContinuation);
    expect(successors).toHaveLength(0);
    expect(record).toBeUndefined();
  }

  it.each(["todo", "in_progress", "blocked"] as const)("selector -> fallback -> real queue refuses a continuation for unanswered %s chat", async status => {
    const f = await seed(status);
    await finalize(f);
    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
    const suspects = await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    expect(suspects.map(row => row.id)).toContain(f.issueId);
    if (status === "blocked") await db.update(issues).set({ statusVersion: 4, blockedTransitionAt: f.at(4) }).where(eq(issues.id, f.issueId));
    await createRecoveryHold(f);
    expect(await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned" });
    await occupySlot(f);
    await assertNoContinuation(f);
  }, 60_000);

  it("fallback -> delivery -> real queue refuses a continuation for unanswered in_review chat", async () => {
    const f = await seed("in_review");
    await finalize(f);
    await occupySlot(f);
    expect(await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned" });
    await assertNoContinuation(f);
  }, 60_000);

  it("an answered chat is absent from production suspects and never gets a wake", async () => {
    const f = await seed("in_progress");
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: f.runId, origin: "comment", body: "Here is the answer.", createdAt: f.at(3) });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup: enqueueWakeup as never });
    const suspects = await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    expect(suspects.map(row => row.id)).not.toContain(f.issueId);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "conversation" } });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  }, 60_000);
});
