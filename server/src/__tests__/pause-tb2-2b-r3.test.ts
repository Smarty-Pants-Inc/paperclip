import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, authUsers, companyMemberships, createDb, environments, environmentLeases, heartbeatRuns, issueComments,
  issues, plugins,
} from "@paperclipai/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";
import { rf5CompletingPeer } from "./helpers/rf5-completing-peer.js";

// pl/pause-tb2-2b rows. Same real-HTTP shape as rf5-pu.test.ts: only the external
// native provider and the sandbox plugin call are controlled. Here the plugin's
// lease-teardown call is held until the row lets it fail, so the executor's own
// post-cancel teardown (heartbeat.ts executor finally, lease_release) is still
// running while the person's Pause is read, and its late end can be observed.
const seam = vi.hoisted(() => ({ factory: undefined as any }));
vi.mock("../services/heartbeat.js", async original => {
  const actual = await original<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (db: any, options: any = {}) =>
    actual.heartbeatService(db, { ...options, nativeSessionBackendFactory: (execution: any) => seam.factory(execution) }) };
});
// Round 3: observe the service's own executeRun (passed to its recovery
// module) so the row can really start a replacement executor of the same run.
const exec = vi.hoisted(() => ({ executeRun: undefined as undefined | ((runId: string, o?: any) => Promise<unknown>) }));
vi.mock("../services/heartbeat/recovery.js", async original => {
  const actual = await original<typeof import("../services/heartbeat/recovery.js")>();
  return { ...actual, createHeartbeatRecovery: (db: any, deps: any) => { exec.executeRun = deps.executeRun; return actual.createHeartbeatRecovery(db, deps); } };
});
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: () => {} }) }));
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { errorHandler } from "../middleware/index.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import * as authority from "../services/native-runtime/turn-authority-revocation.js";
import { turnAuthorityRevocation } from "../services/native-runtime/turn-authority-revocation.js";

const support = await getRecoveryPostgresSupport({});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bounded = async <T>(p: Promise<T>, ms: number) => {
  let t: any;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("bounded timeout")), ms); })]); }
  finally { clearTimeout(t); }
};
const ANSWER = "RF5 controlled provider answered";
// The ruled words (workspace-recovery-fallback.ts previousRunUnsavedFilesLine), copied here so the
// row goes red if the product line is removed or reworded.
const NOT_SAVED_LINE = "Paperclip could not save the previous run's unsaved files, so the task continues from the last saved version.";
/** Content hash of a workspace tree (relative paths + bytes); "absent" when it does not exist. */
function treeHash(root: string | null | undefined): string {
  if (!root || !existsSync(root)) return "absent";
  const h = createHash("sha256"); const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name); const st = statSync(full);
      if (st.isDirectory()) walk(full); else { h.update(relative(root, full) + "\0"); h.update(readFileSync(full)); h.update("\0"); }
    }
  };
  walk(root); return h.digest("hex");
}

