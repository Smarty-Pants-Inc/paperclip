import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// KEEP: never-OK (adopt-stopu-compose6, rf-4 + RFL 00:10Z (c)). THE LATE EXPORT:
// after a person's Stop whose export is unproven at the bound, the message runs
// WITHOUT the files; the successor then EDITS the same file on the host; THEN the
// old box's export finishes. The successor's edit must SURVIVE on the host, and
// the old content must land aside with ONE true line. Only the provider turn and
// the box's target resolution (a local "box" dir, with a per-call delay) are
// scripted, as in xpaths-person-stop-release-export.test.ts. The successor's
// edit is written to the host by the test when its provider turn is reached (the
// scripted turn cannot run tools): that is the successor's committed edit.
const providerTurns = vi.hoisted(() => [] as string[]);
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    providerTurns.push(input.execution.binding.runId);
    throw new Error("late_export_successor_provider_turn_reached");
  }) as typeof actual.executePaperclipNativeSession };
});

const boxTargets = vi.hoisted(() => new Map<string, unknown>());
/** Per-call delays for the box's target resolution (the export's and the bound probe's). */
const boxDelays = vi.hoisted(() => new Map<string, number[]>());
const resolveCalls = vi.hoisted(() => [] as Array<{ leaseId: string; at: number; delay: number }>);
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async input => {
    if (!input.leaseId || !boxTargets.has(input.leaseId)) return actual.resolveEnvironmentExecutionTarget(input);
    const delay = boxDelays.get(input.leaseId)?.shift() ?? 0;
    resolveCalls.push({ leaseId: input.leaseId, at: Date.now(), delay });
    if (delay === Infinity) await new Promise(() => undefined);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return boxTargets.get(input.leaseId);
  }) as typeof actual.resolveEnvironmentExecutionTarget };
});

import { execFile } from "node:child_process";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference } from "../services/native-runtime/native-workspace-sync.js";
import { currentHostMutationDrain, type HostMutationDrain } from "@paperclipai/adapter-utils/host-mutation-drain";
import { finishCancelledWarmWorkspaceExport } from "../services/heartbeat/cancelled-warm-workspace-export.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { decidePersonStopExportAtBound, exportPersonStoppedWarmWorkspaceBeforeRelease } from "../services/heartbeat/person-stop-release-export.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { PERSON_STOP_EXPORT_BOUND_MS, readPersonStopBoundDecision } from "../services/heartbeat/person-stop-export-bound.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ASIDE_LINE = "The files from the stopped turn are now saved separately; your newer changes were kept.";

