import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments,
  heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-stopu-proof: the ordinary Stop during a command, at the release-site
// export (the boundary that ran BEFORE NSE's decision on run 4f211436). The
// box is a local directory reached through the Runner command path; the
// turn's foreground command and an escaped writer are REAL processes working
// in it. The kept box target resolves as the finalizer does (mocked only for
// this lease, as xpaths-person-stop-release-export.test.ts).
const boxTargets = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async input => {
    if (!input.leaseId || !boxTargets.has(input.leaseId)) return actual.resolveEnvironmentExecutionTarget(input);
    return boxTargets.get(input.leaseId);
  }) as typeof actual.resolveEnvironmentExecutionTarget };
});

import type { EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference } from "../services/native-runtime/native-workspace-sync.js";
import { nativeWorkspaceExportPendingForResource } from "../services/native-runtime/native-workspace-finalization-state.js";
import { exportPersonStoppedWarmWorkspaceBeforeRelease, personStopExportPendingHoldsAdmission }
  from "../services/heartbeat/person-stop-release-export.js";
import { CANCELLED_WARM_EXPORT_TIMEOUT_MS } from "../services/heartbeat/cancelled-warm-workspace-export.js";
import { providerResourceDispositionForTerminalRun } from "../services/runner-environment-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid: number | undefined) => { try { process.kill(pid!, 0); return true; } catch { return false; } };

