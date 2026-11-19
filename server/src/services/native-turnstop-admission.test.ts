import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import * as executor from "./native-runtime/native-session-executor.js";
import * as runtime from "../vendor/paperclip-runner/index.js";
import * as preservation from "./native-runtime/native-failed-workspace-recovery.js";
import * as cleanup from "./execution-blocker.js";
import * as freshWorkspace from "./fresh-workspace-continuation.js";
import { settleWarmRetention } from "./environment-warm-retention.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";

// DB-backed reader/caller regressions. The clean-stop producer is injected here;
// real executor/Runner/Pi acceptance belongs to the opt-in turnstop fixture.
describe("tier 1 allocation accounting and continuation safety gates", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("tier1-admission-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Tier 1 caller regression", issuePrefix: `T${companyId.replaceAll("-", "")}`, defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped task", status: "blocked", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, issueId,
      runtimeMode: "native", status: "cancelled", startedAt: new Date("2026-11-12T09:00:00Z"), finishedAt: new Date("2026-11-12T10:00:00Z"),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run", reasonCode: "cancellation_run_only",
        dispatched: true, dispatchState: "acknowledged", intentAuditId: "intent", acknowledgementAuditId: "ack" } },
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeRetainedIdleCheckpoint: {
        schema: "paperclip.native-retained-idle-checkpoint.v1", companyId, issueId, runId, sessionId: "session", bootId: "boot", generation: 1 } },
      contextSnapshot: { issueId } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "terminal_failure" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", cause: "uncertain_external_action",
      fingerprint: runId, status: "resolved", outcome: "blocked", nextAction: "New input only", evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "board", body: "What happened?",
      createdAt: new Date("2026-11-12T11:00:00Z") });
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `Tier1-${environmentId}`, driver: "sandbox" });
    const lease = async () => (await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: runId, issueId,
      provider: "boat", providerLeaseId: randomUUID(), leasePolicy: "reuse_by_environment", status: "active", metadata: { warmFailureStreak: 1 } }).returning())[0]!;
    return { companyId, agentId, issueId, runId, commentId, run: run!, lease };
  }
  it("T1-A does not reset the mismatched allocation's durable failure streak", async () => {
    const f = await seed(), l1 = await f.lease(), l2 = await f.lease();
    const proof = vi.spyOn(executor, "hasRetainedNativeTurnStop").mockImplementation((_run, lease) => !lease || lease.id === l1.id);
    try {
      const hit = await settleWarmRetention(db, l1, "keep_running");
      const miss = await settleWarmRetention(db, l2, "keep_running");
      expect(hit?.lease.metadata?.warmFailureStreak).toBe(0);
      expect(miss?.disposition).toBe("stop_and_retain");
      expect(miss?.lease.metadata).toMatchObject({ warmFailureStreak: 2, warmFailureRunId: f.runId,
        warmRetentionReasonCode: "warm_retention_failure_limit" });
      expect(proof).toHaveBeenCalledWith(expect.objectContaining({ id: f.runId }), expect.objectContaining({ id: l2.id, status: "active" }), { settlingAllocation: true });
    } finally { proof.mockRestore(); }
  });
  it.each(["preservation", "pending_cleanup", "quarantine", "empty_leases", "mixed_leases", "fresh_intent", "clean"] as const)("T1-C keeps the %s gate despite a positive clean-stop producer", async mode => {
    const f = await seed();
    let matchingLeaseId: string | undefined;
    if (mode !== "empty_leases") {
      const lease = await f.lease();
      matchingLeaseId = lease.id;
      await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, lease.id));
      if (mode === "mixed_leases") await f.lease();
    }
    const proof = vi.spyOn(executor, "hasRetainedNativeTurnStop").mockImplementation((_run, lease) => !lease || mode !== "mixed_leases" || lease.id === matchingLeaseId);
    const fresh = vi.spyOn(freshWorkspace, "canSelectFreshWorkspace").mockResolvedValue(mode === "fresh_intent" ? "fresh-intent" : null);
    const quarantine = vi.spyOn(runtime, "nativeSessionCleanupBlock").mockReturnValue(mode === "quarantine" ? "operator_required" : null);
    const preserve = vi.spyOn(preservation, "preserveNativeFailedWorkspace").mockResolvedValue(mode === "preservation"
      ? { ...f.run, resultJson: { ...f.run.resultJson, workspaceRestoreFailure: "restore_failed",
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } } } : undefined);
    const pending = vi.spyOn(cleanup, "hasPendingRunCleanup").mockResolvedValue(mode === "pending_cleanup");
    const blocked: string[] = [];
    try {
      const result = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
        commentId: f.commentId, actorType: "user", actorId: "board", reason: "issue_commented", dryRun: true, successorRunId: randomUUID(),
        onBlocked: reason => blocked.push(reason) });
      expect(preserve, JSON.stringify({ result, blocked })).toHaveBeenCalledOnce();
      if (mode === "fresh_intent") {
        expect(result?.readiness).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.runId, retryIntentId: "fresh-intent" });
        expect(result).not.toHaveProperty("retainedNativeTurnStop");
      } else if (mode === "clean") expect(result).toMatchObject({ previousRunId: f.runId, retainedNativeTurnStop: true });
      else expect(result).toBeNull();
      if (mode === "mixed_leases") expect(blocked).toContain("remote_cleanup");
      if (mode === "preservation") expect(blocked).toContain("workspace_repair_required");
      if (mode === "pending_cleanup") expect(blocked).toContain("cleanup_pending");
      if (mode === "quarantine") expect(blocked).toContain("local_cleanup");
      if (mode === "empty_leases") expect(blocked).not.toHaveLength(0);
    } finally { fresh.mockRestore(); quarantine.mockRestore(); pending.mockRestore(); preserve.mockRestore(); proof.mockRestore(); }
  });
});