describe.skipIf(!support.supported)("adopt-stopu-compose6 (c): a late export of a person-stopped box never overwrites the without-files successor's edit", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("late-export-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "late-export-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "late-person", name: "Person", email: "late@example.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    if (home) await new Promise(resolve => execFile("chmod", ["-R", "u+w", home], resolve));
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  /** One armed delay for the box's next copyback command (not the bound's no-op
   * probe): the export has already chosen where to write, and the box answers late. */
  const commandDelay = { armedMs: 0, delayed: [] as string[] };
  let commandGate: { arrived: () => void; until: Promise<void> } | null = null;
  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => {
    if (commandGate && (input.args ?? []).join(" ").includes("workspace-download.tar")) {
      const gate = commandGate; commandGate = null; gate.arrived(); await gate.until;
    }
    if (commandDelay.armedMs && input.command !== "true") {
      const ms = commandDelay.armedMs; commandDelay.armedMs = 0;
      commandDelay.delayed.push(`${input.command} ${(input.args ?? []).join(" ")}`.slice(0, 200));
      await new Promise(resolve => setTimeout(resolve, ms));
    }
    return runOnBox(input);
  } };
  const runOnBox: CommandManagedRuntimeRunner["execute"] = async input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
    child.stdin?.end(input.stdin ?? "");
  });

  /** A person-stopped warm turn whose box holds the only copy of its edit to
   * notes.md; the release-site guard has deferred since `failingSince`. */
  async function stoppedBox(failingSince: number) {
    providerTurns.length = 0;
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const stoppedAt = new Date(failingSince - 30_000);
    const remoteCwd = path.join(home, `box-${runId}`);
    const hostCwd = path.join(home, `host-${runId}`);
    await fs.mkdir(remoteCwd); await fs.mkdir(hostCwd);
    await fs.writeFile(path.join(hostCwd, "notes.md"), "host base\n");
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Late export", issuePrefix,
      defaultResponsibleUserId: "late-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "late-person",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Late export ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "fake", image: "fixture:test", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue my chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "late-person", issueNumber: 1,
      identifier: `${issuePrefix}-1`, conversationAgentId: agentId, conversationUserId: "late-person",
      conversationState: "active", executionRunId: null, checkoutRunId: null });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", nativePhase: "terminal_failure", invocationSource: "on_demand",
      status: "cancelled", errorCode: "cancelled", error: "Cancelled by a board operator", nextEventSeq: 2,
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      controllerLeaseExpiresAt: new Date(stoppedAt.getTime() - 1),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running",
        nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1", companyId, issueId, runId,
          sessionId: null, clean: true, at: stoppedAt.toISOString() } },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "late-person", nativeCancellation: {
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
    // The stopped turn's tool edited the box; never exported.
    const oldContent = `OLD: the stopped turn's edit ${randomUUID()}\n`;
    await fs.writeFile(path.join(remoteCwd, "notes.md"), oldContent);
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "tool.execution.started", stream: "system" });
    // The release-site guard already deferred (export unproven) since failingSince.
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ releaseDeferral: {
      reason: "person_stop_export_unproven", retryAt: new Date().toISOString(), attempts: 1, triggers: [],
      failingSince: new Date(failingSince).toISOString(), attemptedByBootIds: [], providerResourceDisposition: "stop_and_retain" } })}::jsonb` })
      .where(eq(environmentLeases.id, leaseId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "late-person", body: "Please continue in notes.md." }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "late-person", payload: { issueId, commentId: comment.id },
      contextSnapshot: { issueId, commentId: comment.id, wakeReason: "issue_commented" } });
    const release = (trigger: string) => heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId,
      status: "cancelled", providerResourceDisposition: "keep_running", trigger }).catch(() => undefined);
    /** The successor's edit: written to the host when its turn is reached. */
    const successorEdits = new Map<string, string>();
    const pump = async () => {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      for (const turn of providerTurns) if (!successorEdits.has(turn)) {
        const edit = `NEW: the successor's edit ${turn} ${randomUUID()}\n`;
        await fs.writeFile(path.join(hostCwd, "notes.md"), edit);
        successorEdits.set(turn, edit);
      }
    };
    const evidence = async (label: string) => {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const asideEvents = events.filter(e => e.message === ASIDE_LINE);
      const asideDir = (asideEvents.find(e => e.eventType === "workspace_export_saved_aside")?.payload as { asideDir?: string } | null)?.asideDir ?? null;
      const value = { label, runId, leaseId, hostCwd, remoteCwd,
        host: await fs.readFile(path.join(hostCwd, "notes.md"), "utf8").catch(() => null),
        box: await fs.readFile(path.join(remoteCwd, "notes.md"), "utf8").catch(() => null),
        aside: asideDir ? await fs.readFile(path.join(asideDir, "notes.md"), "utf8").catch(() => null) : null,
        asideDir, asideLines: asideEvents.map(e => e.eventType), oldContent,
        successorEdits: Object.fromEntries(successorEdits), providerTurns: [...providerTurns],
        decision: readPersonStopBoundDecision(lease.metadata), leaseStatus: lease.status,
        reference: readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync)?.state ?? null,
        resolveCalls: resolveCalls.filter(c => c.leaseId === leaseId).map(c => ({ dt: c.at - failingSince, delay: c.delay })) };
      console.log("LATE_EXPORT_EVIDENCE", JSON.stringify(value));
      if (process.env.LATE_EXPORT_EVIDENCE_FILE) await fs.appendFile(process.env.LATE_EXPORT_EVIDENCE_FILE, `${JSON.stringify(value)}\n`);
      return value;
    };
    return { runId, leaseId, providerLeaseId, hostCwd, remoteCwd, oldContent, heartbeat, release, pump, evidence, successorEdits, prepared, target, companyId, agentId, issueId, workspaceId };
  }


  it("Q-A: finalized successful Stop has no real host mutations pending even though fresh-service admission precedes owner release", async () => {
    const f = await stoppedBox(Date.now() - 1000);
    let ownerEntered!: () => void; let finish!: () => void;
    const entered = new Promise<void>(r => ownerEntered = r), gate = new Promise<void>(r => finish = r);
    let finalized = false, drain: HostMutationDrain | undefined;
    const late: Array<{method: string; args: string[]}> = [];
    const spies: Array<{mockRestore(): void}> = [];
    for (const method of ["appendFile", "chmod", "copyFile", "cp", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "unlink", "writeFile"] as const) {
      const original = (fs[method] as (...args: any[])=>Promise<any>).bind(fs);
      spies.push(vi.spyOn(fs, method).mockImplementation((async (...args: any[]) => {
        if (finalized && currentHostMutationDrain() === drain) late.push({method, args: args.slice(0,2).map(String)});
        return original(...args);
      }) as never));
    }
    const work = withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId }, async ownership => {
      drain = ownership.hostMutations;
      await f.prepared!.restoreWorkspace(ownership.assertHeld, { signal: ownership.lost });
      finalized = true; ownerEntered(); await gate;
    });
    try {
      await entered;
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(readNativeWorkspaceSyncReference(before.runnerProfileJson?.nativeWorkspaceSync)?.state).toBe("finalized");
      expect(before.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeTruthy();
      const fresh = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
      await fresh.resumeQueuedRuns(); await fresh.drainActiveRunExecutions();
      const ownerStillHeld = !!(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerProfileJson?.nativeWorkspaceFinalizationOwner;
      const inFlightAtFinalize = drain!.inFlight;
      finish(); await work;
      const observed = { question: "Q-A", finalized: true, ownerStillHeld, admittedProviderTurns: [...providerTurns],
        realOldHostMutationsAfterFinalize: late, inFlightAtFinalize, artificialCleanupRegistered: false };
      await fs.writeFile(path.join(process.env.TASK_OUT!, "qa-admission-real-cleanup.json"), JSON.stringify(observed, null, 2));
      console.log("FVC8_QA_REAL_CLEANUP", JSON.stringify(observed));
      expect(providerTurns).toHaveLength(1);
      expect(late).toEqual([]);
    } finally { finish(); await work; for (const spy of spies.reverse()) spy.mockRestore(); }
  }, 120_000);

  it("Q-C: same_box retry that captured the old descriptor survives adoption and overwrites the successor's newer host edit", async () => {
    const f = await stoppedBox(Date.now() - PERSON_STOP_EXPORT_BOUND_MS - 1000);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const decision = await decidePersonStopExportAtBound({ db, environmentRuntime: {} as never, run });
    expect(decision?.decision).toBe("same_box");
    // Admission can race the release-site export immediately after its durable
    // decision because the prepared hold now skips this old lease entirely.
    await f.pump();
    expect(providerTurns).toHaveLength(1);
    let arrived!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => arrived = r), until = new Promise<void>(r => release = r);
    commandGate = { arrived, until };
    const retry = exportPersonStoppedWarmWorkspaceBeforeRelease({ db, environmentRuntime: {} as never, run });
    try {
      await entered;
      // This is a NEW export started after queue admission; same_box did
      // not fence it. Prepare the admitted successor on its same kept box.
      const successorId = providerTurns[0];
      expect(successorId).toBeTruthy();
      const [oldLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const [newLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: successorId,
        issueId: f.issueId, provider: "fake", providerLeaseId: f.providerLeaseId, status: "active",
        leasePolicy: "reuse_by_environment", metadata: oldLease.metadata }).returning();
      const successorSync = await prepareNativeWorkspaceSync({ db, runId: successorId, companyId: f.companyId,
        workspaceId: f.workspaceId, workspaceLocalDir: f.hostCwd, lease: newLease as unknown as EnvironmentLease,
        target: { ...f.target, leaseId: newLease.id, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: f.providerLeaseId } } });
      expect(successorSync?.mode).toBe("adopt_remote");
      const [adopted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(adopted.runnerProfileJson?.nativeWorkspaceSync).toBeUndefined();
      const newer = "NEW: actual same-box successor committed notes.md on host\n";
      await fs.writeFile(path.join(f.hostCwd, "notes.md"), newer);
      release();
      const outcome = await retry;
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const actual = await fs.readFile(path.join(f.hostCwd, "notes.md"), "utf8");
      const observed = { question: "Q-C", decision, successorId, adoptedOldReferenceRemoved: true, exportStartedAfterAdmission: true,
        successorMode: successorSync?.mode, newer, actual, old: f.oldContent, outcome,
        oldReferenceAfterRetry: readNativeWorkspaceSyncReference(after.runnerProfileJson?.nativeWorkspaceSync)?.state };
      await fs.writeFile(path.join(process.env.TASK_OUT!, "qc-samebox-retry.json"), JSON.stringify(observed, null, 2));
      console.log("FVC8_QC", JSON.stringify(observed));
      expect(actual).toBe(newer);
    } finally { release(); await retry; commandGate = null; await f.heartbeat.drainActiveRunExecutions(); }
  }, 120_000);
  it("supersedes(fvc8 Q-B bug-step assertions; RFL record SUPERSEDE-FVC8-QB-STEPS-1118) Q-B: after the lock loss, no decision and no admission until the old copyback owner joined; the successor's newer file survives", async () => {
    const f = await stoppedBox(Date.now() - PERSON_STOP_EXPORT_BOUND_MS - 1000);
    let arrived!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => arrived = r), held = new Promise<void>(r => release = r);
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(f.hostCwd, "notes.md")) { arrived(); await held; }
      return originalRename(from, to);
    });
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.prepared, timeoutMs: 1000, ...({ stoppedTurnBox: async () => ({ remoteCwd: f.remoteCwd, runner: { execute: async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "NONE scoped=1 killed=", stderr: "", pid: null, startedAt: null }) } }) } as {}) });
    try {
      await entered;
      expect(await work).toEqual({ outcome: "unproven", reason: "timed_out" });
      const locks = await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted and pid <> pg_backend_pid()`);
      expect(locks).toHaveLength(1);
      boxDelays.set(f.leaseId, [Infinity]);
      const [stillLocked] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const decisionBeforeLockLoss = await decidePersonStopExportAtBound({ db, environmentRuntime: {} as never, run: stillLocked, probeTimeoutMs: 25 });
      expect(decisionBeforeLockLoss).toBeNull();
      await db.execute(sql`select pg_terminate_backend(${Number(locks[0].pid)})`);
      boxDelays.set(f.leaseId, [Infinity]);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeTruthy();
      // Not vacuous: the export REACHED the host rename (the spy's record) BEFORE the lock-session kill above, and it is still pending.
      const renameReachedBeforeKill = spy.mock.calls.filter(([, to]) => String(to) === path.join(f.hostCwd, "notes.md")).length;
      const hostBeforeJoin = await fs.readFile(path.join(f.hostCwd, "notes.md"), "utf8");
      console.log("FVC8_QB_ORDER", JSON.stringify({ renameReachedBeforeKill, lockSessionKilled: Number(locks[0].pid), hostBeforeJoinIsOld: hostBeforeJoin === f.oldContent }));
      expect(renameReachedBeforeKill).toBe(1); expect(hostBeforeJoin).not.toBe(f.oldContent);
      const decision = await decidePersonStopExportAtBound({ db, environmentRuntime: {} as never, run, probeTimeoutMs: 25 });
      expect(decision).toBeNull(); // no join proof (owner record present, owner process alive), not at the cap
      await f.pump(); expect(providerTurns).toHaveLength(0); // no admission
      release(); // the old rename lands while nobody newer exists; the owner drains and joins
      const joinBy = Date.now() + 20000;
      while ((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerProfileJson?.nativeWorkspaceFinalizationOwner && Date.now() < joinBy) await new Promise(r => setTimeout(r, 20));
      const [joined] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(joined.runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeFalsy(); // the drain-complete record
      const decisionAfterJoin = await decidePersonStopExportAtBound({ db, environmentRuntime: {} as never, run: joined, probeTimeoutMs: 25 });
      await f.pump();
      const successor = providerTurns[0]; expect(successor).toBeTruthy();
      const newer = "NEW: successor wrote after the old copyback joined\n";
      await fs.writeFile(path.join(f.hostCwd, "notes.md"), newer);
      await new Promise(r => setTimeout(r, 500));
      console.log("FVC8_QB_JOINED", JSON.stringify({ decisionAfterJoin }));
      release();
      const end = Date.now() + 20000;
      while ((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerProfileJson?.nativeWorkspaceFinalizationOwner && Date.now()<end) await new Promise(r => setTimeout(r, 20));
      const actual = await fs.readFile(path.join(f.hostCwd, "notes.md"), "utf8");
      const observed = { question: "Q-B", decision, successor, newer, actual, old: f.oldContent, lockKilledWhileHostRenamePending: true, decisionBeforeLockLoss };
      await fs.writeFile(path.join(process.env.TASK_OUT!, "qb-lockloss-straggler.json"), JSON.stringify(observed, null, 2));
      console.log("FVC8_QB", JSON.stringify(observed));
      expect(actual).toBe(newer);
    } finally { release(); await work; spy.mockRestore(); await f.heartbeat.drainActiveRunExecutions(); }
  }, 120_000);

});
