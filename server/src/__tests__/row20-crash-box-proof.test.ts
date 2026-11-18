import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authUsers, agents, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases,
  environments, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// KEEP (never-OK, row 20 crash path; adopt-stopu-compose8, rf-4 00:43Z): the
// server crashed after the durable cancel and before NSE recorded the stopped
// session's close. The box is alive. Fixture = the durable rows only (no
// nativeStoppedSessionClose, no deferral, nothing owns the run). Only the
// provider turn is scripted and the box is a local directory whose commands run
// locally (as xpaths-person-stop-release-export.test.ts).
const providerTurns = vi.hoisted(() => [] as string[]);
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    providerTurns.push(input.execution.binding.runId);
    throw new Error("row20_successor_provider_turn_reached");
  }) as typeof actual.executePaperclipNativeSession };
});
const boxTargets = vi.hoisted(() => new Map<string, unknown>());
const boxUnanswering = vi.hoisted(() => new Set<string>());
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async input => {
    if (!input.leaseId || !boxTargets.has(input.leaseId)) return actual.resolveEnvironmentExecutionTarget(input);
    if (boxUnanswering.has(input.leaseId)) await new Promise(() => undefined);
    return boxTargets.get(input.leaseId);
  }) as typeof actual.resolveEnvironmentExecutionTarget };
});

