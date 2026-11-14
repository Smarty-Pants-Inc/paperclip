import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, closeCheckpointDb, closeLivenessDb, companies, companyMemberships, createDb, environmentLeases, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { deliverConversationComments } from "../../services/agent-conversations.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { settleUnrecoverableExecutions } from "../../services/execution-recovery-resolution.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { issueService } from "../../services/issues.js";
import { persistHeartbeatRunProcessMetadata } from "../../services/heartbeat/run-lifecycle.js";

export const F1_REFUSALS = ["runner_harness_state_mismatch: resumed_unavailable",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding"] as const;
export const F1_HISTORY = "Remember ALDER-B from the saved conversation.";
export const F1_MESSAGE = "First new message: what word did I ask you to remember?";

/** Same stranded-owner/no-later-hold incident as RFL's window, without importing
 * its unrelated historical tests or leaking their runs into this fixture. */
export async function f1PersonFlow(refusal: string, clock: "real" | "advancing") {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-f1-person-flow-");
  const db: Db = createDb(database.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH } });
  await once(child, "spawn");
  const pid = child.pid!;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  const t0 = Date.now(), userId = randomUUID(), sessionId = randomUUID();
  const [user] = await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).returning();
  const [company] = await db.insert(companies).values({ name: "F1 person", issuePrefix: "F1P", defaultResponsibleUserId: user.id }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: user.id,
    status: "active", membershipRole: "owner" });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Saved work", role: "engineer", status: "idle",
    adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue the saved conversation", status: "in_progress",
    responsibleUserId: user.id, assigneeAgentId: agent.id, conversationAgentId: agent.id,
    conversationUserId: user.id, conversationState: "active" }).returning();
  const [owner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
    nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "running", nativePhase: null,
    responsibleUserId: user.id, createdAt: new Date(t0 - 600_000), contextSnapshot: { issueId: issue.id, conversation: true, conversationSessionGeneration: 0 } }).returning();
  await persistHeartbeatRunProcessMetadata(db, owner.id, { pid, processGroupId: pid, startedAt: new Date().toISOString(), targetKind: "remote" });
  await db.insert(nativeRunFinalizations).values({ runId: owner.id, companyId: company.id, issueId: issue.id,
    phase: "observed", attempt: 2, leaseOwner: "prior-native-owner", leaseExpiresAt: new Date(0) });
  const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, heartbeatRunId: owner.id,
    provider: "boat", providerLeaseId: `closed-${owner.id}`, status: "released", cleanupStatus: "success",
    acquiredAt: new Date(t0 - 600_000), releasedAt: new Date(t0 - 300_000) }).returning();
  await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: {
    schema: "paperclip.remote-termination.v1", companyId: company.id, runId: owner.id, leaseId: lease.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: lease.releasedAt!.toISOString(),
  } } }).where(eq(environmentLeases.id, lease.id));
  const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
    nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
    errorCode: refusal, error: refusal, responsibleUserId: user.id, createdAt: new Date(t0 - 120_000), finishedAt: new Date(t0 - 60_000),
    contextSnapshot: { issueId: issue.id, conversation: true, conversationSessionGeneration: 0 } }).returning();
  await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id,
    phase: "terminal_failure", failureCode: refusal, recoveryState: "blocked" });
  await db.insert(issueComments).values([
    { companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: user.id, body: F1_HISTORY, createdAt: new Date(t0 - 250_000) },
    { companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id, body: "Noted ALDER-B.", createdAt: new Date(t0 - 240_000) },
  ]);
  if (clock === "advancing") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const hb = heartbeatService(db, { runtimeEnv: { PAPERCLIP_NATIVE_RUNTIME_ENABLED: "true" } });
  const errors: unknown[] = [], passes = new Set<Promise<unknown>>();
  const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
  const register = coordinator.register.bind(coordinator);
  coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
    const pass = Promise.resolve(task.run(signal)); passes.add(pass);
    void pass.then(() => passes.delete(pass), () => passes.delete(pass)); return pass;
  } });
  const snapshot = async () => ({
    refusal, clock, elapsedMs: Date.now() - t0, ownerId: owner.id, sourceId: source.id,
    issue: (await db.select().from(issues).where(eq(issues.id, issue.id)))[0],
    blocker: await getExecutionBlocker(db, company.id, issue.id),
    runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id)),
    comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)),
    actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)),
    events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, company.id)),
    errors,
  });
  return {
    db, owner, source, sessionId, issue, hb, snapshot,
    async start() {
      await hb.registerResidualRecoveryWork(coordinator, () => true).ready;
      await hb.registerActiveRunSilenceWork(coordinator, () => true).ready;
      await hb.registerIssueStateRecoveryWork(coordinator, () => true).ready;
      await hb.registerDeferredReceiptWork(coordinator, () => true).ready;
      await hb.registerRunDispatchWork(coordinator, () => true).ready;
      await hb.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
      // Exactly one person action. No direct fallback, manual queued execution,
      // later-source hold, rescue send, or provider capability change in product.
      await issueService(db).addComment(issue.id, F1_MESSAGE, { userId: user.id }, { clientRequestId: randomUUID() });
      await deliverConversationComments(db, issue, hb.wakeup);
      await hb.drainActiveRunExecutions();
      await hb.reapOrphanedRuns();
      await settleUnrecoverableExecutions(db);
      await hb.reconcileStrandedAssignedIssues();
      await hb.drainActiveRunExecutions();
      await Promise.allSettled([...passes]);
    },
    async untilSubmitted(requireEvent = false) {
      const deadline = t0 + 120_000;
      for (;;) {
        const row = await snapshot();
        if (row.events.some(event => event.eventType === "turn.submitted") || (!requireEvent &&
          row.runs.some(run => run.id !== owner.id && run.id !== source.id && run.runnerProfileJson?.nativeExecutionInput))) return row;
        if (row.runs.some(run => run.id !== owner.id && run.id !== source.id && run.status === "failed") || Date.now() >= deadline) return row;
        if (clock === "advancing") await vi.advanceTimersByTimeAsync(Math.min(500, deadline - Date.now()));
        else await delay(20);
        await immediate();
        await hb.drainActiveRunExecutions();
        await Promise.allSettled([...passes]);
      }
    },
    async cleanup() {
      await coordinator.stop();
      await hb.drainActiveRunExecutions();
      await Promise.allSettled([...passes]);
      vi.useRealTimers();
      try {
        await closeLivenessDb(db, 0);
        await closeCheckpointDb(db, 0);
        await db.$client.end({ timeout: 0 });
      } finally { await database.cleanup(); }
    },
    async evidence(label: string) {
      const row = await snapshot();
      if (process.env.TASK_OUT) await appendFile(`${process.env.TASK_OUT}/${label}.jsonl`, JSON.stringify(row) + "\n");
      return row;
    },
  };
}
