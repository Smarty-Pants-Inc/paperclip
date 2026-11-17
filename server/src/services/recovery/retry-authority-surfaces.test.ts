import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { executionProjectionForRun } from "../execution-projection.js";
import { UNRESTORED_FILES_NEXT_ACTION } from "../legacy-execution-recovery.js";
import { requestTaskRetry } from "../task-retry.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

// Retry fold (judge bar R6 G, R7 M1, R8 E-on-A, R11 F2 row D, R15): ONE
// authority sets the card text, the transcript text, the structured action
// and whether Retry is offered or accepted. Strings are the exact ones the
// person reads; each row asserts card == transcript and canRetry false where
// the Retry path refuses.
const NEW_TASK_ACTION = "Assign this agent a new task to continue.";
const HELD_RECOVERED = "Saved work recovered, but this conversation cannot continue. Assign this agent a new task to continue.";
const HELD_NOTICE = "Your message and saved work are kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const PAUSED = "This agent is paused. Resume this agent to continue. Your message and saved work are kept.";

describe("retry fold: one authority across card, transcript, Retry API", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retry-authority-surfaces-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /** A failed native run whose provider session did work; its saved work is recovered. */
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry fold", defaultResponsibleUserId: "board", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      startedAt: new Date("2026-11-14T02:00:00Z"), finishedAt: new Date("2026-11-14T02:01:00Z"), processPid: 999999999,
      errorCode: "native_session_interrupted", contextSnapshot: { issueId }, resultJson: {} });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      failureCode: "native_session_interrupted", failureDetail: { providerSessionEstablished: true, providerEventsExist: true } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "native_continuation_requires_reconciliation", status: "resolved", outcome: "blocked", ownerType: "board",
      fingerprint: `native-workspace:${runId}`, resolvedAt: new Date(), nextAction: UNRESTORED_FILES_NEXT_ACTION,
      evidence: { runId, continuationDelivery: "invalidated", automaticRecovery: { policy: "preserve_without_replay_v1",
        runId, replay: "blocked", actionOutcome: "unknown" }, workspaceRecovery: { schema: "paperclip.workspace-recovery.v1",
        runId, status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } }).returning();
    const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    return { companyId, agentId, issueId, runId, actionId: action.id, issue };
  }

  /** The prior-owner fence refused this run (E-C01 / M1 / E-on-A): same thread, same fence on every Retry.
   * The executor posts its durable HELD notice with the refusal (NSE HELD_PREDECESSOR_REFUSAL); the
   * run's own error text is not authority (follow-Paperclip Cut B R4). */
  async function fenceRefused(f: Awaited<ReturnType<typeof seed>>) {
    await db.update(heartbeatRuns).set({ errorCode: "native_continuation_requires_reconciliation",
      error: "runner_state_identity_mismatch: prior_owner_scope_mismatch" }).where(eq(heartbeatRuns.id, f.runId));
    await heldNotice(f);
  }

  async function heldNotice(f: Awaited<ReturnType<typeof seed>>) {
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: HELD_NOTICE,
      metadata: { version: 1, authorizationReason: `native_prior_owner_held:${randomUUID()}`,
        sections: [{ rows: [{ type: "run_link", runId: f.runId, agentId: f.agentId }] }] } });
  }

  async function surfaces(f: Awaited<ReturnType<typeof seed>>) {
    const card = await getExecutionBlocker(db, f.companyId, f.issueId);
    const transcript = await executionProjectionForRun(db, f.companyId, f.runId);
    const presentation = await taskInterruptionPresentation(db, await f.issue());
    return { card, transcript, presentation };
  }

  it("R6 G: Retry while the agent is PAUSED names the true action (Resume this agent) on card and transcript; no Retry", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const { card, transcript, presentation } = await surfaces(f);
    expect(card).toMatchObject({ canRetry: false, nextAction: PAUSED });
    expect(card?.workspaceRecovery?.message).toBe(PAUSED);
    expect(card?.nextAction).not.toMatch(/Send a message|Retry continues/);
    expect(transcript?.nextAction).toBe(card?.nextAction);
    expect(presentation).toMatchObject({ canRetry: false, userAction: "resume", state: "waiting_for_user" });
  });

  it("R6 G: a paused assignee behind a hold that has no saved-work receipt also names Resume (blocker next action), no Retry", async () => {
    const f = await seed();
    await db.update(issueRecoveryActions).set({ status: "active", resolvedAt: null,
      evidence: { runId: f.runId, originalFailureCode: "native_session_interrupted" } }).where(eq(issueRecoveryActions.id, f.actionId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const { card, presentation } = await surfaces(f);
    expect(card).toMatchObject({ canRetry: false, nextAction: PAUSED });
    expect(presentation).toMatchObject({ canRetry: false, userAction: "resume" });
  });

  it("R7 M1: a fence-refused dead end never says 'Retry continues from it'; card = transcript; canRetry false", async () => {
    const f = await seed();
    await fenceRefused(f);
    const { card, transcript, presentation } = await surfaces(f);
    expect(card?.canRetry).toBe(false);
    expect(card?.nextAction).toBe(HELD_RECOVERED);
    expect(card?.nextAction).not.toMatch(/Retry continues from it/);
    expect(transcript?.nextAction).toBe(card?.nextAction);
    expect(presentation?.canRetry).toBe(false);
  });

  it("R8 E-on-A: a Retry the fence will refuse is REFUSED at the API with a reason (never 202 'working' with no run)", async () => {
    const f = await seed();
    await fenceRefused(f);
    const before = await db.select().from(agentWakeupRequests);
    await expect(requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409, details: { code: "retry_not_available", userAction: "new_task" } });
    // Nothing accepted, nothing left waiting: no receipt that could show 'working'.
    expect(await db.select().from(agentWakeupRequests)).toEqual(before);
    expect((await surfaces(f)).presentation?.state).not.toBe("working");
  });

  it("R8: an ACCEPTED Retry is one the dispatcher can run (accepted implies the authority offers it)", async () => {
    const f = await seed();
    const { card, presentation } = await surfaces(f);
    expect(card?.canRetry).toBe(true);
    expect(presentation?.canRetry).toBe(true);
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(receipt).toMatchObject({ accepted: true });
  });

  it("R11 F2 row D: standing HELD notice + deferred prior_owner_scope_mismatch Retry: canRetry false with the new-task text", async () => {
    const f = await seed();
    await heldNotice(f);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: f.runId },
        executionWait: { reason: "prior_owner_scope_mismatch", message: "held" } } });
    const { card, transcript, presentation } = await surfaces(f);
    expect(card).toMatchObject({ canRetry: false, nextAction: HELD_RECOVERED });
    expect(transcript?.nextAction).toBe(card?.nextAction);
    expect(presentation?.canRetry).toBe(false);
    // R15: the card and the newest transcript note carry the same instruction, exactly.
    const [note] = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(note!.body).toContain(NEW_TASK_ACTION);
    expect(card!.nextAction).toContain(NEW_TASK_ACTION);
  });

  it("R11 F2: the deferred prior_owner_scope_mismatch refusal alone (no notice yet) withdraws Retry", async () => {
    const f = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: f.runId },
        executionWait: { reason: "prior_owner_scope_mismatch", message: "held" } } });
    const { card, presentation } = await surfaces(f);
    expect(card?.canRetry).toBe(false);
    expect(card?.nextAction).toContain(NEW_TASK_ACTION);
    expect(presentation?.canRetry).toBe(false);
  });
});
