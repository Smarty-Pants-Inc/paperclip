import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// KEEP: row 20, never-OK dead chat/file custody. Crash fixture = exactly the
// durable rows left AFTER cancellation and BEFORE lease release; there is no
// old in-process executor and, critically, NO saved releaseDeferral. Neither
// recovery, cancellation preservation, execution blocker nor wake admission is
// mocked. Only the provider turn is scripted, as in heartbeat-warm-stop-hold.
const providerTurns = vi.hoisted(() => [] as string[]);
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    providerTurns.push(input.execution.binding.runId);
    throw new Error("row20_successor_provider_turn_reached");
  }) as typeof actual.executePaperclipNativeSession };
});

import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { nativeRunNeverLaunchedRunner, readLeaseReleaseDeferral } from "../services/environment-lease-release-deferral.js";
import { readNativeWorkspaceSyncReference } from "../services/native-runtime/native-workspace-sync.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!support.supported)("rf-4 row 20: crash after durable cancel before active warm release", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("rf4-row20-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "rf4-row20-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "row20-person", name: "Person", email: "row20@example.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it("the next person's comment runs within 10s, or offers an honest Retry; owed files are never destroyed", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const stoppedAt = new Date(Date.now() - 60_000);
    const remoteCwd = path.join(home, "provider-task-workspace");
    await fs.mkdir(remoteCwd);
    const owedFile = path.join(remoteCwd, "notes.md");
    await fs.writeFile(owedFile, `task-workspace edit made before Stop, not yet exported: ${randomUUID()}\n`);
    const expectedSha = sha(await fs.readFile(owedFile));
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Row 20", issuePrefix,
      defaultResponsibleUserId: "row20-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "row20-person",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Warm crash source", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "fixture:test", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue my chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "row20-person", issueNumber: 1,
      identifier: `${issuePrefix}-1`, conversationAgentId: agentId, conversationUserId: "row20-person",
      conversationState: "active", executionRunId: null, checkoutRunId: null });
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
      workspaceId, leaseId, providerLeaseId, remoteCwd, resourceDisposition: "keep_running" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", nativePhase: "terminal_failure", invocationSource: "on_demand",
      status: "cancelled", errorCode: "cancelled", error: "Cancelled by a board operator",
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      controllerLeaseExpiresAt: new Date(stoppedAt.getTime() - 1),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { nativeWorkspaceSync: reference, nativeResourceDisposition: "keep_running" },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "row20-person", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
        reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString(),
      } } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null });
    // Prevent the startup/never-launched exception from disguising a mid-turn Stop.
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "tool.execution.started", stream: "system" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
      heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true,
        reusableSandboxLease: true, remoteCwd, agentId },
      acquiredAt: new Date(stoppedAt.getTime() - 60_000), lastUsedAt: stoppedAt,
      createdAt: new Date(stoppedAt.getTime() - 60_000), updatedAt: stoppedAt });

    // Fixture preconditions: no hold has been pre-seeded, the source is still
    // ACTIVE, the controller/finalizer owns nothing, and its v3 export is owed.
    const [before] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(before).toMatchObject({ status: "active", leasePolicy: "reuse_by_environment", releasedAt: null });
    expect(readLeaseReleaseDeferral(before.metadata)).toBeNull();
    expect(readNativeWorkspaceSyncReference(reference)).toMatchObject({ state: "prepared", leaseId });
    expect(await nativeRunNeverLaunchedRunner(db, runId, companyId)).toBe(false);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();

    const provider = getSandboxProvider("fake")!;
    // Real fake-provider lifecycle, observed at the provider boundary. If a
    // regression calls destroy, make its filesystem consequence observable too.
    const originalDestroy = provider.destroyLease.bind(provider);
    const destroy = vi.spyOn(provider, "destroyLease").mockImplementation(async input => {
      if (input.providerLeaseId === providerLeaseId) await fs.rm(remoteCwd, { recursive: true, force: true });
      return originalDestroy(input);
    });
    const stop = vi.spyOn(provider, "stopLease");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      // This NEW facade has no live executor; emulate the first restart pass,
      // not the ordinary warm Stop handler or the cancelled-workspace sweep.
      const sweep = await heartbeat.sweepOrphanedActiveLeases({ companyId, leaseId, backoffMs: 0 });
      const [afterSweep] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const holds = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: "row20-person", body: "Please answer using my kept notes.md." }).returning();
      const admissionAt = Date.now();
      await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "row20-person", payload: { issueId, commentId: comment.id },
        contextSnapshot: { issueId, commentId: comment.id, wakeReason: "issue_commented" } });
      // Real admission/dispatch, no manual successor insertion. Bound is wall
      // time, not fake timers. A fixed bounded/Retry path need not create a run.
      let messageRuns: (typeof heartbeatRuns.$inferSelect)[] = [];
      let blocker = await getExecutionBlocker(db, companyId, issueId);
      for (;;) {
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
          sql`(${heartbeatRuns.contextSnapshot}->>'commentId' = ${comment.id}
            OR ${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${comment.id}
            OR ${heartbeatRuns.contextSnapshot}->'wakeCommentIds' @> ${JSON.stringify([comment.id])}::jsonb)`));
        blocker = await getExecutionBlocker(db, companyId, issueId);
        if (messageRuns.some(run => providerTurns.includes(run.id)) || blocker?.canRetry || Date.now() - admissionAt >= 10_000) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      const sourceSha = await fs.readFile(owedFile).then(sha, () => null);
      const elapsedMs = Date.now() - admissionAt;
      const executed = messageRuns.length === 1 && providerTurns.includes(messageRuns[0].id);
      // The fallback must be actionable, not merely a reassuring resolved hold:
      // one nonempty truthful line saying the work is kept, with Retry enabled.
      const line = blocker?.nextAction ?? "";
      const actionable = blocker?.canRetry === true && line.trim().length > 0 && !/[\r\n]/.test(line)
        && /kept|preserv|saved|recover/i.test(line);
      console.log("ROW20_EVIDENCE", JSON.stringify({ base: "8d1fc3e6fd4419fd8122c3da68798211fe6319dd",
        companyId, issueId, runId, leaseId, providerLeaseId, commentId: comment.id,
        sweep, before, afterSweep, holds, blocker, wakes, messageRuns, providerTurns, elapsedMs,
        expectedSha, sourceSha, destroyCalls: destroy.mock.calls, stopCalls: stop.mock.calls, executed, actionable }));
      // Custody is checked BEFORE the expected RED, so a green file assertion
      // and zero provider destroys are independently visible on the base.
      expect(destroy.mock.calls.filter(([input]) => input.providerLeaseId === providerLeaseId)).toHaveLength(0);
      expect(sourceSha).toBe(expectedSha);
      expect(elapsedMs).toBeLessThan(12_000);
      expect(executed || actionable,
        `ROW20 DEAD CHAT: ${messageRuns.length} message runs; ${wakes.map(w => `${w.status}/runId=${w.runId}`).join(", ")}; `
        + `blocker.canRetry=${blocker?.canRetry}; nextAction=${line}`).toBe(true);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      destroy.mockRestore(); stop.mockRestore();
    }
  }, 60_000);
});
