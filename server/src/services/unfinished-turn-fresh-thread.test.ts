// 7e625560: a person's next authorized message after a turn that never
// finished (no run.terminal, no accepted result) on boxes that were only
// STOPPED. Both predecessors P (owns the provider thread) and S0 (the refused
// intervening attempt) are safety predecessors. The production entry point is
// selectPiConversation (pi-conversation-record.ts:86), the running-S cut that
// heartbeat runtime selection calls (heartbeat/runtime-selection.ts:558).
//
// PROVENANCE: every row here is PLANTED (rows written by hand in the Q1 read's
// shape: issue fe617f4c, P d2f6b4fd, S0 7e625560, boxes bx_ngxpne73 /
// bx_c2m2nuhj, the earlier released holder 846aacc1 on P's box). Receipts are
// built by the real producer helper remoteTerminationReceipt. The same-shape
// REAL-ROUTE companion (SEND -> LEASE -> FAIL -> STOP -> SEND) is NOT in this
// file; see result.md.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentTaskSessions, companies, completionContracts, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { PI_CONVERSATION_KEY, selectPiConversation } from "./native-runtime/pi-conversation-record.js";
import { createNativeSessionHandoffLoader } from "./native-runtime/native-session-handoff.js";

const FACT = "The previous turn did not finish and produced no accepted result.";
const NOTE = `${FACT} The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.`;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("7e625560 unfinished turn: fresh thread at the running-S cut", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const dirs: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unfinished-turn-fresh-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end(); await database?.cleanup();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  type Variant = { pReceipt?: boolean; s0Receipt?: boolean; laterHolderOn?: "p" | "s0"; successorBox?: string;
    s0Result?: boolean; pointer?: "p" | "none"; s0LiveLease?: boolean };

  async function seed(v: Variant = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), commentId = randomUUID();
    const P = randomUUID(), S0 = randomUUID(), S = randomUUID(), sessionId = randomUUID(), earlier = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "7e625560", defaultResponsibleUserId: "board",
      issuePrefix: `U${companyId.replaceAll("-", "").slice(0, 12)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Paul's chat", status: "blocked", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ companyId, name: `boat-${issueId}`, driver: "sandbox" }).returning();
    const at = (min: number) => new Date(Date.parse("2026-11-17T01:00:00.000Z") + min * 60_000);
    const failed = (id: string, created: number, finished: number, extra: Record<string, unknown> = {}) => ({ id, companyId, agentId,
      nativeIssueId: issueId, runtimeMode: "native" as const, status: "failed" as const,
      errorCode: "native_continuation_requires_reconciliation", contextSnapshot: { issueId }, createdAt: at(created),
      startedAt: at(created), finishedAt: at(finished), ...extra });
    await db.insert(heartbeatRuns).values([
      failed(earlier, -8, 2, { status: "succeeded", errorCode: null }),
      failed(P, 3, 34, { nativeSessionId: sessionId, runnerInstanceId: randomUUID() }),
      failed(S0, 44, 45, { nativeSessionId: sessionId }),
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId: P, companyId, issueId, phase: "terminal_failure", attempt: 2, controllerGeneration: 2, recoveryState: "blocked",
        failureCode: "native_continuation_requires_reconciliation" },
      { runId: S0, companyId, issueId, phase: "terminal_failure", attempt: 0, controllerGeneration: 0, recoveryState: "blocked",
        failureCode: "native_continuation_requires_reconciliation" },
    ]);
    const lease = async (runId: string, box: string, acquired: Date, released: Date | null, receipt: boolean, policy = "retain_on_failure") => {
      const identity = { id: randomUUID(), companyId, heartbeatRunId: runId, provider: "boat", providerLeaseId: box };
      const stop = receipt ? remoteTerminationReceipt(identity, { providerLeaseId: box, state: "stopped" }) : undefined;
      if (stop) stop.confirmedAt = (released ?? acquired).toISOString();
      await db.insert(environmentLeases).values({ ...identity, environmentId: environment!.id, issueId,
        status: released ? "released" : "active", leasePolicy: policy, acquiredAt: acquired, releasedAt: released,
        cleanupStatus: released ? "success" : null, metadata: stop ? { remoteExecutionTermination: stop } : {} });
    };
    // 846aacc1-shape: an EARLIER, released holder of P's box must not veto.
    await lease(earlier, "bx_ngxpne73", at(-5), at(2), false, "reuse_by_environment");
    await lease(P, "bx_ngxpne73", at(3), at(34.6), v.pReceipt !== false);
    await lease(S0, "bx_c2m2nuhj", at(44), v.s0LiveLease ? null : at(45.5), v.s0Receipt !== false, "reuse_by_environment");
    if (v.laterHolderOn) await lease(earlier, v.laterHolderOn === "p" ? "bx_ngxpne73" : "bx_c2m2nuhj", at(50), at(55), false);
    const contractId = randomUUID();
    if (v.s0Result) await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "v1",
      policyVersion: "v1", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {},
      canonicalSha256: "c".repeat(64), createdByActorType: "system", createdByActorId: "test" } as never);
    if (v.s0Result) await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, S0));
    if (v.s0Result) await db.insert(nativeRunResults).values({ companyId, issueId, runId: S0, completionContractId: contractId,
      serverFingerprint: "f", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "x".repeat(64) } as never);
    // S: the person's next authorized message, running, unbound, on its own (third) box.
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, body: "What happened to the previous turn, and what work is still outstanding?",
      authorType: "user", authorUserId: "board", createdAt: at(70) });
    await db.insert(heartbeatRuns).values({ id: S, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running",
      invocationSource: "on_demand", createdAt: at(71), startedAt: at(71),
      contextSnapshot: { issueId, wakeCommentId: commentId, explicitUserContinuation: { commentId, actorId: "board" } } });
    await lease(S, v.successorBox ?? "bx_third", at(71), null, false, "reuse_by_environment");
    if (v.pointer !== "none") await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner",
      taskKey: issueId, lastRunId: P, sessionParamsJson: { sessionId, [PI_CONVERSATION_KEY]: { schema: "paperclip.pi-conversation.v1",
        id: sessionId, generation: 1, boundary: { provider: "pi_rpc", cwd: "/workspace", remoteCwd: null, workspaceId: null, trust: "t" },
        previousId: null, reason: "first_message", runId: P } } });
    const select = () => selectPiConversation(db, { companyId, agentId, issueId, runId: S,
      boundary: { provider: "pi_rpc", cwd: "/workspace", remoteCwd: "/workspace", workspaceId: null, trust: "t" } });
    return { companyId, agentId, issueId, commentId, P, S0, S, sessionId, select };
  }
  type F = Awaited<ReturnType<typeof seed>>;
  const actions = (f: F) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  const run = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const notes = (f: F) => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));

  it("R-planted: rotates once to a NEW normalized id whose source equals P's pointer (:113), fences P and S0, writes the true notice", async () => {
    const f = await seed();
    const record = await f.select();
    const [action] = await actions(f);
    // The :113 equality, with its actual operand: previous.id (Pi record) === boundary source === P.nativeSessionId.
    expect({ previousId: record.previousId, reason: record.reason, runId: record.runId })
      .toEqual({ previousId: f.sessionId, reason: `fresh_continuation:${action?.id}`, runId: f.S });
    expect(record.id).not.toBe(f.sessionId);
    expect(action!.evidence).toMatchObject({ runId: f.P, continuationRunId: f.S, continuationDelivery: "delivered",
      freshContinuation: { trigger: "successor_admission", delivery: "caller_owns", isolation: "writer_ended", stopProof: "writer_ended" },
      freshContinuationSettlement: { replay: "none" },
      unfinishedTurn: { kind: "unfinished_turn", body: FACT, sourceRunId: f.P, sourceSessionId: f.sessionId,
        predecessorRunIds: [f.P, f.S0].sort(), successorRunId: f.S, authorizationCommentId: f.commentId } });
    expect((await run(f.P)).resultJson?.freshContinuationSupersededAt).toEqual(expect.any(String));
    expect((await run(f.S0)).resultJson?.freshContinuationSupersededAt).toEqual(expect.any(String));
    expect((await notes(f)).map(note => note.body)).toEqual([NOTE]);
    // Same S again (restart after the committed selection): the same id, no second boundary or notice.
    const again = await f.select();
    expect(again.id).toBe(record.id);
    expect(await actions(f)).toHaveLength(1);
    expect(await notes(f)).toHaveLength(1);
  });

  it("F2: the unfinished_turn fact reaches S's persisted task prompt (the startTurn input), first and non-droppable", async () => {
    const f = await seed();
    const record = await f.select();
    const { readUnfinishedTurnEntry } = await import("./fresh-continuation-fallback.js");
    const entry = await readUnfinishedTurnEntry(db, { companyId: f.companyId, runId: f.S, actionId: record.reason.slice("fresh_continuation:".length) });
    expect(entry).toMatchObject({ kind: "unfinished_turn", body: FACT, sourceRunId: f.P, successorRunId: f.S });
    // Saturate history and leave no run summary: the entry still leads the packet.
    await db.insert(issueComments).values(Array.from({ length: 30 }, (_, i) => ({ companyId: f.companyId, issueId: f.issueId,
      body: `history ${i} ${"x".repeat(3_900)}`, authorType: "user" as const, authorUserId: "board", createdAt: new Date(Date.parse("2026-11-17T00:10:00Z") + i * 1000) })));
    const s = await run(f.S);
    const loader = createNativeSessionHandoffLoader({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      before: s.createdAt, throughCommentId: f.commentId });
    const packet = await loader(entry as never);
    expect(packet).toContain(FACT);
    expect(Buffer.byteLength(packet!, "utf8")).toBeLessThanOrEqual(24_000);
    expect(packet).not.toContain("Starting a fresh thread"); // the post-createdAt notice stays outside the cutoff
    // Mutant (planted) — omitted: the generic loader packet lacks the fact => RED for a recall carrier.
    expect(await loader()).not.toContain(FACT);
    // Mutant (planted) — faked completion: a boundary whose fact claims completion is not a carrier (HOLD upstream).
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{unfinishedTurn,body}', '"The previous turn completed."'::jsonb)` })
      .where(eq(issueRecoveryActions.id, entry!.id as string));
    expect(await readUnfinishedTurnEntry(db, { companyId: f.companyId, runId: f.S, actionId: entry!.id as string })).toBeNull();
  });

  it("refuses (no rotation, no boundary, no fence, no notice) when P has no stop receipt", async () => {
    await expectRefused(await seed({ pReceipt: false }));
  });
  it("refuses when S0 has no stop receipt (S0 is a safety predecessor too)", async () => {
    await expectRefused(await seed({ s0Receipt: false }));
  });
  it("refuses when another run's lease acquired P's box after its receipt (B1, consumed from the shared reader)", async () => {
    await expectRefused(await seed({ laterHolderOn: "p" }));
  });
  it("refuses when only S0's box went stale (one stale box of two)", async () => {
    await expectRefused(await seed({ laterHolderOn: "s0" }));
  });
  it("refuses when S sits on a predecessor's stopped box (same-box 'stopped')", async () => {
    await expectRefused(await seed({ successorBox: "bx_ngxpne73" }));
  });
  it("refuses when either predecessor has an accepted result row", async () => {
    await expectRefused(await seed({ s0Result: true }));
  });
  it("refuses when a predecessor's lease is still open", async () => {
    await expectRefused(await seed({ s0LiveLease: true }));
  });

  async function expectRefused(f: F) {
    const record = await f.select().catch(error => error as Error);
    if (!(record instanceof Error)) expect(record.reason).not.toMatch(/^fresh_continuation:/);
    expect(await actions(f)).toEqual([]);
    expect((await run(f.P)).resultJson?.freshContinuationSupersededAt).toBeUndefined();
    expect((await run(f.S0)).resultJson?.freshContinuationSupersededAt).toBeUndefined();
    expect(await notes(f)).toEqual([]);
  }

  it("A2 lock order: the running-S cut and a coordinator-order writer (issue -> run -> coordinator) on P do not deadlock", async () => {
    const f = await seed();
    const writer = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("key share");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.P)).for("update");
      await tx.execute(sql`select pg_sleep(0.3)`);
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.P)).for("update");
    });
    const [selected, written] = await Promise.allSettled([f.select(), writer]);
    expect(written.status).toBe("fulfilled");
    expect(selected.status).toBe("fulfilled");
  });

  it("Q5: P's quarantine copy is byte-identical before/after (per-file inventory; planted copy)", async () => {
    const root = await mkdtemp(join(tmpdir(), "q5-copy-")); dirs.push(root);
    const copy = join(root, "f7f32429.identity_indeterminate.1794879872395.7");
    await mkdir(join(copy, "control-plane", "failover-backups"), { recursive: true });
    await writeFile(join(copy, "control-plane", "control-plane-state.json"), JSON.stringify({ commands: [
      { seq: 230, type: "turn.interrupt", status: "pending" }, { seq: 231, type: "turn.stop", status: "pending" },
      { seq: 232, type: "runner.suspend", status: "pending" }] }));
    for (let i = 0; i < 5; i++) await writeFile(join(copy, "control-plane", "failover-backups", `b${i}.json`), `backup ${i}`);
    const inventory = async () => {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) { out.push(`d ${path}`); await walk(path); }
          else out.push(`f ${path} ${createHash("sha256").update(await readFile(path)).digest("hex")}`);
        }
      };
      await walk(root); return out;
    };
    const before = await inventory();
    const f = await seed();
    await f.select();
    expect(await inventory()).toEqual(before);
  });

  it("does nothing without the conversation's pointer (no source to compare at :113)", async () => {
    const f = await seed({ pointer: "none" });
    const record = await f.select().catch(error => error as Error);
    if (!(record instanceof Error)) expect(record.reason).not.toMatch(/^fresh_continuation:/);
    expect(await actions(f)).toEqual([]);
  });
});
