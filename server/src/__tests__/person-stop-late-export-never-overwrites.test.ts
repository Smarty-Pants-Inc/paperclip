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

  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.end(input.stdin ?? "");
  }) };

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
    return { runId, leaseId, providerLeaseId, hostCwd, remoteCwd, oldContent, heartbeat, release, pump, evidence, successorEdits };
  }

  it("an export in flight across the bound finishes AFTER a without-files successor would have edited: the successor's edit survives", async () => {
    // Bound in 3 s. Export A starts before it; the box answers A only after 14 s.
    const f = await stoppedBox(Date.now() - PERSON_STOP_EXPORT_BOUND_MS + 3_000);
    boxDelays.set(f.leaseId, [14_000, Infinity]);
    const provider = getSandboxProvider("fake")!;
    const destroy = vi.spyOn(provider, "destroyLease");
    try {
      let aDone = false;
      const a = f.release("release_retry").then(() => { aDone = true; });
      await new Promise(resolve => setTimeout(resolve, 3_500));
      // B: the deferral retry AT the bound; the box does not answer its probe.
      const b = f.release("release_retry");
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        await f.pump();
        if (aDone && f.successorEdits.size > 0) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await Promise.race([Promise.all([a, b]), new Promise(resolve => setTimeout(resolve, 5_000))]);
      await f.pump();
      const ev = await f.evidence("in-flight export across the bound");
      expect(destroy.mock.calls.filter(([i]) => i.providerLeaseId === f.providerLeaseId)).toHaveLength(0);
      // Not vacuous: a successor ran and edited the host.
      expect(ev.providerTurns.length).toBeGreaterThan(0);
      // NEVER-OK: the old export did not write over the successor's edit.
      const lastEdit = [...f.successorEdits.values()].at(-1);
      expect(ev.host).toBe(lastEdit);
      // The stopped turn's edit is never lost: on the box, or on the host before the successor, or aside.
      expect(ev.box).toBe(ev.oldContent);
    } finally {
      await f.heartbeat.drainActiveRunExecutions();
      destroy.mockRestore();
    }
  }, 120_000);

  it("after the without-files decision, the box answers again and its export finishes: the successor's edit survives, the old content lands aside with ONE true line", async () => {
    // The bound has passed; the box does not answer the probe -> without_files.
    const f = await stoppedBox(Date.now() - PERSON_STOP_EXPORT_BOUND_MS - 1_000);
    boxDelays.set(f.leaseId, [Infinity]);
    await f.release("release_retry");
    const deadline = Date.now() + 20_000;
    while (f.successorEdits.size === 0 && Date.now() < deadline) {
      await f.pump();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const decided = await f.evidence("without-files successor ran and edited");
    expect(decided.decision).toMatchObject({ decision: "without_files" });
    expect(decided.providerTurns).toHaveLength(1);
    const successorEdit = [...f.successorEdits.values()][0]!;
    expect(decided.host).toBe(successorEdit);
    // THEN the old box answers and the deferral retry's export finishes.
    boxDelays.set(f.leaseId, [500]);
    await f.release("release_retry");
    await f.pump();
    const ev = await f.evidence("late export after the without-files successor's edit");
    // NEVER-OK: the successor's edit survives on the host.
    expect(ev.host).toBe(successorEdit);
    // The old content is saved separately, sha-equal, and the person reads ONE true line.
    expect(ev.asideDir).toBeTruthy();
    expect(path.resolve(ev.asideDir!).startsWith(path.resolve(f.hostCwd) + path.sep)).toBe(false);
    expect(ev.aside).toBe(ev.oldContent);
    expect(ev.asideLines.sort()).toEqual(["provider.notice.recorded", "workspace_export_saved_aside"]);
    expect(ev.box).toBe(ev.oldContent);
  }, 120_000);
});
