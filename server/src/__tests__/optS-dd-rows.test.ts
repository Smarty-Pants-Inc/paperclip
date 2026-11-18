// optS-dd rows at the database seam: positive-row preservation (replaces Q1
// marker preservation), D2 (every accepted Interrupt leaves a row, also before
// native selection; a person Stop keeps the native guard) and the reader check.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createHeartbeatLifecycle } from "../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { executionStartedEventPredicate } from "../services/pre-dispatch-execution-evidence.js";
import { provesNoNativeRunProviderWork } from "../services/native-runtime/native-provider-work-proof.js";
import { nativeRunLogSourceWhere } from "../services/native-runtime/native-run-log-export.js";
import { heartbeatService } from "../services/heartbeat.js";
import { activityService } from "../services/activity.js";

// R13: capture the REAL activity classifier's evidence (activity.ts backfillMissingRunLivenessForIssue counts the
// run's events and hands toolOrActionEventsCreated to classifyRunLiveness). The count itself is product SQL.
const liveness = vi.hoisted(() => ({ inputs: [] as Array<{ runStatus: string; resultJson: unknown; evidence: Record<string, unknown> }> }));
vi.mock("../services/run-liveness.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/run-liveness.js")>();
  return { ...actual, classifyRunLiveness: ((input: any) => { liveness.inputs.push(input); return actual.classifyRunLiveness(input); }) as typeof actual.classifyRunLiveness };
});

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("optS-dd rows: preservation, D2, readers", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("optsdd-rows-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function lifecycle() {
    return createHeartbeatLifecycle(db, {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() }, companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) }, treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async () => ({})),
      getAgentInvokability: vi.fn(async () => ({ invokable: true })), emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    } as any);
  }
  async function seed(runtimeMode: "native" | "legacy" = "native") {
    const [company] = await db.insert(companies).values({ name: "optS-dd rows", issuePrefix: `R${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "chat", status: "in_progress", assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, issueId: issue!.id,
      ...(runtimeMode === "native" ? { nativeIssueId: issue!.id } : {}), runtimeMode, status: "running", startedAt: new Date(),
      contextSnapshot: { issueId: issue!.id },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "person" } }).returning();
    return run!;
  }
  const rows = async (runId: string) => db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
    eq(heartbeatRunEvents.message, "run.stop.accepted")));
  const seedRow = async (run: typeof heartbeatRuns.$inferSelect) => appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id,
    agentId: run.agentId, eventType: "lifecycle", stream: "system", level: "info", message: "run.stop.accepted",
    payload: { schema: "paperclip.stop-acceptance.v1", kind: "person_stop", issueId: run.issueId, userId: "person", acceptedAt: new Date().toISOString() } });

  // R5 positive-row preservation: the proof lives in its own row, so a terminal writer that replaces result_json cannot take it.
  it.each(["failed", "cancelled"] as const)("R5 the %s terminal writer leaves the seeded row unchanged", async status => {
    const run = await seed();
    await seedRow(run);
    const before = await rows(run.id);
    const result = await lifecycle().setRunStatusIfRunning(run.id, status, { finishedAt: new Date(),
      errorCode: status === "failed" ? "adapter_failed" : "cancelled", resultJson: { replaced: true } });
    expect(result.updated).toBe(true);
    expect(await rows(run.id)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  // D2: every accepted Interrupt leaves a row, also before native selection; a person Stop keeps the native guard.
  // Mutation restore_interrupt_native_guard turns the first row red.
  it.each([["interrupt", ["interrupt"]], ["person_stop", []]] as const)("D2 %s accepted on a legacy-mode run (before native selection) leaves %j", async (kind, expected) => {
    const run = await seed("legacy");
    await heartbeatService(db).cancelRun(run.id, "Cancelled by a board operator", {
      stopAcceptance: kind, ...(kind === "interrupt" ? { errorCode: "operator_interrupted" } : {}),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "person", ...(kind === "interrupt" ? { operatorInterrupted: true } : {}) },
    }).catch(error => { if (!String(error).length) throw error; });
    expect((await rows(run.id)).map(row => (row.payload as any)?.kind)).toEqual(expected);
  }, 60_000);

  // R13 reader check: the row is not runner evidence. Mutation: give it a source_event_id.
  it("R13 with the row present: no execution-started event, no provider work, no log-export source row", async () => {
    const run = await seed();
    const { row } = await seedRow(run);
    // Mutation hooks for the reader check (OPTS_R13_MUTATION): give the row a source_event_id, or a non-lifecycle type.
    if (process.env.OPTS_R13_MUTATION === "source_event_id") await db.update(heartbeatRunEvents).set({ sourceEventId: "server:stop-acceptance" }).where(eq(heartbeatRunEvents.id, row.id));
    if (process.env.OPTS_R13_MUTATION === "type") await db.update(heartbeatRunEvents).set({ eventType: "run.stop.accepted" }).where(eq(heartbeatRunEvents.id, row.id));
    const started = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, run.id), executionStartedEventPredicate()));
    expect(started).toEqual([]);
    expect(await provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id })).toBe(true);
    expect(await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(nativeRunLogSourceWhere(run.companyId, run.id))).toEqual([]);
    // Activity classifier: call the real activity service (runsForIssue schedules the liveness backfill, which
    // counts tool/action events with activity.ts's own SQL). The run is terminal and unclassified, so it is a candidate.
    const control = await seed();
    await db.insert(heartbeatRunEvents).values({ companyId: control.companyId, runId: control.id, agentId: control.agentId, seq: 1,
      eventType: "tool.call", stream: "system", level: "info", message: "control work event" });
    for (const r of [run, control]) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { marker: r.id } }).where(eq(heartbeatRuns.id, r.id));
    const counted = async (r: typeof run) => {
      await activityService(db).runsForIssue(r.companyId, r.issueId!);
      const input = await vi.waitFor(() => {
        const hit = liveness.inputs.find(i => (i.resultJson as any)?.marker === r.id);
        if (!hit) throw new Error("liveness backfill has not classified the run yet");
        return hit;
      }, { timeout: 15_000, interval: 50 });
      return input.evidence.toolOrActionEventsCreated;
    };
    expect(await counted(control), "control: the real count sees a non-lifecycle event").toBe(1);
    expect(await counted(run), "the acceptance row is not counted as work by the real activity classifier").toBe(0);
  }, 60_000);
});
