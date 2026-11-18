import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns,
  issueComments, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults,
  statusDecisions, workAssessments,
} from "@paperclipai/db";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { CONTINUATION_CAP_WINDOW_MS, evaluateAssignedWork, type AssignedWorkFacts } from "../services/recovery/assigned-work-invariant.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { issueService } from "../services/issues.js";
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

import { answeredPersonMessageSql } from "../services/continuation-comment-input.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping response-wake sweep tests: ${recoveryPostgresSupport.reason}`);

describePostgres("independent judge: ordinary assigned tasks awaiting a person's next response", () => {
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

  async function seed(options: { assignmentWake?: boolean; finalize?: boolean; declared?: boolean; beforeResult?: (f: {companyId: string; issueId: string}) => Promise<void>; beforeFinalize?: (f: {companyId: string; issueId: string}) => Promise<void> } = {}) {
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
    await options.beforeResult?.({ companyId, issueId });
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

  it.each(["comment", "interaction"] as const)("round2: input after reply/last read but BEFORE accepted result (%s)", async kind => {
    let freshId = "";
    const f = await seed({ assignmentWake: true, beforeResult: async f => {
      if (kind === "comment") {
        const [row] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "local-board", body: "After your last read: now do AMBER." }).returning();
        freshId = row.id;
      } else {
        const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
          kind: "request_confirmation", status: "answered", idempotencyKey: randomUUID(),
          payload: { version: 1, prompt: "Approve the next step?" }, resolvedByUserId: "local-board",
          createdAt: new Date(Date.now() - 60_000), resolvedAt: new Date() }).returning();
        freshId = row.id;
      }
    } });
    const chronology = await db.execute(sql`select r.created_at::text as accepted_at, a.created_at::text as assessed_at,
      h.started_at::text as started_at, h.finished_at::text as finished_at,
      (select max(c.created_at)::text from issue_comments c where c.issue_id = r.issue_id and c.author_type = 'agent') as reply_at,
      coalesce((select greatest(c.created_at,c.updated_at)::text from issue_comments c where c.id = ${freshId}::uuid),
        (select greatest(t.created_at,t.updated_at,t.resolved_at)::text from issue_thread_interactions t where t.id = ${freshId}::uuid)) as new_input_at
      from native_run_results r join work_assessments a on a.result_id = r.id
      join heartbeat_runs h on h.id = r.run_id where r.run_id = ${f.runId}::uuid`);
    const enqueueWakeup = queue();
    const result = await assignedWorkSweep(db, { enqueueWakeup, now: clockAfterYield }).checkIssue(f);
    const unanswered = kind === "comment" ? await answerState(f, freshId) : null;
    console.info(JSON.stringify({ round2BeforeResult: { kind, chronology, result, unanswered, attempts: enqueueWakeup.mock.calls.length } }));
    if (kind === "comment") expect(unanswered).toBe(false);
    expect(result).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });
});
