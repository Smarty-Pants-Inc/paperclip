import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns,
  issueComments, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults,
  statusDecisions, workAssessments,
} from "@paperclipai/db";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { CONTINUATION_CAP_WINDOW_MS, evaluateAssignedWork, type AssignedWorkFacts } from "../services/recovery/assigned-work-invariant.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { issueService } from "../services/issues.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

// Only the execution boundary is controlled. The comment route, persisted wake,
// native result acceptance, assessment, arbiter and status commit are real.
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (db: ReturnType<typeof createDb>, ...args: unknown[]) => ({
    ...actual.heartbeatService(db, ...args as []),
    wakeup: async (agentId: string, opts: { reason?: string; source: string; triggerDetail?: string;
      payload?: Record<string, unknown>; requestedByActorType?: string; requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown> }) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId,
        source: opts.source, triggerDetail: opts.triggerDetail ?? "system", reason: opts.reason,
        requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId,
        payload: opts.payload, status: "queued" }).returning();
      return { id: wake.id };
    },
  }) };
});

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping response-wake sweep tests: ${recoveryPostgresSupport.reason}`);

describePostgres("ordinary assigned tasks awaiting a person's next response", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("assigned-work-response-wake-");
    db = createDb(temporary.connectionString);
  }, 240_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(options: { assignmentWake?: boolean; finalize?: boolean; declared?: boolean; beforeFinalize?: (f: {companyId: string; issueId: string}) => Promise<void> } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), runnerInstanceId = randomUUID();
    const startedAt = new Date(Date.now() - 10_000);
    await db.insert(companies).values({ id: companyId, name: "Response wait regression", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "codex_local", status: "idle", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep the answered task open", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "local-board", createdAt: new Date(startedAt.getTime() - 60_000) });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "local-board",
      body: "Report COBALT and keep this task open. Wait for my next comment.",
      createdAt: new Date(startedAt.getTime() - 1_000), updatedAt: new Date(startedAt.getTime() - 1_000) }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId,
      source: options.assignmentWake ? "assignment" : "automation", triggerDetail: "system",
      reason: options.assignmentWake ? "issue_assigned" : "issue_commented", status: "completed", runId,
      requestedByActorType: options.assignmentWake ? "system" : "user",
      requestedByActorId: options.assignmentWake ? "issue-assignment" : "local-board",
      payload: { issueId, ...(options.assignmentWake ? {} : { commentId: comment.id }) } }).returning();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v4", risk: "low",
      completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", objective: comment.body, criteria: [{ id: "objective", requirement: comment.body }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: runId, wakeupRequestId: wake.id, runnerInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, startedAt, createdAt: startedAt,
      contextSnapshot: { issueId, taskId: issueId, wakeCommentId: comment.id } });
    await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: runId,
      body: "COBALT. Kept open as requested; waiting for your next comment.", createdAt: new Date(startedAt.getTime() + 1_000) });
    if (options.declared === false) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), livenessState: "advanced" })
        .where(eq(heartbeatRuns.id, runId));
      return { companyId, agentId, issueId, runId, startedAt };
    }
    const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId, runId, sessionId: runId,
      completionContractId: contractId, completionContractSha256: contractId, sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `wait-regression-${runId}` });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
      summary: "COBALT was already answered. Task kept open per user. Wait for a new user comment.",
      continuation: { kind: "response_wake", summary: "Wait for the next person comment", idempotencyKey: `wait-${runId}` },
      completionClaim: { contractRevision: "1", objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
    terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } });
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
    expect(accepted.schemaStatus).toBe("accepted");
    await options.beforeFinalize?.({ companyId, issueId });
    if (options.finalize !== false) {
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
      expect(decision).toMatchObject({ applicationState: "applied", toStatus: "in_progress",
        reasonCode: options.assignmentWake ? "response_wake_waiting_for_input" : "board_response_waiting" });
      const [assessment] = await db.select().from(workAssessments).where(eq(workAssessments.id, decision.assessmentId));
      expect(assessment.assessmentJson).toMatchObject({ reportedDisposition: "yielded", continuation: { kind: "response_wake" } });
    }
    return { companyId, agentId, issueId, runId, startedAt };
  }

  function queue() {
    const enqueueWakeup = vi.fn(async (agentId: string, opts: { reason: string; payload: Record<string, unknown> }) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId,
        source: "automation", triggerDetail: "system", reason: opts.reason, payload: opts.payload, status: "queued" }).returning();
      return { id: wake.id };
    });
    return enqueueWakeup;
  }

  function clockAfterYield() { return new Date(Date.now() + 5 * 60_000); }

  async function answerState(f: { companyId: string; issueId: string }, id: string) {
    const [row] = await db.select({ answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
      .from(issueComments).where(eq(issueComments.id, id));
    return row.answered;
  }

  it.each([false, true])("TES-89: an answered accepted response_wake creates zero sweep wakes across a full cap window (assignment=%s)", async assignmentWake => {
    const f = await seed({ assignmentWake });
    const enqueueWakeup = queue();
    let clock = clockAfterYield();
    const end = clock.getTime() + CONTINUATION_CAP_WINDOW_MS;
    const sweep = assignedWorkSweep(db, { enqueueWakeup, now: () => clock });
    while (clock.getTime() <= end) {
      await sweep.checkIssue(f);
      clock = new Date(clock.getTime() + 60_000);
    }
    // Assert the failure itself before its explanatory verdict, so RED proves
    // a real unwanted continuation, not merely a missing new reason label.
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "issue_continuation_needed")))).toHaveLength(0);
    expect(await sweep.checkIssue(f)).toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "awaiting_person" } });
  }, 120_000);

  it("a newer person comment wakes exactly once through the existing comment route, not the sweep", async () => {
    const f = await seed();
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([import("../routes/issues.js"), import("../middleware/error-handler.js")]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [f.companyId], isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    await request(app).post(`/api/issues/${f.issueId}/comments`).send({ body: "Now report AMBER." }).expect(201);
    // The route commits the comment before its best-effort asynchronous wake.
    await vi.waitFor(async () => {
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.reason, "issue_commented"), eq(agentWakeupRequests.status, "queued")))).toHaveLength(1);
    }, { timeout: 10_000 });
    const enqueueWakeup = queue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield });
    await sweep.checkIssue(f);
    await sweep.checkIssue(f);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "queued")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].reason).toBe("issue_commented");
  }, 120_000);

  it("a newer person comment clears the wait even if its ordinary wake was lost", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "local-board",
      body: "New work after yielding", createdAt: new Date(Date.now() + 1_000) });
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f)).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["new", "answer"] as const)("a newer interaction (%s) clears the wait", async kind => {
    const f = await seed();
    const old = new Date(f.startedAt.getTime() - 5_000), fresh = new Date(Date.now() + 1_000);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId,
      kind: "request_confirmation", status: "resolved", idempotencyKey: `new-input-${f.runId}`, payload: { version: 1, prompt: "Next step?" },
      createdAt: kind === "new" ? fresh : old, updatedAt: fresh, resolvedAt: fresh });
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f)).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("an agent that never declared response_wake still gets the same repair", async () => {
    const f = await seed({ declared: false });
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f))
      .toMatchObject({ outcome: "repaired", verdict: { reason: "no_pending_path" } });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("an accepted result without an applied status decision is not an accepted wait", async () => {
    const f = await seed({ finalize: false });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), livenessState: "advanced" }).where(eq(heartbeatRuns.id, f.runId));
    // A failed/lost finalization is deliberately not pending recovery here.
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", recoveryState: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f)).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["run", "status", "assessment", "assignee"] as const)("a wait superseded by a newer %s does not suppress repair", async change => {
    const f = await seed();
    if (change === "run") {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", runtimeMode: "native",
        nativeIssueId: f.issueId, status: "succeeded", startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(Date.now() + 1_000),
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId } });
    } else if (change === "status") {
      await issueService(db).update(f.issueId, { status: "todo" });
      await issueService(db).update(f.issueId, { status: "in_progress" });
    } else if (change === "assessment") {
      const [prior] = await db.select().from(workAssessments).where(eq(workAssessments.runId, f.runId));
      const { id: _id, ...copy } = prior;
      await db.insert(workAssessments).values({ ...copy, inputDigest: randomUUID(), supersedesAssessmentId: prior.id,
        assessmentJson: { ...prior.assessmentJson, continuation: null }, createdAt: new Date(Date.now() + 1_000) });
    } else {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId: f.companyId, name: "New owner", adapterType: "codex_local", status: "idle", adapterConfig: {} });
      await issueService(db).update(f.issueId, { assigneeAgentId: id });
    }
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f)).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("a newer agent answer and a routine task touch do not clear a person's wait", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.runId, body: "Answer already delivered; still waiting", createdAt: new Date(Date.now() + 1_000) });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, f.issueId));
    const enqueueWakeup = queue();
    expect(await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f))
      .toMatchObject({ outcome: "ok", verdict: { reason: "awaiting_person" } });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("judge: a confirmation answer between result acceptance and assessment revokes the wait", async () => {
    let interactionId = "";
    const f = await seed({ assignmentWake: true, beforeFinalize: async f => {
      const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "request_confirmation", status: "answered", idempotencyKey: randomUUID(),
        payload: { version: 1, prompt: "Approve the next step?" }, resolvedByUserId: "local-board",
        createdAt: new Date(Date.now() - 60_000), resolvedAt: new Date() }).returning();
      interactionId = row.id;
    } });
    const enqueueWakeup = queue();
    const result = await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f);
    const chronology = await db.execute(sql`select r.created_at::text as result_accepted_at,
      greatest(t.created_at,t.updated_at,t.resolved_at)::text as confirmation_answer_at, a.created_at::text as assessment_at,
      (r.created_at < greatest(t.created_at,t.updated_at,t.resolved_at) and greatest(t.created_at,t.updated_at,t.resolved_at) < a.created_at) as answer_between_acceptance_and_assessment
      from native_run_results r join work_assessments a on a.result_id = r.id
      join issue_thread_interactions t on t.id = ${interactionId}::uuid where r.run_id = ${f.runId}::uuid`);
    console.info(JSON.stringify({ judgeInteractionDuringFinalize: { result, attempts: enqueueWakeup.mock.calls.length, chronology } }));
    expect(result).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("judge: an unanswered message arriving after the answer but before finalization must not be swallowed", async () => {
    let freshId = "";
    const f = await seed({ assignmentWake: true, beforeFinalize: async f => {
      const [row] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "local-board", body: "Actually, next do AMBER." }).returning();
      freshId = row.id;
    } });
    expect(await answerState(f, freshId)).toBe(false);
    const notice = await settleUnansweredPersonMessage(db, { ...f, now: clockAfterYield() });
    expect(notice).toMatchObject({ kind: "noticed", code: "no_run" });
    const enqueueWakeup = queue();
    const result = await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f);
    const chronology = await db.execute(sql`select r.schema_status, r.created_at::text as result_accepted_at,
      c.created_at::text as new_person_message_at, a.created_at::text as assessment_at,
      (r.created_at < c.created_at and c.created_at < a.created_at) as message_between_acceptance_and_assessment
      from native_run_results r join work_assessments a on a.result_id = r.id
      join issue_comments c on c.id = ${freshId}::uuid where r.run_id = ${f.runId}::uuid`);
    console.info(JSON.stringify({ judgeDuringFinalize: { result, attempts: enqueueWakeup.mock.calls.length, notice, chronology } }));
    expect(result).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("a lost run owner is still recovered after an accepted response wait", async () => {
    const f = await seed();
    const [lost] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", runtimeMode: "legacy", status: "running", createdAt: new Date(Date.now() + 1_000),
      controllerBootId: f.runId, controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
      controllerProcess: { bootId: f.runId, pid: 999999, hostHash: "gone-host", processStartedAt: f.startedAt.toISOString() },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId } }).returning();
    const settleLostRunProcess = vi.fn(async () => undefined);
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue(), now: clockAfterYield, settleLostRunProcess,
      proveOwner: async () => ({ verdict: "gone", reason: "controller_stopped" }) });
    expect(await sweep.checkIssue(f)).toMatchObject({ outcome: "settled_lost_run", verdict: { reason: "run_owner_gone" } });
    expect(settleLostRunProcess).toHaveBeenCalledWith({ companyId: f.companyId, runId: lost.id });
  });
});

it.each(["gone", "stalled"] as const)("the evaluator judges a %s owner before even a current person wait", owner => {
  const facts: AssignedWorkFacts & { awaitingPerson: boolean } = {
    issue: { status: "in_progress", assigneeAgentId: "agent", assigneeUserId: null, hidden: false,
      blockedTransitionAt: null, updatedAt: new Date(0), unblockOwner: null, monitorNextCheckAt: null,
      isConversation: false, awaitingFirstMessage: false },
    activeRuns: [{ id: "lost", status: "running", scheduledRetryAt: null, owner }], latestRun: null,
    pendingWakes: 0, nativeRecoveryPending: false, pendingHandoff: false, sessionGoal: null, interruption: null,
    pendingInteractions: 0, pendingApprovals: 0, openBlockers: 0, openChildren: 0, reviewPending: false,
    activeRecoveryAction: null, agent: { status: "idle", invokable: true }, companyPaused: false,
    pauseHold: false, budgetStop: false, blockedBy: null, awaitingPerson: true,
  };
  expect(evaluateAssignedWork(facts)).toMatchObject({ kind: "violation", reason: owner === "gone" ? "run_owner_gone" : "native_run_stalled" });
});