describe.skipIf(!support.supported)("pause tB2 2b round 3: an older owner's late revoke never certifies a newer executor", () => {
  const fixture = nativeRestartFixture({});
  afterAll(async () => { await closeIdleWarmNativeSessionsForRestart(); });

  async function seed(opts: { interruptHeld?: boolean; interruptHung?: boolean; freshAfterRecovery?: boolean; unsavedEdit?: boolean } = {}) {
    const { companyId, temporary } = fixture.current; const db = createDb(temporary.connectionString);
    globalThis.process.env.TASK_OUT ??= globalThis.process.env.TMPDIR ?? "/tmp";
    const agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "2b board", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "2b Managed Pi", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "warm", idleTimeoutMs: 60000 }, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pause 2b truth", status: "in_progress", assigneeAgentId: agentId,
      responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    let holdNext = true, started = false; const stop = Promise.withResolvers<void>();
    // (c): the provider's interrupt does not return until the row lets it, so the DB cancel has not landed.
    const interruptGate = Promise.withResolvers<void>();
    if (!opts.interruptHeld && !opts.interruptHung) interruptGate.resolve();
    // C1: the runner is unreachable: interrupt NEVER returns (only the row's cleanup ends the turn).
    const hungInterrupt = new Promise<void>(() => {});
    const completing = rf5CompletingPeer(db);
    const cwds = new Map<string, string | null>();
    const starts: Array<{ runId: string; text: string; hash: string; cwd: string | null }> = [];
    let rUnsavedEdit: string | null = null;
    seam.factory = (execution: any) => {
      const cwd = execution.workspace?.cwd ?? null; cwds.set(execution.binding.runId, cwd);
      const backend0 = completing(execution);
      // Successors: record the provider's first input and the workspace it starts from.
      const backend = holdNext ? backend0 : { ...backend0, openSession: async (i: any) => {
        const s = await backend0.openSession(i); const orig = s.startTurn.bind(s);
        s.startTurn = async (t: any) => { starts.push({ runId: execution.binding.runId, text: JSON.stringify(t), hash: treeHash(cwd), cwd }); return orig(t); };
        return s; } };
      // (e): the provider cannot reattach the old turn's session, so it says so (the real
      // contract's { recovered: false }) instead of rf-5's peer throwing on recoverSession.
      if (!holdNext) return opts.freshAfterRecovery
        ? { ...backend, recoverSession: async () => ({ recovered: false, reason: "2b provider holds no earlier session" }) } : backend;
      holdNext = false;
      return { ...backend, openSession: async (input: any) => {
        const session = await backend.openSession(input);
        return { ...session,
          startTurn: async (i: any) => session.startTurn(i),
          async *events() {
            for await (const event of session.events()) {
              if (event.eventType === "turn.started") {
                // (ii): the live turn edits a file; its own teardown would save it, and that teardown is held.
                if (opts.unsavedEdit && cwd && existsSync(cwd)) { rUnsavedEdit = join(cwd, "r-unsaved-edit.txt"); writeFileSync(rUnsavedEdit, "R's unsaved change " + randomUUID()); }
                started = true; yield event; await stop.promise;
                yield { ...event, sourceSeq: 2, sourceEventId: event.sourceInstanceId + ":" + event.runId + ":2", eventType: "turn.completed" as const, payload: { status: "interrupted" } };
                return;
              }
            }
          },
          result: async () => null,
          interrupt: async () => { if (opts.interruptHung) return hungInterrupt; await interruptGate.promise; stop.resolve(); },
          close: async () => { stop.resolve(); await session.close({ reason: "test close" }); } };
      } };
    };
    const pluginKey = "paperclip.pu2b-" + pluginId.slice(0, 8);
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Held 2b box", description: "provider-only seam", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-boat", kind: "sandbox_provider", displayName: "Held 2b box", configSchema: { type: "object" } }] } } as never);
    await db.insert(environments).values({ id: environmentId, name: "2b held remote " + environmentId, driver: "sandbox", status: "active",
      config: { provider: "fake-boat", image: "fake:test", reuseLease: true } });
    // The box's teardown call is held; providerFails() lets every held and later call fail (a recorded release failure).
    const providerGate = Promise.withResolvers<never>();
    const providerCalls: string[] = [];
    const manager = { isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
      call: (_id: string, method: string, params: any) => { providerCalls.push(method + ":" + String(params?.providerLeaseId ?? "")); return providerGate.promise; } } as any;
    const providerFails = () => providerGate.reject(new Error("2b provider teardown failed"));
    void providerGate.promise.catch(() => undefined);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, { pluginWorkerManager: manager })); app.use("/api", issueRoutes(db, {} as any, { pluginWorkerManager: manager }));
    app.use("/api", issueTreeControlRoutes(db, { pluginWorkerManager: manager })); app.use(errorHandler);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
    const initial = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Start the live turn.", clientRequestId: randomUUID() });
    expect(initial.status, JSON.stringify(initial.body)).toBe(201);
    await waitForCondition("actual provider startTurn", () => started, 15000);
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    expect(run).toBeDefined();
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: run.id, issueId, status: "active", leasePolicy: "ephemeral",
      provider: "fake-boat", providerLeaseId: "pu2b-box-" + randomUUID(), metadata: { agentId, driver: "sandbox", pluginId, pluginKey,
        sandboxProviderPlugin: true, provider: "fake-boat", image: "fake:test", remoteCwd: "/workspace", sandboxState: "started" } });
    let pumping = false;
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => pumping);
    const due = () => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agentId));
    const get = async () => { const r = await request(app).get(`/api/agents/${agentId}`); expect(r.status).toBe(200); return r.body; };
    const pump = async () => { pumping = true; try { await due(); await bounded(worker.process(agentId), 3000).catch(() => {}); } finally { pumping = false; } };
    // True while the cancelled run's own executor is still in this process (liveRunExecutions).
    const tearingDown = async () => heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 1, intervalMs: 1 }).then(() => false, () => true);
    const otherRuns = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), ne(heartbeatRuns.id, run.id)));
    const agentComments = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "agent")));
    const runRow = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!;
    const leasesOf = async (runId: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    const stopTurn = () => stop.resolve();
    const cleanup = async () => {
      stop.resolve(); interruptGate.resolve(); providerFails();
      await bounded(worker.stop(), 2500).catch(() => {}); await bounded(heartbeat.drainActiveRunExecutions(), 5000).catch(() => {});
      await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    };
    return { db, app, companyId, agentId, issueId, run, heartbeat, get, process: pump, tearingDown, otherRuns, agentComments, runRow,
      providerFails, providerCalls, interruptGate, leasesOf, stopTurn, cleanup, cwds, starts, rUnsavedEdit: () => rUnsavedEdit };
  }

  it("(F1) a REAL replacement executor starts for the same run; the old owner's late revoke then arrives -> the new executor is NOT certified, Pause stays blocked on it", async () => {
    // C1 shape: the old session's interrupt never returns, so the Pause's cancelling owner
    // revokes only when the 2 s revocation bound fires; that is the late revoke.
    const f = await seed({ interruptHung: true }); let releaseReplacement = () => {}; try {
      // The replacement executor's provider startup is held so it stays the run's live owner.
      const replacementGate = new Promise<void>(r => { releaseReplacement = r; });
      const replacementOpens: string[] = [];
      const prior = seam.factory;
      seam.factory = (execution: any) => {
        const backend = prior(execution);
        return { ...backend, openSession: async (i: any) => { replacementOpens.push(execution.binding.runId); await replacementGate; return backend.openSession(i); } };
      };
      const before = turnAuthorityRevocation(f.run.id);
      // Observation only (absent before round 3): the run's current owner (epoch + generation).
      const owner = () => ((authority as any).captureTurnAuthority?.(f.run.id) ?? "n/a") as unknown;
      const ownerBefore = owner();
      const pauseAt = Date.now();
      const pausing = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}).then(r => r);
      await sleep(300);
      // Inside the bound: the old owner's interrupt is still in flight. Really start a
      // replacement executor of the SAME run through the service's own executeRun.
      expect(exec.executeRun, "service executeRun observed").toBeTypeOf("function");
      let replacementSettled: unknown = "running";
      const replacement = exec.executeRun!(f.run.id).then(v => { replacementSettled = { returned: v ?? null }; }, (e: unknown) => { replacementSettled = { threw: String(e) }; });
      const runAtReplacement = (await f.runRow()).status;
      await sleep(400);
      const replacementLive = await f.tearingDown();
      const ownerAtReplacement = owner(); const settledAtReplacement = replacementSettled;
      const response = await bounded(pausing, 10000);
      const revokedMs = Date.now() - pauseAt;
      // The old owner's late revoke has now arrived (the bound fired).
      const certificate = turnAuthorityRevocation(f.run.id);
      const atResponse = response.body?.lifecycleState ?? null;
      await f.process(); const after1 = await f.get();
      await sleep(1000); await f.process(); const after2 = await f.get();
      const certificateAfter = turnAuthorityRevocation(f.run.id);
      const run = await f.runRow();
      console.log("2B_R3_F1_TRUTH", JSON.stringify({ before, ownerBefore, ownerAtReplacement, settledAtReplacement, ownerAtResponse: owner(), replacementSettled, runAtReplacement, replacementLive, replacementOpens, revokedMs, responseStatus: response.status,
        atResponse, certificate, certificateAfter, after1: { state: after1.lifecycleState, pending: after1.lifecycleOperation?.pendingReason ?? null },
        after2: { state: after2.lifecycleState, pending: after2.lifecycleOperation?.pendingReason ?? null }, run: { status: run.status, errorCode: run.errorCode },
        stillExecuting: await f.tearingDown() }));
      expect(before).toBeNull();
      expect(runAtReplacement).toBe("running");
      expect(replacementLive).toBe(true);
      expect(revokedMs).toBeGreaterThanOrEqual(1500);
      // The new executor's turn is NOT treated as revoked by the old owner's late revoke.
      expect(certificate).toBeNull();
      expect(certificateAfter).toBeNull();
      // ...so Pause stays blocked on the new executor while it is live here.
      expect(await f.tearingDown()).toBe(true);
      expect(after1.lifecycleState).not.toBe("paused");
      expect(after2.lifecycleState).not.toBe("paused");
      releaseReplacement(); void replacement;
    } finally { releaseReplacement(); await f.cleanup(); }
  }, 60000);

  it("(F1b) exact owner, foreign run: a certificate for another run's captured owner never completes this run's pause", async () => {
    const f = await seed({ interruptHeld: true }); const foreign = randomUUID(); const epoch = authority.beginTurnAuthorityEpoch(foreign); try {
      authority.notePauseCancellation(foreign);
      const capture = (authority as any).captureTurnAuthority as undefined | ((id: string) => unknown);
      authority.revokeTurnAuthority(foreign, "session_cancel", ...(capture ? [capture(foreign) as any] : []) as []);
      expect(turnAuthorityRevocation(foreign)).not.toBeNull();
      await f.db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "agent_paused", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const pausing = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}).then(r => r);
      await sleep(800); await f.process(); const at1 = await f.get();
      console.log("2B_R3_FOREIGN_TRUTH", JSON.stringify({ at1: at1.lifecycleState, own: turnAuthorityRevocation(f.run.id) }));
      expect(turnAuthorityRevocation(f.run.id)).toBeNull(); expect(at1.lifecycleState).toBe("pausing");
      f.interruptGate.resolve(); await bounded(pausing, 10000).catch(() => undefined);
    } finally { authority.endTurnAuthorityEpoch(foreign, epoch); await f.cleanup(); }
  }, 60000);
});