describe.skipIf(!support.supported)("adopt-stopu-proof: a retained person's Stop exports at once, with the process-gone proof", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("stopu-proof-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "stopu-proof-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    for (const child of children) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.end(input.stdin ?? "");
  }) };

  /** A real process working in the box's task workspace (cwd = box). */
  function onBox(cwd: string, script: string) {
    const child = spawn("sh", ["-c", script], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    children.push(child);
    return child;
  }

  type Shape = { order: "before" | "after" | "never"; session?: "retained" | "closed_clean" | "closed_unclean";
    escapedWriter?: boolean; respawner?: boolean };

  async function hardShape(shape: Shape) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const remoteCwd = path.join(home, `box-${runId}`), hostCwd = path.join(home, `host-${runId}`);
    await fs.mkdir(remoteCwd); await fs.mkdir(hostCwd);
    await fs.writeFile(path.join(hostCwd, "notes.md"), "host base\n");
    const prefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Proof", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi", model: null }, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Box ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "fake", image: "fixture:test", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Edit notes", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${prefix}-1` });
    // The turn starts now (the warm box's Runner started before it).
    const turnStartedAt = new Date(Date.now() - 1_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, scopeKind: "issue",
      runtimeMode: "native", invocationSource: "on_demand", status: "running", nextEventSeq: 2, startedAt: turnStartedAt,
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "fake", leaseId,
      remoteCwd, runner: boxRunner, timeoutMs: 30_000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } };
    boxTargets.set(leaseId, target);
    const [leaseRow] = await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
      heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", provider: "fake", reuseLease: true, reusableSandboxLease: true, remoteCwd, agentId } }).returning();
    const prepared = await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: hostCwd,
      target, lease: leaseRow as unknown as EnvironmentLease, resourceDisposition: "keep_running" });
    expect(prepared?.reference.state).toBe("prepared");
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "tool.execution.started", stream: "system" });

    // The turn's tool edits the box, then runs a FOREGROUND command (sleep):
    // the person's Stop lands 12-14 s into it (here: while it runs).
    const edit = `edited on the box by the stopped turn ${randomUUID()}\n`;
    await fs.writeFile(path.join(remoteCwd, "notes.md"), edit);
    const foreground = onBox(remoteCwd, "exec sleep 600");
    // An escaped writer: re-parented away from Pi, still writing the workspace.
    const writer = shape.escapedWriter
      ? onBox(remoteCwd, "while :; do printf 'late write %s\\n' $$ >> notes.md; sleep 0.05; done") : null;
    // A writer that keeps coming back (its parent predates the turn: not killed
    // by the check, its children respawn): the tools are NOT provably gone.
    let respawner: ChildProcess | null = null;
    if (shape.respawner) {
      await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() + 1_500) }).where(eq(heartbeatRuns.id, runId));
      respawner = onBox(remoteCwd, "while :; do (sleep 30) & sleep 0.05; done");
      await new Promise(resolve => setTimeout(resolve, 2_500));
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(foreground.pid)).toBe(true);

    // The person's Stop: acknowledged, the run terminal cancelled (the cancel
    // route; executionCancellation 'requested', NOT yet acknowledged).
    const stoppedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: stoppedAt,
      nativePhase: "terminal_failure",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "person", executionCancellation: { state: "requested" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
          reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } })
      .where(eq(heartbeatRuns.id, runId));
    // NSE's own decision, written exactly as native-session-executor.ts does
    // (the retained-idle receipt in the settle transaction / the close record
    // after releaseWarmNativeSession's ladder).
    const writeDecision = async () => {
      const decision = shape.session ?? "retained";
      const patch = decision === "retained"
        ? { nativeRetainedIdleCheckpoint: { schema: "paperclip.native-retained-idle-checkpoint.v1", companyId, issueId, runId,
          sessionId: `pi:${runId}`, bootId: randomUUID(), generation: 1 } }
        : { nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1", companyId, issueId, runId,
          sessionId: `pi:${runId}`, clean: decision === "closed_clean", at: new Date().toISOString() } };
      await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || ${JSON.stringify(patch)}::jsonb` }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        failureCode: "native_retry_cancelled" }).onConflictDoNothing();
    };
    if (shape.order === "before") await writeDecision();
    // ORDER 2: the decision lands AFTER the boundary started (4f211436).
    const late = shape.order === "after" ? setTimeout(() => { void writeDecision(); }, 3_000) : null;

    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const t0 = Date.now();
    const outcome = await exportPersonStoppedWarmWorkspaceBeforeRelease({ db, environmentRuntime: {} as never, run: stopped });
    const elapsedMs = Date.now() - t0;
    if (late) clearTimeout(late);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, nativeIssueId: issueId, issueId,
      runtimeMode: "native", status: "queued", contextSnapshot: { issueId } });
    const sameBoxExcluded = await nativeWorkspaceExportPendingForResource(db, lease, successorRunId);
    const hold = await personStopExportPendingHoldsAdmission(db, { companyId, agentId, issueId });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const boxNotes = await fs.readFile(path.join(remoteCwd, "notes.md"));
    const hostNotes = await fs.readFile(path.join(hostCwd, "notes.md"));
    const result = { outcome, elapsedMs, after, lease, sameBoxExcluded, hold, events, boxNotes, hostNotes, edit,
      foregroundAlive: alive(foreground.pid), writerAlive: writer ? alive(writer.pid) : null };
    if (respawner) { try { process.kill(-respawner.pid!, "SIGKILL"); } catch { /* gone */ } }
    for (const child of [foreground, writer]) if (child && alive(child.pid)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
    return result;
  }

  function expectFinalizedOnSameBox(r: Awaited<ReturnType<typeof hardShape>>) {
    expect(r.outcome).toEqual({ outcome: "finalized" });
    expect(r.elapsedMs).toBeLessThan(CANCELLED_WARM_EXPORT_TIMEOUT_MS);
    expect(readNativeWorkspaceSyncReference(r.after.runnerProfileJson?.nativeWorkspaceSync)?.state).toBe("finalized");
    // The edit is on the host, sha-equal to the box; the turn's command is gone.
    expect(sha(r.hostNotes)).toBe(sha(r.boxNotes));
    expect(r.hostNotes.toString()).toContain(r.edit.trim());
    expect(r.foregroundAlive).toBe(false);
    // No 5-min hold; the same box passes the reuse filter for the successor.
    expect(r.hold).toBeNull();
    expect(r.sameBoxExcluded).toBe(false);
    expect(r.lease.status).toBe("active");
    expect(r.events.some(event => event.eventType === "workspace_export_finalized")).toBe(true);
    expect(r.events.some(event => event.eventType === "workspace_export_deferred")).toBe(false);
  }

  it("rf-4 (b): U's retained person-Stop releases stop_and_retain, so the release-site guard (run-control.ts :433) fires", () => {
    expect(providerResourceDispositionForTerminalRun("keep_running", "cancelled", "cancelled")).toBe("stop_and_retain");
    expect(providerResourceDispositionForTerminalRun(undefined, "cancelled", "cancelled")).toBeUndefined();
  });

  it("ORDER 1: the retained-idle receipt BEFORE the export decision -> finalized at once, same box, sha-equal", async () => {
    expectFinalizedOnSameBox(await hardShape({ order: "before" }));
  }, 60_000);

  it("ORDER 2: the receipt arrives AFTER the boundary (4f211436) -> the boundary waits within its bound, then finalizes", async () => {
    const r = await hardShape({ order: "after" });
    expectFinalizedOnSameBox(r);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(2_500);
  }, 60_000);

  it("escaped writer: killed and verified gone before the copy, so the host equals the box afterwards", async () => {
    const r = await hardShape({ order: "after", escapedWriter: true });
    expectFinalizedOnSameBox(r);
    expect(r.writerAlive).toBe(false);
    // It wrote until it was killed (so its lines are on the box), and nothing
    // after the copy: the host is sha-equal to the box (expectFinalizedOnSameBox).
    expect(r.boxNotes.toString()).toContain("late write");
  }, 60_000);

  it("closed + clean, the receipt after the boundary -> finalized", async () => {
    expectFinalizedOnSameBox(await hardShape({ order: "after", session: "closed_clean" }));
  }, 60_000);

  it("negative: closed + unclean -> refuses (tools_not_proven_stopped), no copy", async () => {
    const r = await hardShape({ order: "before", session: "closed_unclean" });
    expect(r.outcome).toEqual({ outcome: "unproven", reason: "tools_not_proven_stopped" });
    expect(r.hostNotes.toString()).toBe("host base\n");
  }, 60_000);

  it("negative: a process that keeps coming back -> unproven, the bounded behaviour", async () => {
    const r = await hardShape({ order: "before", respawner: true });
    expect(r.outcome).toEqual({ outcome: "unproven", reason: "tools_not_proven_stopped" });
    expect(r.hostNotes.toString()).toBe("host base\n");
    expect(r.hold).not.toBeNull();
  }, 60_000);

  it("negative: neither record within the bound -> unproven", async () => {
    const r = await hardShape({ order: "never" });
    expect(r.outcome).toEqual({ outcome: "unproven", reason: "tools_not_proven_stopped" });
    expect(r.elapsedMs).toBeLessThan(CANCELLED_WARM_EXPORT_TIMEOUT_MS + 2_000);
  }, 60_000);
});
