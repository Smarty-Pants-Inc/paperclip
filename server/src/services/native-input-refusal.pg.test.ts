import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issueComments, issues, agentWakeupRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { guardNativeTurnCommands, nativeInputRevision } from "./native-runtime/native-turn-budget.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { nativeInputRefusalEvidence } from "./native-input-refusal.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("native-input-refusal-pg-");
  db = createDb(database.connectionString);
}, 120_000);
afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

it("holds automatic wakes after one oversized message and admits an automatic wake after delete plus a short message", async () => {
  const now = new Date(), user = randomUUID();
  await db.insert(authUsers).values({ id: user, name: "Input owner", email: user + "@example.test", createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Input refusal regression", issuePrefix: "ROW" }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: user, status: "active", membershipRole: "operator" });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Input worker", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Answer the request", description: "Short request.", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: user }).returning();
  const [message] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: user, body: "x".repeat(600_038) }).returning();
  const revision = nativeInputRevision(issue, [{ id: message.id, authorType: "user", updatedAt: message.updatedAt.toISOString(), deleted: false }]);
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", runtimeMode: "native", issueId: issue.id, nativeIssueId: issue.id, responsibleUserId: user, contextSnapshot: { issueId: issue.id, nativeInputRevision: revision }, startedAt: now }).returning();
  const build = (runId: string, text: string) => buildNativeExecutionInput({
    companyId: company.id, agentId: agent.id, runId, issue: { ...issue, workMode: "standard" }, taskPrompt: text,
    inputRevision: revision, provider: "pi_rpc", boundCommandBytes: true, normalizedSessionId: null,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer the request" }] } },
  });
  let error: unknown;
  try { build(run.id, message.body); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "native_turn_prompt_exceeds_command_bound" });
  await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_turn_prompt_exceeds_command_bound", finishedAt: new Date(), resultJson: await nativeInputRefusalEvidence(db, run, error, "native_turn_prompt_exceeds_command_bound") }).where(eq(heartbeatRuns.id, run.id));
  const deps = createHeartbeatQueueTestDependencies(db);
  deps.getAgent.mockResolvedValue(agent); deps.instanceSettings.getExperimental.mockResolvedValue({} as never);
  const queue = createHeartbeatQueue(db, deps);
  for (const reason of ["issue_continuation_needed", "issue_assignment_recovery", "issue_recovery_action_restored", "native_run_failed", "issue_status_changed", "transient_failure_retry"]) {
    expect(await queue.enqueueWakeup(agent.id, { source: "automation", reason, requestedByActorType: "system", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, wakeReason: reason } })).toBeNull();
  }
  const wakeOnly = { issueId: issue.id, childSummary: "Wake-only child evidence: preserved", triggerPayload: { amount: 7 } };
  expect(await queue.enqueueWakeup(agent.id, { source: "automation", reason: "issue_children_completed", requestedByActorType: "system", payload: wakeOnly, contextSnapshot: { issueId: issue.id, wakeReason: "issue_children_completed", childEvidence: "not in task thread" } })).toBeNull();
  const pending = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id));
  expect(pending).toHaveLength(1); expect(pending[0].status).toBe("deferred_issue_execution"); expect(pending[0].runId).toBeNull();
  expect(pending[0].payload).toMatchObject({ nativeInputRefusalHold: true,
    nativeInputRefusalWakes: expect.arrayContaining([expect.objectContaining({ payload: wakeOnly,
      contextSnapshot: expect.objectContaining({ childEvidence: "not in task thread" }) })]) });
  console.info(JSON.stringify({ row: "C6-wake-only-deferred", requestId: pending[0].id, status: pending[0].status, payload: pending[0].payload }));
  const refused = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.issueId, issue.id)));
  expect(refused).toHaveLength(1); expect(refused[0].status).toBe("failed");
  // This is a fixture-scale plan receipt, not a production-cardinality benchmark.
  const plan = await db.execute(sql`explain (analyze, buffers, format json)
    select error_code from heartbeat_runs where company_id = ${company.id}
      and status in ('succeeded','failed','timed_out','interrupted')
      and (native_issue_id = ${issue.id} or (native_issue_id is null and issue_id = ${issue.id})
        or (native_issue_id is null and issue_id is null and context_snapshot->>'issueId' = ${issue.id}))
    order by created_at desc, id desc limit 1`);
  console.info(JSON.stringify({ row: "C5-query-plan", plan }));
  const refusalPlan = await db.execute(sql`explain (analyze, buffers, format json)
    select status, error_code, result_json from heartbeat_runs where company_id = ${company.id}
      and status in ('succeeded','failed','timed_out','interrupted')
      and coalesce(native_issue_id::text, issue_id::text, context_snapshot->>'issueId') = ${issue.id}
    order by created_at desc, id desc limit 1`);
  console.info(JSON.stringify({ row: "C5-full-refusal-query-plan", plan: refusalPlan }));
  await db.update(issueComments).set({ deletedAt: new Date(), updatedAt: new Date(), deletedByType: "user", deletedByUserId: user }).where(eq(issueComments.id, message.id));
  const [short] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: user, body: "Please answer ready." }).returning();
  const next = await queue.enqueueWakeup(agent.id, { source: "automation", reason: "issue_commented", requestedByActorType: "system", payload: { issueId: issue.id, commentId: short.id }, contextSnapshot: { issueId: issue.id, wakeReason: "issue_commented", wakeCommentId: short.id } });
  expect(next).not.toBeNull();
  const input = build(next!.id, short.body), sent: unknown[] = [];
  const authority = { store: { state: { identity: { runId: next!.id } } }, queueCommand: async (_type: string, payload: unknown) => { sent.push(payload); return payload; } };
  guardNativeTurnCommands(authority as never);
  await authority.queueCommand("turn.start", { text: JSON.stringify(input) });
  expect(sent).toHaveLength(1);
  console.info(JSON.stringify({ row: "C4-delete-short-admitted", refusedRunId: run.id, nextRunId: next!.id, guardedCommands: sent.length, provider: "local transport test port" }));
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "operator_cancelled" }).where(eq(heartbeatRuns.id, next!.id));
}, 120_000);
