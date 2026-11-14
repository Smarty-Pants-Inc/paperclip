// RFL judge test (not builder code). Copy to server/src/__tests__/ on sl/sleepwake f1f12354 and run:
//   corepack pnpm exec vitest run src/__tests__/judge-sleepwake-gate.test.ts
// It drives the expiry gate with explicit timestamps (the "fake clock" is the `now`
// argument of stopWarmSandboxesPastWindow plus hand-set finishedAt/completedAt/closedAt).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nextWarmSandboxStopAt, stopWarmSandboxesPastWindow, warmSandboxWindowMetadata } from "../services/warm-sandbox-expiry.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

suite("JUDGE: native warm expiry gate", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", environmentId = "", issueId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-judge-sleepwake-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "JSW", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox", status: "active",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  }, 30_000);
  afterEach(async () => { await db.delete(issueRecoveryActions); await db.delete(environmentLeases); await db.delete(heartbeatRuns); });
  afterAll(async () => { await temporary?.cleanup(); });

  const row = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;

  /** T0 = turn finished. Offsets are ms relative to T0 (null = that event has not happened). */
  async function native(input: {
    stampAt?: number | null; closeAt?: number | null; closeState?: string; finishedAt?: number | null;
    stampLease?: string; closeLease?: string; closeRunId?: string; closeManifest?: string; closeSession?: string;
    providerLeaseId?: string; status?: string; expiresAtOffset?: number; releasedAgoMs?: number; closeExtra?: Record<string, unknown>;
  }) {
    const id = randomUUID(), runId = randomUUID(), now = Date.now();
    const T0 = now - 20 * MINUTE; // the last turn finished 20 min ago; the 5 min window is long over
    const providerLeaseId = input.providerLeaseId ?? `sandbox://fake/${id}`;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand",
      status: "succeeded", nextEventSeq: 1,
      ...(input.finishedAt === null ? {} : { finishedAt: new Date(T0 + (input.finishedAt ?? 0)) }) });
    const stamp = input.stampAt === null || input.stampAt === undefined ? undefined : {
      schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: "native-session", runnerInstanceId: "runner",
      sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: providerLeaseId,
      authorizedProviderLeaseId: input.stampLease ?? providerLeaseId, manifestSha256: SHA_B,
      completedAt: new Date(T0 + input.stampAt).toISOString() };
    const close = input.closeState === undefined && (input.closeAt === null || input.closeAt === undefined) ? undefined : {
      schema: "paperclip.native-warm-session-close.v1", state: input.closeState ?? "closed",
      ...(input.closeAt === null || input.closeAt === undefined ? {} : { closedAt: new Date(T0 + input.closeAt).toISOString() }),
      providerLeaseId: input.closeLease ?? providerLeaseId, runId: input.closeRunId ?? runId,
      normalizedSessionId: input.closeSession ?? "native-session", manifestSha256: input.closeManifest ?? SHA_B,
      ...(input.closeExtra ?? {}) };
    await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: input.status ?? "retained", cleanupStatus: "success", leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      acquiredAt: new Date(T0 - MINUTE), lastUsedAt: new Date(now - (input.releasedAgoMs ?? 20 * MINUTE)),
      ...(input.expiresAtOffset === undefined ? {} : { expiresAt: new Date(now + input.expiresAtOffset) }),
      metadata: { provider: "fake", reuseLease: true, ...warmSandboxWindowMetadata(5 * MINUTE),
        reusableSandboxLease: { adapterType: "paperclip_runner" },
        ...(stamp ? { nativeHarnessBackup: stamp } : {}), ...(close ? { warmNativeSessionClose: close } : {}) } });
    return { id, runId, providerLeaseId, T0 };
  }
  const stops = async () => (await stopWarmSandboxesPastWindow(db)).stopping;

  // ---- the two timers at every ordering: F (turn finished) < C (checkpoint stamp) < R (close receipt); E = expiry sweep
  it("E before C and R (only the turn finished): no stop", async () => {
    const l = await native({}); expect(await stops()).toBe(0); expect((await row(l.id)).status).toBe("retained");
  });
  it("E after C, before R (stamp current, no close receipt): no stop", async () => {
    const l = await native({ stampAt: 1000 }); expect(await stops()).toBe(0); expect((await row(l.id)).status).toBe("retained");
  });
  it.each(["closing", "retrying", "checkpointed", "failed"])("E while the close is %s: no stop", async (state) => {
    const l = await native({ stampAt: 1000, closeState: state, closeAt: state === "failed" ? null : 2000 });
    expect(await stops()).toBe(0); expect((await row(l.id)).status).toBe("retained");
  });
  it("E after C and R in order: stop (the only open ordering)", async () => {
    const l = await native({ stampAt: 1000, closeAt: 2000 }); expect(await stops()).toBe(1);
    expect((await row(l.id)).status).toBe("pending_cleanup");
  });
  it("R older than C (close receipt predates the stamp): no stop", async () => {
    await native({ stampAt: 2000, closeAt: 1000 }); expect(await stops()).toBe(0);
  });
  it("C older than F (stale stamp from an earlier turn) with a newer close receipt: no stop", async () => {
    await native({ stampAt: -1, closeAt: 2000 }); expect(await stops()).toBe(0);
  });
  it("C older than F by a long way, close receipt newer: no stop", async () => {
    await native({ stampAt: -30 * MINUTE, closeAt: 2000 }); expect(await stops()).toBe(0);
  });
  it("the run has no finished_at at all: no stop (fails closed)", async () => {
    await native({ stampAt: 1000, closeAt: 2000, finishedAt: null }); expect(await stops()).toBe(0);
  });
  it("boundary: C == F and R == C opens the gate (>=, not >)", async () => {
    await native({ stampAt: 0, closeAt: 0 }); expect(await stops()).toBe(1);
  });

  // ---- another lease / another run / another checkpoint
  it("stamp authorised for ANOTHER provider lease: no stop", async () => {
    await native({ stampAt: 1000, closeAt: 2000, stampLease: "sandbox://fake/other" }); expect(await stops()).toBe(0);
  });
  it("close receipt for ANOTHER provider lease: no stop", async () => {
    await native({ stampAt: 1000, closeAt: 2000, closeLease: "sandbox://fake/other" }); expect(await stops()).toBe(0);
  });
  it("close receipt for ANOTHER run: no stop", async () => {
    await native({ stampAt: 1000, closeAt: 2000, closeRunId: randomUUID() }); expect(await stops()).toBe(0);
  });
  it("close receipt bound to ANOTHER manifest / session: no stop", async () => {
    await native({ stampAt: 1000, closeAt: 2000, closeManifest: SHA_C }); expect(await stops()).toBe(0);
    await db.delete(environmentLeases); await db.delete(heartbeatRuns);
    await native({ stampAt: 1000, closeAt: 2000, closeSession: "other-session" }); expect(await stops()).toBe(0);
  });
  it("a LATER turn finished on the same box (older released chain row): the tip is not stopped on the old proof", async () => {
    // tip row: proof complete for its own run, but another (released) row of the same provider lease has a run that finished later
    const tip = await native({ stampAt: 1000, closeAt: 2000 });
    const laterRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterRun, companyId, agentId, issueId, invocationSource: "on_demand",
      status: "succeeded", nextEventSeq: 1, finishedAt: new Date(tip.T0 + 5000) });
    await db.insert(environmentLeases).values({ id: randomUUID(), companyId, environmentId, issueId, heartbeatRunId: laterRun,
      status: "released", cleanupStatus: "success", leasePolicy: "reuse_by_environment", provider: "fake",
      providerLeaseId: tip.providerLeaseId, acquiredAt: new Date(tip.T0), lastUsedAt: new Date(tip.T0 + 5000), metadata: {} });
    expect(await stops()).toBe(0);
  });

  // ---- backstop / liveness
  it("JUDGE FINDING: a failed close is never expiry-stopped, even past the lease expiresAt, and schedules no wake", async () => {
    const l = await native({ stampAt: 1000, closeState: "failed", closeExtra: { attempts: 3, warningCount: 1 }, expiresAtOffset: -MINUTE });
    expect(await stops()).toBe(0);
    expect((await row(l.id)).status).toBe("retained");
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });
  it("JUDGE FINDING: a native box with NO close receipt (server restarted before the in-process idle timer) is never expiry-stopped", async () => {
    const l = await native({ stampAt: 1000, releasedAgoMs: 35 * 60 * MINUTE });
    expect(await stops()).toBe(0);
    expect((await row(l.id)).status).toBe("retained");
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });
  it("JUDGE FINDING: a close stuck in 'closing' (process died mid-close) is never expiry-stopped", async () => {
    const l = await native({ stampAt: 1000, closeState: "closing", closeExtra: { attempts: 1 }, releasedAgoMs: 35 * 60 * MINUTE });
    expect(await stops()).toBe(0);
    expect((await row(l.id)).status).toBe("retained");
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });
  it("JUDGE FINDING: a receipt whose stamp carries a (skewed) later completedAt than finished_at opens the gate; ordering is by cross-clock timestamps only", async () => {
    // Same bytes as a stale stamp, but its runner-side completedAt reads later than the server's finished_at.
    await native({ stampAt: 500, closeAt: 2000 }); expect(await stops()).toBe(1);
  });
});
