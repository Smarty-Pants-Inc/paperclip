import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeStartupNeverConnectedExhausted } from "../continuation-cause.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { continueHeldExecutions, FRESH_CONTINUATIONS_PER_CHAIN, FRESH_CONTINUATIONS_PER_HOUR } from "../fresh-continuation-fallback.js";
import { freshThreadStartedNote } from "./fresh-thread-stop-gate.js";

// Keep reason: recorded Boat-outage failure path; use the actual PostgreSQL
// hold/disposition owners rather than a mock of the continuation decision.
// Start at the durable executor settlement, not a live provider outage. The
// existing controller-recovery tests own proof production and in-run retries.
describe("runner ingress acquisition at the exhausted-run continuation boundary", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-ingress-continuation-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Ingress continuation", issuePrefix: "RIC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {} });
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(input: { httpStatus?: number; startup?: boolean; agentEvent?: "tool.execution.started" | "item.completed" }) {
    const issueId = randomUUID(), runId = randomUUID();
    const originalFailureCode = input.startup ? "runner_ingress_startup_failed" : "runner_ingress_acquisition_failed";
    // Non-transient statuses, or any provider event, fail closed before an
    // exhausted bootstrap record can be produced by the existing executor.
    const bootstrap = input.startup || (!input.agentEvent && (input.httpStatus === 429 || (input.httpStatus ?? 0) >= 500));
    const failureCode = bootstrap ? "native_session_retry_exhausted" : originalFailureCode;
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after endpoint outage",
      status: "blocked", assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      nativeSessionId: randomUUID(), runtimeMode: "native", nativePhase: "terminal_failure", status: "failed",
      errorCode: originalFailureCode, error: "Runner endpoint acquisition failed.", invocationSource: "assignment",
      startedAt: new Date(finishedAt.getTime() - 120_000), createdAt: new Date(finishedAt.getTime() - 180_000), finishedAt,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    if (input.agentEvent) {
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, stream: "system", level: "info",
        eventType: input.agentEvent, payload: input.agentEvent === "tool.execution.started"
          ? { executionId: randomUUID(), toolName: "shell" } : { kind: "agentMessage", text: "I started the task." } });
    }
    const failureDetail = {
      originalFailureCode,
      ...(input.startup ? {} : { runnerIngressFailure: { phase: "private_preview", httpStatus: input.httpStatus } }),
      recoveryMode: bootstrap ? "bootstrap_retry" : "ambiguous_state",
      providerSessionEstablished: Boolean(input.agentEvent),
      providerEventsExist: Boolean(input.agentEvent),
      checkpointExists: false,
    };
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      attempt: bootstrap ? 3 : 1, failureCode, failureDetail, recoveryState: "blocked" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: failureCode,
      fingerprint: `native-retry:${runId}`, maxAttempts: 3, nextAction: "Automatic retries are stopped.",
      evidence: { runId, coordinatorAttempt: bootstrap ? 3 : 1, recoveryDisposition: failureCode,
        nativeFailureBlock: { runId, statusVersion: 4 } } });
    return { issueId, runId };
  }

  async function read(seeded: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    const continued = await db.select().from(activityLog).where(and(eq(activityLog.entityId, seeded.issueId),
      eq(activityLog.action, "issue.continued_from_saved_work")));
    return { run: run!, coordinator: coordinator!, issue: issue!, actions, continued };
  }

  async function sweep() {
    await settleUnrecoverableExecutions(db);
    await continueHeldExecutions(db);
  }

  it.each([{ httpStatus: 503 }, { httpStatus: 429 }, { startup: true }])(
    "after three attempts, continues once with the existing cause/limits and truthful fresh-run note: %j", async input => {
      const seeded = await seed(input);
      const exhausted = await read(seeded);
      expect(exhausted.coordinator).toMatchObject({ attempt: 3, phase: "terminal_failure",
        failureCode: "native_session_retry_exhausted", nextAttemptAt: null });
      expect(nativeStartupNeverConnectedExhausted(exhausted.coordinator)).toBe(true);
      await sweep();
      await sweep();
      const state = await read(seeded);
      expect(state.continued).toHaveLength(1);
      expect(state.continued[0]!.details).toMatchObject({ failureCode: input.startup
        ? "runner_ingress_startup_failed" : "runner_ingress_acquisition_failed", trigger: "recovery_refused" });
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, seeded.issueId),
        sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
      expect(action).toMatchObject({ ownerType: "system", status: "resolved", outcome: "restored",
        evidence: { continuationDelivery: "pending", freshContinuation: { sourceRunId: seeded.runId } } });
      expect(state.issue.status).not.toBe("blocked");
      expect(await freshThreadStartedNote(db, state.run))
        .toBe("Provider startup failed 3 times before any work began; starting again in a fresh run.");
      // The continuation enters the same existing bounded path, not a new
      // budget or a bypass of the task/chain limits.
      expect(FRESH_CONTINUATIONS_PER_CHAIN).toBe(2);
      expect(FRESH_CONTINUATIONS_PER_HOUR).toBe(6);
    },
  );

  it.each([
    { httpStatus: 400 },
    { httpStatus: 503, agentEvent: "tool.execution.started" as const },
    { httpStatus: 503, agentEvent: "item.completed" as const },
  ])("keeps the board hold for %j", async input => {
    const seeded = await seed(input);
    const before = await read(seeded);
    expect(nativeStartupNeverConnectedExhausted(before.coordinator)).toBe(false);
    await sweep();
    await sweep();
    const state = await read(seeded);
    expect(state.continued).toEqual([]);
    expect(state.issue.status).toBe("blocked");
    expect(state.actions).toMatchObject([{ ownerType: "board", status: "active", cause: "runner_ingress_acquisition_failed" }]);
    expect(state.coordinator.nextAttemptAt).toBeNull();
  });
});
