import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { nextFreshContinuationCheckAt } from "./fresh-continuation-fallback.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type PlanNode = { "Relation Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: PlanNode[] };

function rowsRead(node: PlanNode, relation: string): number {
  const own = node["Relation Name"] === relation ? (node["Actual Loops"] ?? 0)
    * ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)) : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + rowsRead(child, relation), 0);
}

// Fork adaptation of upstream's file (paperclipai/paperclip ca23330c69, #21541):
// this fork does not have upstream's index-lookup rewrite of these predicates
// (recentInterruptionSourceSql and its "previous predicates" oracle), so only
// #21541's own case is ported here, with the fixture it seeds on.
suite("fresh-continuation schedule queries", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const now = new Date(Date.UTC(2026, 10, 14, 5, 0, 0));
  const tenants: Array<{ companyId: string; agentIds: string[] }> = [];
  let actions = 0;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-fresh-continuation-schedule-");
    db = createDb(temporary.connectionString);
    for (const prefix of ["FCA", "FCB"]) {
      const companyId = randomUUID(), agentIds = [randomUUID(), randomUUID()];
      await db.insert(companies).values({ id: companyId, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values(agentIds.map((id, index) => ({ id, companyId, name: `Coder ${index}`, role: "engineer",
        status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
      tenants.push({ companyId, agentIds });
    }
    actions = await seedVariedFixture(20261114, 900);
    // Run history that is not linked to any held task, so a scan per candidate shows.
    await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object('issueId', gen_random_uuid()::text, 'prompt', repeat('x', 4000)),
        $3::timestamptz - (n || ' minutes')::interval from generate_series(1, 3000) n`,
    [tenants[0]!.companyId, tenants[0]!.agentIds[0]!, now.toISOString()]);
    await db.execute(sql`analyze`);
  }, 120_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  /** Held tasks in every shape the predicates distinguish: run keys, run links, statuses, ages, retries. */
  async function seedVariedFixture(seed: number, count: number) {
    const next = random(seed);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
    const chance = (probability: number) => next() < probability;
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
    const issueRows: Array<typeof issues.$inferInsert> = [];
    const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
    const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
    const actionRows: Array<typeof issueRecoveryActions.$inferInsert> = [];
    const link = (issueId: string, kind: string) => kind === "native" ? { scopeKind: "issue" as const, issueId, nativeIssueId: issueId }
      : kind === "issue" ? { scopeKind: "issue" as const, issueId } : kind === "context" ? { scopeKind: "company" as const }
      : { scopeKind: "company" as const };
    for (let index = 0; index < count; index += 1) {
      const tenant = chance(0.9) ? tenants[0]! : tenants[1]!;
      const other = tenant === tenants[0] ? tenants[1]! : tenants[0]!;
      const issueId = randomUUID(), runId = randomUUID();
      const assignee = chance(0.9) ? pick(tenant.agentIds) : null;
      issueRows.push({ id: issueId, companyId: tenant.companyId, title: `Held ${index}`, assigneeAgentId: assignee,
        status: pick(["todo", "in_progress", "blocked", "blocked", "in_review", "done", "cancelled"]) });
      const finishedMinutesAgo = pick([30, 120, 600, 1_200, 1_430, 1_450, 2_000, 4_000]);
      const sourceLink = pick(["native", "issue", "context"]);
      const errorCode = pick(["process_lost", "native_session_interrupted", "server_shutdown_interrupted", "controller_lease_lost",
        "adapter_failed", "reusable_sandbox_resume_failed", "budget_exceeded", null]);
      const sourceCreated = chance(0.92);
      if (sourceCreated) {
        const finished = chance(0.92) ? at(finishedMinutesAgo) : null;
        runRows.push({ id: runId, companyId: chance(0.95) ? tenant.companyId : other.companyId,
          agentId: chance(0.85) && assignee ? assignee : pick(tenant.agentIds), ...link(issueId, sourceLink),
          status: pick(["failed", "failed", "timed_out", "interrupted", "cancelled", "succeeded", "running"]),
          errorCode, error: errorCode === "reusable_sandbox_resume_failed" ? pick(["resume failed (cause=transport_timeout)", "resume failed"]) : errorCode,
          startedAt: at(finishedMinutesAgo + 10), finishedAt: finished, createdAt: at(finishedMinutesAgo + 11), updatedAt: at(finishedMinutesAgo),
          retryOfRunId: null, scheduledRetryReason: chance(0.1) ? "process_lost" : null,
          contextSnapshot: { issueId, wakeReason: pick(["issue_assigned", "task_retry", "process_lost_retry"]),
            ...(chance(0.1) ? { explicitUserContinuation: { runId } } : {}), ...(chance(0.1) ? { previousRunId: randomUUID() } : {}) } });
      }
      for (let extra = Math.floor(next() * 3); extra > 0; extra -= 1) {
        const extraLink = pick(["native", "issue", "context", "unrelated"]);
        const cancelledAtDispatch = chance(0.35);
        const createdMinutesAgo = pick([finishedMinutesAgo + 11, finishedMinutesAgo + 30, finishedMinutesAgo - 5, 5]);
        runRows.push({ companyId: chance(0.95) ? tenant.companyId : other.companyId, agentId: pick(tenant.agentIds),
          ...link(issueId, extraLink),
          status: cancelledAtDispatch ? "cancelled" : pick(["queued", "running", "scheduled_retry", "succeeded", "failed", "cancelled"]),
          errorCode: cancelledAtDispatch ? "execution_reconciliation_required" : null,
          startedAt: cancelledAtDispatch && chance(0.8) ? null : at(createdMinutesAgo - 1),
          finishedAt: chance(0.8) ? at(pick([createdMinutesAgo - 2, 60, 2_000])) : null, createdAt: at(createdMinutesAgo),
          retryOfRunId: sourceCreated && chance(0.3) ? runId : null,
          contextSnapshot: extraLink === "unrelated" ? { issueId: randomUUID() }
            : { issueId, wakeReason: pick(["task_retry", "issue_assigned", "process_lost_retry"]) } });
      }
      if (chance(0.25)) {
        wakeRows.push({ companyId: tenant.companyId, agentId: pick(tenant.agentIds), source: "on_demand", reason: pick(["task_retry", "issue_assigned"]),
          status: pick(["deferred_issue_execution", "deferred_issue_execution", "coalesced"]),
          requestedByActorType: pick(["user", "user", "system"]), runId: !sourceCreated || chance(0.8) ? null : runId,
          requestedAt: at(pick([finishedMinutesAgo - 5, finishedMinutesAgo + 5])), payload: { issueId } });
      }
      const recordedRunId = pick(["runId", "runId", "runId", "runId", "runId", "sourceRunId", "sourceRunId", "upper", "invalid", "number", "missing", "unknown",
        "braced", "padded", "both"]);
      const runKey = recordedRunId === "sourceRunId" ? { sourceRunId: runId }
        : recordedRunId === "upper" ? { runId: runId.toUpperCase() } : recordedRunId === "invalid" ? { runId: "not-a-run" }
        : recordedRunId === "number" ? { runId: 42 } : recordedRunId === "missing" ? {}
        : recordedRunId === "unknown" ? { runId: randomUUID() } : recordedRunId === "braced" ? { runId: `{${runId}}` }
        : recordedRunId === "padded" ? { runId: ` ${runId}` } : recordedRunId === "both" ? { runId: "not-a-run", sourceRunId: runId }
        : { runId };
      actionRows.push({ companyId: tenant.companyId, sourceIssueId: issueId, kind: pick(["active_run_watchdog", "missing_disposition"]),
        status: pick(["active", "escalated", "resolved", "resolved"]), ownerType: "board", ownerUserId: chance(0.05) ? "user-1" : null,
        cause: pick(["legacy_execution_requires_reconciliation", "native_continuation_requires_reconciliation", "stranded_assigned_issue"]),
        fingerprint: `held:${index}`, nextAction: "Fixture",
        evidence: { ...runKey,
          ...(chance(0.7) ? { automaticRecovery: { replay: pick(["blocked", "blocked", "blocked", "allowed"]) } } : {}),
          ...(chance(0.2) ? { systemRecovery: { state: pick(["complete", "exhausted", "scheduled", "running", "failed"]) } } : {}),
          ...(chance(0.05) ? { executionReconciliation: { runId } } : {}),
          ...(chance(0.05) ? { freshContinuation: { sourceRunId: runId } } : {}),
          ...(chance(0.7) ? { freshContinuationCheck: { kind: "backoff", nextCheckAt: now.getTime() + Math.round((next() - 0.5) * 7_200_000) } } : {}) } });
    }
    await db.insert(issues).values(issueRows);
    // One statement, so a retry may name a source run listed after it.
    await db.insert(heartbeatRuns).values(runRows);
    if (wakeRows.length) await db.insert(agentWakeupRequests).values(wakeRows);
    for (let start = 0; start < actionRows.length; start += 500)
      await db.insert(issueRecoveryActions).values(actionRows.slice(start, start + 500));
    return actionRows.length;
  }

  async function deadlinePlan() {
    let captured: { sql: string; params: unknown[] } | undefined;
    const capture = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...fields: Parameters<typeof db.select>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const selection = from(...args);
          selection.execute = async () => { captured = selection.toSQL(); return [{ at: null }]; };
          return selection;
        }) as typeof builder.from;
        return builder;
      };
    } });
    await nextFreshContinuationCheckAt(capture as typeof db, now);
    const [row] = await db.$client.unsafe(`explain (analyze, format json) ${captured!.sql}`, captured!.params as never[]);
    return (row!["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0]!.Plan;
  }

  // Runs last: its candidates reach the saved-files-lost check, which the
  // previous predicates above do not have.
  it("checks for permanently lost saved files by the task's own records, not every recovery record per candidate", async () => {
    const { companyId, agentIds } = tenants[0]!;
    const fillerIssues = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), companyId, title: `Filler ${index}`, status: "done" }));
    await db.insert(issues).values(fillerIssues as never);
    const filler = Array.from({ length: 3_000 }, (_, index) => ({ companyId, sourceIssueId: fillerIssues[index % 100]!.id, kind: "missing_disposition",
      status: "resolved", ownerType: "board", cause: "unrelated_fixture", fingerprint: `filler:${index}`, nextAction: "Fixture",
      evidence: { runId: randomUUID() } }));
    for (let start = 0; start < filler.length; start += 500)
      await db.insert(issueRecoveryActions).values(filler.slice(start, start + 500) as never);
    for (let index = 0; index < 30; index += 1) {
      const issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: `Lost files ${index}`, assigneeAgentId: agentIds[0]!, status: "in_progress" });
      // A person's Retry that failed in setup: system-owned, but not an automatic continuation.
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agentIds[0]!, scopeKind: "issue", issueId, status: "failed",
        errorCode: "setup_failed", startedAt: new Date(now.getTime() - 40 * 60_000), finishedAt: new Date(now.getTime() - 30 * 60_000),
        createdAt: new Date(now.getTime() - 41 * 60_000), contextSnapshot: { issueId, wakeReason: "task_retry" } });
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
        ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: `lost:${index}`, nextAction: "Fixture",
        evidence: { runId, automaticRecovery: { replay: "blocked" },
          systemRecovery: { state: "exhausted", failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" } },
          freshContinuationCheck: { kind: "backoff", nextCheckAt: now.getTime() - 60_000 } } });
    }
    await db.execute(sql`analyze`);
    const plan = await deadlinePlan();
    const [{ holds }] = await db.$client.unsafe(`select count(*)::int as holds from issue_recovery_actions`) as unknown as Array<{ holds: number }>;
    // A cast on the indexed keys read every recovery record once per candidate (about 30 × 4,000 here).
    expect(rowsRead(plan, "issue_recovery_actions")).toBeLessThan(2 * holds);
    expect(await nextFreshContinuationCheckAt(db, now)).toBeLessThanOrEqual(now.getTime() - 60_000);
  }, 120_000);
});
