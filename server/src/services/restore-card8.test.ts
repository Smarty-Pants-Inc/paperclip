import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { adoptSystemRecovery, loadSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { STOP_PROOF_MAX_REARMS, STOP_PROOF_RECOVERY_SCHEMA } from "./system-recovery-state.js";
import { activityService } from "./activity.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { requestTaskRetry } from "./task-retry.js";
import { retryRefusedBeforeAdmission } from "./task-retry-eligibility.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";

// An adoption that throws every time (J9's blocked adoption), toggled per test.
const adoptionFault = vi.hoisted(() => ({ on: false }));
vi.mock("./system-recovery.js", async (original) => {
  const actual = await original<typeof import("./system-recovery.js")>();
  return { ...actual, adoptSystemRecovery: (...args: Parameters<typeof actual.adoptSystemRecovery>) =>
    adoptionFault.on ? Promise.reject(new Error("adoption broke")) : actual.adoptSystemRecovery(...args) };
});

// Literal on purpose: the words a person reads.
// The card's owed words: the hold's next action (unadopted) or the worker's
// in-progress text (adopted): "Recovering your saved work…" / "Recovering saved work…".
const RECOVERING = /Recovering (your )?saved work/;
const DELAYED = "Recovering your saved work is taking longer than expected.";
const FAILURE_WORDS = /could not recover|could not be put back|restore failed/i;

// restore-card8: rf-3's open findings on the restore chain (J9, J8, J4, J5, J7;
// J3 control). The chat side is the run projection (activity runsForIssue) the
// UI marker reads; the card is getExecutionBlocker; the API is requestTaskRetry.
(recoveryPostgresSupport.supported ? describe : describe.skip)("restore-card8: owed restores, the person bound and one Retry", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function seedOwed(adopt = true) {
    if (!database) {
      database = await startRecoveryPostgres("restore-card8-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card8", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Card8 worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Card8 ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { remoteWorkspace: reference }, resultJson: {} });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    // The real producer: files are pinned before any restore was tried (owed).
    expect(await preserveRemoteWorkspacePreparationFailure(db, lease!)).not.toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(action.evidence).toMatchObject({ runId, workspaceRestorePending: true });
    const source = { companyId, issueId, runId, actionId: action.id };
    if (adopt) await adoptSystemRecovery(db, source);
    return { ...source, leaseId };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const chatRunResult = async (f: { companyId: string; issueId: string; runId: string }) => {
    const runs = await activityService(db).runsForIssue(f.companyId, f.issueId, null, undefined, undefined,
      { skipLivenessBackfill: true });
    const run = runs.find(row => row.runId === f.runId);
    expect(run).toBeDefined();
    return (run!.resultJson ?? {}) as Record<string, unknown>;
  };
  // The chat's Retry rule (TaskChatThread / workspace-restore-marker.ts): no Retry
  // while the marker is pending or waits on a stop; delayed or failed offer it.
  const chatOffersRetry = (result: Record<string, unknown>) =>
    result.workspaceRestorePending !== true && result.workspaceRestoreStopWait == null;
  const ageHold = (f: { actionId: string }, minutes: number) => db.update(issueRecoveryActions)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) }).where(eq(issueRecoveryActions.id, f.actionId));
  const hold = async (f: { actionId: string }) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0];
  const retry = (f: { companyId: string; issueId: string; runId: string }) => requestTaskRetry({ db, companyId: f.companyId,
    issueId: f.issueId, actorId: "user-1", actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
  async function blockAdoption(f: { actionId: string }) {
    adoptionFault.on = true;
    try {
      for (let i = 0; i < 5; i++) await adoptHistoricalWorkspaceRecoveries(db).catch(() => undefined);
    } finally { adoptionFault.on = false; }
    const after = await hold(f);
    expect(after.evidence).toMatchObject({ workspaceRestorePending: true,
      systemRecovery: { state: "exhausted", attempts: 0, failure: { cause: { label: "adoption_failed" } } } });
    expect((after.evidence as Record<string, any>).systemRecovery.preservationOperationIds ?? []).toEqual([]);
  }
  async function exhaust(f: Awaited<ReturnType<typeof seedOwed>>, failure: Record<string, unknown>, attempts?: number) {
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state: "exhausted",
      attempts: attempts ?? current.attempts, nextAttemptAt: null, failure: failure as never })).toBe(true);
  }

  // J9 (item 1): owed run AND hold, attempts=0, no preservation operation; the
  // adoption is blocked. Nothing was copied back, so nothing failed: still owed.
  it("J9: an owed hold whose adoption is blocked (attempts=0) reads still recovering on card and chat, never failed", async () => {
    const f = await seedOwed(false);
    await blockAdoption(f);
    const result = await chatRunResult(f);
    expect(result.workspaceRestorePending).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(false);
    expect(blocker?.nextAction).toMatch(RECOVERING);
    expect(blocker?.nextAction).not.toMatch(FAILURE_WORDS);
    expect(blocker?.workspaceRecovery?.message ?? "").not.toMatch(FAILURE_WORDS);
  }, 120_000);

  it("J9 NEGATIVE (rf-4): a REAL terminal copy-back failure after attempts still reads failed with Retry", async () => {
    const f = await seedOwed();
    await exhaust(f, { code: "effect_unresolved", retryClass: "service_required", evidenceFingerprint: "copyback" }, 2);
    const result = await chatRunResult(f);
    expect(result).not.toHaveProperty("workspaceRestorePending");
    expect(result).not.toHaveProperty("workspaceRestoreDelayed");
    expect(chatOffersRetry(result)).toBe(true);
  }, 120_000);

  it("J9 PAST BOUND: the blocked-adoption owed hold at 61 min is delayed with Retry on card, chat and API", async () => {
    const f = await seedOwed(false);
    await blockAdoption(f);
    await ageHold(f, 61);
    const result = await chatRunResult(f);
    expect(result.workspaceRestoreDelayed).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(true);
    expect(blocker?.nextAction).toContain(DELAYED);
  }, 120_000);

  // J8 (item 2): an agent stop with every re-arm spent is not a wait (card7's
  // carve-out): the chat and API offer Retry, so the card offers it too.
  it("J8: exhausted agent stop with rearms=4 -> card offers the same Retry as chat and API; no 'new task' line", async () => {
    const f = await seedOwed();
    await exhaust(f, { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" });
    await db.update(issueRecoveryActions).set({ evidence: { ...(await hold(f)).evidence,
      stopProofRecovery: { schema: STOP_PROOF_RECOVERY_SCHEMA, rearms: STOP_PROOF_MAX_REARMS } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const result = await chatRunResult(f);
    expect(chatOffersRetry(result)).toBe(true);
    expect(await retryRefusedBeforeAdmission(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId })).toBeNull();
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(true);
    expect(blocker?.nextAction).not.toMatch(/new task/i);
    expect(blocker?.workspaceRecovery?.message ?? "").not.toMatch(/new task/i);
    expect(await retry(f)).toMatchObject({ accepted: true });
  }, 120_000);

  // fam-retry-r2 (3-way): the card the UI renders (taskInterruptionPresentation,
  // fam-retry4's retryAdmission) and the Retry API (fam-retry2/3's authority)
  // give ONE state per authority outcome on card8's real-producer holds:
  // accept-held -> held state, no Retry; refused -> its reason, no Retry, the
  // API refuses with the same words; offered -> Retry, the API accepts plainly.
  const card = async (f: { issueId: string }) => taskInterruptionPresentation(db,
    (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!);
  it("fam-retry-r2: J9 blocked adoption under the bound is accept-held on card and API with the same words", async () => {
    const f = await seedOwed(false);
    await blockAdoption(f);
    const shown = await card(f);
    expect(shown).toMatchObject({ canRetry: false, retryAdmission: "held" });
    expect(shown?.retryWait?.message ?? "").toMatch(RECOVERING);
    const answer = await retry(f) as Record<string, any>;
    expect(answer).toMatchObject({ accepted: true, held: { message: shown!.retryWait!.message } });
  }, 120_000);
  it("fam-retry-r2: J5 NEGATIVE stop wait under the bound is refused on card and API with the same words, never held", async () => {
    const f = await seedOwed();
    await exhaust(f, { code: "copyback_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" });
    await ageHold(f, 59);
    const shown = await card(f);
    expect(shown?.canRetry).toBe(false);
    expect(shown?.retryAdmission).toBeUndefined();
    const answer = await retry(f) as Record<string, any>;
    expect(answer).toMatchObject({ accepted: false, refused: { reason: "workspace_restore_stop_wait" } });
    expect(shown?.retryWait?.message).toBe(answer.refused.message);
  }, 120_000);
  for (const kind of ["J8", "J5-past-bound"] as const) {
    it(`fam-retry-r2: ${kind} offered -> card shows Retry (not held) and the API accepts it plainly`, async () => {
      const f = await seedOwed();
      if (kind === "J8") {
        await exhaust(f, { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" });
        await db.update(issueRecoveryActions).set({ evidence: { ...(await hold(f)).evidence,
          stopProofRecovery: { schema: STOP_PROOF_RECOVERY_SCHEMA, rearms: STOP_PROOF_MAX_REARMS } } })
          .where(eq(issueRecoveryActions.id, f.actionId));
      } else {
        await exhaust(f, { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" });
        await ageHold(f, 61);
      }
      const shown = await card(f);
      expect(shown).toMatchObject({ canRetry: true });
      expect(shown?.retryAdmission).toBeUndefined();
      const answer = await retry(f) as Record<string, any>;
      expect(answer).toMatchObject({ accepted: true });
      expect(answer.held).toBeUndefined();
    }, 120_000);
  }

  // J4 (item 5): an unadopted owed hold (no workspaceRecovery yet) at 61 min.
  it("J4: an unadopted owed hold past the person bound -> card and chat agree: delayed, Retry offered and accepted", async () => {
    const f = await seedOwed(false);
    await ageHold(f, 61);
    const result = await chatRunResult(f);
    expect(result.workspaceRestoreDelayed).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(true);
    expect(blocker?.nextAction).toContain(DELAYED);
    expect(await retry(f)).toMatchObject({ accepted: true });
  }, 120_000);

  // J5 (item 5): both exhausted stop waits past the person bound.
  for (const code of ["copyback_stop_unconfirmed", "agent_stop_unconfirmed"] as const) {
    it(`J5: exhausted ${code} at 61 min -> card and chat agree: delayed, Retry offered through the one authority`, async () => {
      const f = await seedOwed();
      await exhaust(f, { code, retryClass: "recheck_evidence", evidenceFingerprint: "x" });
      await ageHold(f, 61);
      const result = await chatRunResult(f);
      expect(result.workspaceRestoreStopWait ?? null).toBeNull();
      expect(result.workspaceRestoreDelayed).toBe(true);
      expect(await retryRefusedBeforeAdmission(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId })).toBeNull();
      const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
      expect(blocker?.canRetry).toBe(true);
      expect(blocker?.nextAction).toContain(DELAYED);
      expect(await retry(f)).toMatchObject({ accepted: true });
    }, 120_000);
  }

  // J5 NEGATIVE: under the bound the stop waits stay waits (card7 C unchanged).
  it("J5 NEGATIVE: exhausted copyback stop at 59 min still waits, no Retry", async () => {
    const f = await seedOwed();
    await exhaust(f, { code: "copyback_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" });
    await ageHold(f, 59);
    const result = await chatRunResult(f);
    expect(result.workspaceRestoreStopWait).toBe("copyback_stop_unconfirmed");
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.canRetry).toBe(false);
  }, 120_000);

  // J7 (item 5): the adoption is blocked on a REAL row lock. It must settle
  // (bounded lock wait), and at the person bound card and chat agree with Retry.
  it("J7: adoption blocked on a real row lock settles within a bounded wait; at 61 min card == chat, Retry offered", async () => {
    const f = await seedOwed(false);
    const locker = createDb(database.connectionString);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>(resolve => { locked = resolve; });
    const lockTx = locker.transaction(async tx => {
      await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, f.actionId)).for("update");
      locked();
      await released;
    });
    let adoption: Promise<unknown> | undefined;
    try {
      await isLocked;
      adoption = adoptHistoricalWorkspaceRecoveries(db).then(() => "settled", () => "settled");
      const outcome = await Promise.race([adoption,
        new Promise(resolve => setTimeout(() => resolve("still waiting"), 20_000))]);
      expect(outcome).toBe("settled");
    } finally {
      release();
      await lockTx;
      await adoption;
      await locker.$client.end();
    }
    // Lock gone; whatever the worker recorded, the person bound holds.
    await ageHold(f, 61);
    const result = await chatRunResult(f);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(result.workspaceRestoreDelayed).toBe(true);
    expect(blocker?.canRetry).toBe(true);
    expect(blocker?.nextAction).toContain(DELAYED);
  }, 120_000);

  // J3 control: an adopted, running hold at 61 min (card6 ITEM 1's case).
  it("J3 CONTROL: an adopted running owed hold at 61 min -> card == chat, Retry accepted", async () => {
    const f = await seedOwed();
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state: "running",
      phase: "preserve_files", nextAttemptAt: null })).toBe(true);
    await ageHold(f, 61);
    expect((await chatRunResult(f)).workspaceRestoreDelayed).toBe(true);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.canRetry).toBe(true);
    expect(await retry(f)).toMatchObject({ accepted: true });
  }, 120_000);
});
