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
//
// build-7e625560c: N4 (P's controller journal / its one quarantine copy read
// READ-ONLY at admission: only lifecycle commands may be pending) and F2 at the
// actual session.startTurn envelope (executeNativeSession -> fake Pi session's
// startTurn) across server-restart cuts. Every select() takes a Q5 per-file
// sha256 inventory of the runner state base before/after. P's journal and copy
// are PLANTED (Q1 shape: canonical absent, one identity_indeterminate copy).
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
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { scopedRunnerdStateRoot } from "./native-runtime/native-session-executor.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { executeNativeSession, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";

const FACT = "The previous turn did not finish and produced no accepted result.";
const NOTE = `${FACT} The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.`;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("7e625560 unfinished turn: fresh thread at the running-S cut", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const dirs: string[] = [];
  let stateBase = "";
  beforeAll(async () => {
    stateBase = await mkdtemp(join(tmpdir(), "unfinished-turn-state-")); dirs.push(stateBase);
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    database = await startEmbeddedPostgresTestDatabase("unfinished-turn-fresh-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end(); await database?.cleanup();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  });

  type Variant = { pReceipt?: boolean; s0Receipt?: boolean; laterHolderOn?: "p" | "s0"; successorBox?: string;
    s0Result?: boolean; pointer?: "p" | "none"; s0LiveLease?: boolean; successorEnvironment?: "other";
    /** P's controller journal (PLANTED). Default: lifecycle-only pending (turn.interrupt/turn.stop/runner.suspend). */
    journal?: "lifecycle" | "turn.start" | "external_provider.operation" | "semantic_tool.result" | "tool_input" | "none";
    journalAt?: "copy" | "root" };

  async function inventory(root: string) {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { out.push(`d ${path}`); await walk(path); }
        else out.push(`f ${path} ${createHash("sha256").update(await readFile(path)).digest("hex")}`);
      }
    };
    await walk(root); return out;
  }

  async function seed(v: Variant = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), commentId = randomUUID();
    const P = randomUUID(), S0 = randomUUID(), S = randomUUID(), sessionId = randomUUID(), earlier = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "7e625560", defaultResponsibleUserId: "board",
      issuePrefix: `U${companyId.replaceAll("-", "").slice(0, 12)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Paul's chat", status: "blocked", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ name: `boat-${issueId}`, driver: "sandbox" }).returning();
    const pRunner = randomUUID();
    const pExecution = buildNativeExecutionInput({ companyId, agentId, runId: P, provider: "pi_rpc", model: "paperclip/faux",
      piRpcThinkingLevel: "xhigh", issue: { id: issueId, identifier: "U-1", title: "Paul's chat", description: null, workMode: "standard" },
      taskPrompt: "P's turn", workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: sessionId, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 }, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Answer", criteria: [{ id: "work", requirement: "Answer" }] } } } as never);
    if (v.journal !== "none") {
      const scoped = scopedRunnerdStateRoot(pExecution as never);
      const root = v.journalAt === "root" ? scoped
        : join(stateBase, "quarantine", `${scoped.split("/").pop()}.identity_indeterminate.1794879872395.7`);
      await mkdir(join(root, "control-plane"), { recursive: true, mode: 0o700 });
      await mkdir(join(stateBase, "quarantine"), { recursive: true, mode: 0o700 });
      const commands: Array<Record<string, unknown>> = [
        { seq: 1, type: "session.open", status: "completed" }, { seq: 2, type: "turn.start", status: "completed" },
        { seq: 230, type: "turn.interrupt", status: "pending" }, { seq: 231, type: "turn.stop", status: "pending" },
        { seq: 232, type: "runner.suspend", status: "pending" }];
      const committedEvents: Array<Record<string, unknown>> = [{ eventType: "turn.started", sourceEventId: "e1" }];
      if (v.journal === "turn.start") commands.push({ seq: 233, type: "turn.start", status: "pending" });
      if (v.journal === "external_provider.operation") commands.push({ seq: 233, type: "external_provider.operation", status: "dispatched" });
      if (v.journal === "semantic_tool.result") commands.push({ seq: 233, type: "semantic_tool.result", status: "pending", payload: { sourceEventId: "e2" } });
      if (v.journal === "tool_input") committedEvents.push({ eventType: "semantic_tool.input", sourceEventId: "e3" });
      await writeFile(join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
        schema: "paperclip.runner.durable.control-plane-state.v2",
        identity: { runId: P, normalizedSessionId: sessionId, runnerInstanceId: pRunner, environmentLeaseId: randomUUID() },
        commands, committedEvents }));
      await mkdir(join(root, "control-plane", "failover-backups"), { recursive: true, mode: 0o700 });
      for (let i = 0; i < 3; i++) await writeFile(join(root, "control-plane", "failover-backups", `b${i}.json`), `backup ${i} ${P}`);
    }
    const at = (min: number) => new Date(Date.parse("2026-11-17T01:00:00.000Z") + min * 60_000);
    const failed = (id: string, created: number, finished: number, extra: Record<string, unknown> = {}) => ({ id, companyId, agentId,
      nativeIssueId: issueId, runtimeMode: "native" as const, status: "failed" as const,
      errorCode: "native_continuation_requires_reconciliation", contextSnapshot: { issueId }, createdAt: at(created),
      startedAt: at(created), finishedAt: at(finished), ...extra });
    await db.insert(heartbeatRuns).values([
      failed(earlier, -8, 2, { status: "succeeded", errorCode: null }),
      failed(P, 3, 34, { nativeSessionId: sessionId, runnerInstanceId: pRunner,
        runnerProfileJson: { nativeExecutionInput: pExecution } }),
      failed(S0, 44, 45, { nativeSessionId: sessionId }),
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId: P, companyId, issueId, phase: "terminal_failure", attempt: 2, controllerGeneration: 2, recoveryState: "blocked",
        failureCode: "native_continuation_requires_reconciliation" },
      { runId: S0, companyId, issueId, phase: "terminal_failure", attempt: 0, controllerGeneration: 0, recoveryState: "blocked",
        failureCode: "native_continuation_requires_reconciliation" },
    ]);
    const [otherEnvironment] = await db.insert(environments).values({ name: `boat-other-${issueId}`, driver: "sandbox" }).returning();
    const lease = async (runId: string, box: string, acquired: Date, released: Date | null, receipt: boolean, policy = "retain_on_failure",
      environmentId = environment!.id) => {
      const identity = { id: randomUUID(), companyId, heartbeatRunId: runId, provider: "boat", providerLeaseId: box };
      const stop = receipt ? remoteTerminationReceipt(identity, { providerLeaseId: box, state: "stopped" }) : undefined;
      if (stop) stop.confirmedAt = (released ?? acquired).toISOString();
      await db.insert(environmentLeases).values({ ...identity, environmentId, issueId,
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
    await lease(S, v.successorBox ?? "bx_third", at(71), null, false, "reuse_by_environment",
      v.successorEnvironment === "other" ? otherEnvironment!.id : environment!.id);
    if (v.pointer !== "none") await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner",
      taskKey: issueId, lastRunId: P, sessionParamsJson: { sessionId, [PI_CONVERSATION_KEY]: { schema: "paperclip.pi-conversation.v1",
        id: sessionId, generation: 1, boundary: { provider: "pi_rpc", cwd: "/workspace", remoteCwd: null, workspaceId: null, trust: "t" },
        previousId: null, reason: "first_message", runId: P } } });
    // Q5 in every row: the runner state base (P's copy included) is byte-identical across admission.
    const select = async (client: ReturnType<typeof createDb> = db) => {
      const before = await inventory(stateBase);
      const result = await selectPiConversation(client, { companyId, agentId, issueId, runId: S,
        boundary: { provider: "pi_rpc", cwd: "/workspace", remoteCwd: "/workspace", workspaceId: null, trust: "t" } }).catch(error => error as Error);
      expect(await inventory(stateBase), "Q5: P's journal/copy untouched").toEqual(before);
      if (result instanceof Error) throw result;
      return result;
    };
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
  it("refuses when S sits on a predecessor's physical box recorded under another environment (provider + providerLeaseId, not the reader's scope)", async () => {
    await expectRefused(await seed({ successorBox: "bx_c2m2nuhj", successorEnvironment: "other" }));
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

  // N4 (PLANTED journal; real admission through selectPiConversation). The passing lifecycle-only mate is R-planted
  // (copy) and the canonical-root mate below; each non-lifecycle pending entry refuses BEFORE any provider start.
  it("N4 mate: lifecycle-only pending commands in P's canonical root admit (one fresh thread)", async () => {
    const f = await seed({ journalAt: "root" });
    expect((await f.select()).reason).toMatch(/^fresh_continuation:/);
  });
  for (const journal of ["turn.start", "external_provider.operation", "semantic_tool.result", "tool_input"] as const) {
    it(`N4: a pending ${journal} in P's quarantine copy refuses; the copy is read, never settled`, async () => {
      await expectRefused(await seed({ journal }));
    });
  }
  it("N4: a pending turn.start in P's canonical root refuses", async () => {
    await expectRefused(await seed({ journal: "turn.start", journalAt: "root" }));
  });
  it("N4: no journal and no copy for P holds (no invented empty journal)", async () => {
    await expectRefused(await seed({ journal: "none" }));
  });

  // F2 at the ACTUAL session.startTurn envelope, across server-restart cuts. Cut 1: admission commits, the server
  // restarts (new DB client, new loader: no module memo survives), selection re-runs for the same S. Cut 2: S's
  // native input is persisted, the server restarts, and executeNativeSession (the runner's production entry,
  // native-session-runtime.ts:3535) submits the persisted input to the Pi session's startTurn. The prompt assembly
  // mirrors runtime-selection.ts:891 (header, unfinished-turn packet) and is the only replicated step.
  async function submitted(f: F, client: ReturnType<typeof createDb>) {
    const record = await f.select(client); // same S after the restart: same id, no second boundary
    const { readUnfinishedTurnEntry } = await import("./fresh-continuation-fallback.js");
    const entry = await readUnfinishedTurnEntry(client, { companyId: f.companyId, runId: f.S, actionId: record.reason.slice("fresh_continuation:".length) });
    const s = (await client.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.S)))[0]!;
    const packet = entry ? await createNativeSessionHandoffLoader({ db: client, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      before: s.createdAt, throughCommentId: f.commentId })(entry as never) : null;
    const execution = buildNativeExecutionInput({ companyId: f.companyId, agentId: f.agentId, runId: f.S, provider: "pi_rpc", model: "paperclip/faux",
      piRpcThinkingLevel: "xhigh", issue: { id: f.issueId, identifier: "U-1", title: "Paul's chat", description: null, workMode: "standard" },
      taskPrompt: ["# U-1: Paul's chat", packet].filter(Boolean).join("\n\n"),
      workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: record.id,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 }, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Answer", criteria: [{ id: "work", requirement: "Answer" }] } } } as never);
    await client.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.S));
    return record;
  }
  async function startTurnInput(connection: string, runId: string) {
    const client = createDb(connection); // cut 2: a restarted server reads S's persisted input
    try {
      const [s] = await client.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const input = parseNativeExecutionInput(s!.runnerProfileJson?.nativeExecutionInput);
      const starts: Array<{ message: { text: string } }> = [];
      const identity = { runId, sessionId: input.session.normalizedSessionId, companyId: input.binding.companyId,
        issueId: input.binding.issueId, agentId: input.binding.agentId };
      let ended: () => void = () => undefined;
      const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const session = { identity: () => identity, async capabilities() { return capabilities; },
        async *events() { await new Promise<void>(resolve => { ended = resolve; }); },
        async startTurn(value: { message: { text: string } }) { starts.push(structuredClone(value)); ended(); return { turnId: "turn-1" }; },
        async interrupt() { ended(); }, async result() { return null; },
        async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity, providerSessionId: "p", cursor: "0",
          activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }; }, async close() { ended(); } };
      const outcome = await executeNativeSession({ input,
        backend: { async descriptor() { return { kind: "mock", name: "pi-capture", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; }, async openSession() { return session; } },
        controlPlane: { async openRun() {}, async checkpointSession() {},
          async appendEvent(value: { sourceSeq: number }) { return { cursor: value.sourceSeq, highestContiguousSourceSeq: value.sourceSeq, disposition: "committed" }; },
          async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; }, async completeRun() {} },
        runnerInstanceId: "runner-capture", controlPlaneInstanceId: "control-capture", timeoutMs: 5_000 } as never)
        .then(() => "finalized", (error: unknown) => String(error instanceof Error ? error.message : error));
      return Object.assign(starts, { outcome });
    } finally { await client.$client.end(); }
  }
  it("F2-startTurn: the unfinished_turn fact is in the envelope the Pi session's startTurn receives, across restart cuts", async () => {
    const f = await seed();
    await f.select(); // admission commits the boundary
    const restarted = createDb(database.connectionString); // cut 1: server restart between admission and start
    try { await submitted(f, restarted); } finally { await restarted.$client.end(); }
    const starts = await startTurnInput(database.connectionString, f.S);
    expect(starts, starts.outcome).toHaveLength(1);
    const envelope = JSON.parse(starts[0]!.message.text);
    expect(envelope.task.prompt).toContain(FACT);
    expect(envelope.task.prompt).toMatch(/unfinished_turn/);
    // Faked completion would be a different, false fact: the submitted input never claims completion or no actions.
    expect(envelope.task.prompt).not.toMatch(/previous turn (completed|finished)|took no actions|produced an accepted result/i);
    expect(envelope.schema).not.toBe("paperclip.native-continuation.v1");
    expect(await actions(f)).toHaveLength(1);
    expect(await notes(f)).toHaveLength(1);
  });
});