import type { EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { PERSON_STOP_WITHOUT_FILES_LINE, readPersonStopBoundDecision } from "../services/heartbeat/person-stop-export-bound.js";
import { hasCleanStoppedSessionClose } from "../services/heartbeat/cancelled-warm-workspace-export.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(!support.supported)("row 20 crash path: the clean-close proof is established after the fact on the live box", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("row20-proof-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "row20-proof-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "row20-person", name: "Person", email: "row20p@example.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    if (home) await new Promise(resolve => execFile("chmod", ["-R", "u+w", home], resolve));
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.end(input.stdin ?? "");
  }) };

  async function crashFixture(label: string) {
    providerTurns.length = 0;
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const stoppedAt = new Date(Date.now() - 60_000);
    const remoteCwd = path.join(home, `box-${runId}`), hostCwd = path.join(home, `host-${runId}`);
    await fs.mkdir(remoteCwd); await fs.mkdir(hostCwd);
    await fs.writeFile(path.join(hostCwd, "notes.md"), "host base\n");
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: label, issuePrefix,
      defaultResponsibleUserId: "row20-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "row20-person",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Crash box ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "fake", image: "fixture:test", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue my chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "row20-person", issueNumber: 1,
      identifier: `${issuePrefix}-1`, conversationAgentId: agentId, conversationUserId: "row20-person",
      conversationState: "active", executionRunId: null, checkoutRunId: null });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", nativePhase: "terminal_failure", invocationSource: "on_demand",
      status: "cancelled", errorCode: "cancelled", error: "Cancelled by a board operator", nextEventSeq: 2,
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      controllerLeaseExpiresAt: new Date(stoppedAt.getTime() - 1), contextSnapshot: { issueId, taskId: issueId },
      // The crash came before NSE recorded the session close: NO nativeStoppedSessionClose.
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "row20-person", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
        reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString(),
      } } });
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "fake", leaseId,
      remoteCwd, runner: boxRunner, timeoutMs: 30_000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } };
    boxTargets.set(leaseId, target);
    const [leaseRow] = await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
      heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true,
        reusableSandboxLease: true, remoteCwd, agentId },
      acquiredAt: new Date(stoppedAt.getTime() - 60_000), lastUsedAt: stoppedAt,
      createdAt: new Date(stoppedAt.getTime() - 60_000), updatedAt: stoppedAt }).returning();
    const prepared = await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: hostCwd,
      target, lease: leaseRow as unknown as EnvironmentLease, resourceDisposition: "keep_running" });
    expect(prepared?.reference.state).toBe("prepared");
    // The stopped turn's tool edited the box; the edit was never exported.
    const owedFile = path.join(remoteCwd, "notes.md");
    await fs.writeFile(owedFile, `edit made before Stop, not yet exported: ${randomUUID()}\n`);
    const expectedSha = sha(await fs.readFile(owedFile));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "tool.execution.started", stream: "system" });
    return { companyId, agentId, runId, issueId, leaseId, providerLeaseId, owedFile, hostCwd, expectedSha };
  }

  async function sendAndWait(f: Awaited<ReturnType<typeof crashFixture>>, heartbeat: ReturnType<typeof heartbeatService>) {
    const hostAtTurn = new Map<string, string | null>();
    const sweep = await heartbeat.sweepOrphanedActiveLeases({ companyId: f.companyId, leaseId: f.leaseId, backoffMs: 0 });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "row20-person", body: "Please answer using my kept notes.md." }).returning();
    const admissionAt = Date.now();
    await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "row20-person", payload: { issueId: f.issueId, commentId: comment.id },
      contextSnapshot: { issueId: f.issueId, commentId: comment.id, wakeReason: "issue_commented" } });
    let messageRuns: (typeof heartbeatRuns.$inferSelect)[] = [];
    for (;;) {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      for (const turn of providerTurns) if (!hostAtTurn.has(turn))
        hostAtTurn.set(turn, await fs.readFile(path.join(f.hostCwd, "notes.md")).then(sha, () => null));
      messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.id} <> ${f.runId}`));
      if (providerTurns.length > 0 || Date.now() - admissionAt >= 15_000) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const elapsedMs = Date.now() - admissionAt;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    return { sweep, elapsedMs, lease, run, messageRuns, hostAtTurn: Object.fromEntries(hostAtTurn),
      providerTurns: [...providerTurns], decision: readPersonStopBoundDecision(lease.metadata),
      withoutFilesLines: events.filter(e => e.message === PERSON_STOP_WITHOUT_FILES_LINE).map(e => e.eventType).sort(),
      boxSha: await fs.readFile(f.owedFile).then(sha, () => null) };
  }

  it("the box answers: the stopped turn's processes are killed and verified gone, the proof is recorded as NSE's is, and the message runs once WITH the files", async () => {
    const f = await crashFixture("Row 20 box answers");
    // The stopped turn's tool, still running on the box after the server crash:
    // its own process group (a shell and a child), carrying the turn's run id.
    const stray = spawn("sh", ["-c", "sleep 600 & wait"], { detached: true, stdio: "ignore",
      env: { ...process.env, PAPERCLIP_RUN_ID: f.runId } });
    stray.unref();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(stray.pid!)).toBe(true);
    const provider = getSandboxProvider("fake")!;
    const destroy = vi.spyOn(provider, "destroyLease");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      const r = await sendAndWait(f, heartbeat);
      const proof = (r.run.runnerProfileJson as Record<string, unknown>).nativeStoppedSessionClose as Record<string, unknown>;
      const evidence = { case: "answers", elapsedMs: r.elapsedMs, decision: r.decision, proof, strayPid: stray.pid,
        strayAlive: alive(stray.pid!), messageRuns: r.messageRuns.map(m => m.id), providerTurns: r.providerTurns,
        hostAtTurn: r.hostAtTurn, expectedSha: f.expectedSha, boxSha: r.boxSha, withoutFilesLines: r.withoutFilesLines,
        leaseStatus: r.lease.status, destroyCalls: destroy.mock.calls.length };
      console.log("ROW20_PROOF_EVIDENCE", JSON.stringify(evidence));
      if (process.env.ROW20_PROOF_EVIDENCE_FILE) await fs.appendFile(process.env.ROW20_PROOF_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
      // The after-the-fact proof: recorded where NSE records it, accepted by F13.
      expect(hasCleanStoppedSessionClose(r.run)).toBe(true);
      expect(proof).toMatchObject({ clean: true, via: "box_stopped_turn_kill_after_crash", remaining: [] });
      expect(proof.found).toContain(stray.pid);
      expect(proof.killedGroups).toContain(stray.pid);
      expect(evidence.strayAlive).toBe(false);
      // Branch A (same box) was available; the bounded export ran first.
      expect(r.decision).toMatchObject({ decision: "same_box", reason: "box_reachable_tools_stopped" });
      expect(r.withoutFilesLines).toEqual([]);
      // ONE run, no hold, the files present when its turn starts.
      expect(r.providerTurns).toHaveLength(1);
      expect(r.messageRuns).toHaveLength(1);
      expect(r.elapsedMs).toBeLessThan(12_000);
      expect(r.hostAtTurn[r.providerTurns[0]!]).toBe(f.expectedSha);
      expect(r.boxSha).toBe(f.expectedSha);
      expect(destroy.mock.calls.filter(([i]) => i.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      destroy.mockRestore();
      try { process.kill(-stray.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 90_000);

  it("the box does not answer within the bound: 'without the files' AT ONCE, the true line, the box kept", async () => {
    const f = await crashFixture("Row 20 box silent");
    boxUnanswering.add(f.leaseId);
    const provider = getSandboxProvider("fake")!;
    const destroy = vi.spyOn(provider, "destroyLease");
    const stop = vi.spyOn(provider, "stopLease");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      const r = await sendAndWait(f, heartbeat);
      const evidence = { case: "silent", elapsedMs: r.elapsedMs, decision: r.decision,
        proof: (r.run.runnerProfileJson as Record<string, unknown>).nativeStoppedSessionClose ?? null,
        messageRuns: r.messageRuns.map(m => m.id), providerTurns: r.providerTurns, withoutFilesLines: r.withoutFilesLines,
        leaseStatus: r.lease.status, boxSha: r.boxSha, expectedSha: f.expectedSha,
        stopCalls: stop.mock.calls.length, destroyCalls: destroy.mock.calls.length };
      console.log("ROW20_PROOF_EVIDENCE", JSON.stringify(evidence));
      if (process.env.ROW20_PROOF_EVIDENCE_FILE) await fs.appendFile(process.env.ROW20_PROOF_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
      expect(r.decision).toMatchObject({ decision: "without_files", reason: "box_unreachable_target" });
      expect(evidence.proof).toBeNull();
      // At once: the bound is the 5 s probe, not the 5-minute hold.
      expect(r.elapsedMs).toBeLessThan(12_000);
      expect(r.providerTurns).toHaveLength(1);
      expect(r.withoutFilesLines).toEqual(["provider.notice.recorded", "workspace_export_bound_reached"]);
      // The box is kept: lease active, never stopped or destroyed, the edit on it.
      expect(r.lease.status).toBe("active");
      expect(stop.mock.calls.filter(([i]) => i.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
      expect(destroy.mock.calls.filter(([i]) => i.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
      expect(r.boxSha).toBe(f.expectedSha);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      destroy.mockRestore(); stop.mockRestore();
    }
  }, 90_000);
});
