import { randomUUID } from "node:crypto";
import {
  agents, companies, createDb, applyPendingMigrations, closeRegisteredClients, type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import {
  createAgentLifecycle, createAgentLifecycleEffects,
} from "../../../services/agent-lifecycle.js";
import { HttpError } from "../../../errors.js";
import { recordAiConnectionConfigurationFailure } from "../../../lib/ai-connection-configuration-failure.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleAgent } from "../application/ports.js";

// Agreed RED only: real hire + PostgreSQL store/worker, the same DB fixtures as
// verification-retry.test.ts. Inject only host outcomes, never retry policy.
// This is not evidence that a real provider/box recovered on a deployed image.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RF5_HIRE_TRANSIENT_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;
const PRIVATE_DETAIL = "private provider detail must not leave the failure boundary";
const hostError = (code: string) => code === "native_probe_cleanup_pending"
  // Preserve the actual 422 shape; do not also add a top-level code and mask
  // failure.ts's missing HttpError.details.code classification.
  ? new HttpError(422, PRIVATE_DETAIL, { code })
  : Object.assign(new Error(PRIVATE_DETAIL), { code });

(support.supported ? describe : describe.skip)("rf5 hire transient RED v2 (rf5 18:23Z + RFL 18:17Z)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    if (external) {
      await applyPendingMigrations(external);
      db = createDb(external, { maxConnections: 4 });
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-rf5-hire-transient-");
      db = createDb(database.connectionString, { maxConnections: 4 });
    }
  }, 90_000);
  afterAll(async () => {
    if (external) await closeRegisteredClients(external);
    else await database?.cleanup();
  });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "rf5 transient RED", issuePrefix: `T${companyId.slice(0, 7)}`,
    });
    // Fake Date only: SQL/network/lease-renewal timers remain real. Advancing
    // this clock naturally makes persisted retryAt due, with no row edits.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T12:00:00.000Z"));
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    vi.useRealTimers();
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" })
      .where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

  async function hire(verify: (agent: LifecycleAgent) => Promise<void>) {
    const runHost = vi.fn(async (agent: LifecycleAgent) => {
      if (agent.lifecycleState === "verifying") await verify(agent);
      return "complete" as const;
    });
    const onReady = vi.fn(async () => {});
    const reportFailure = vi.fn();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const work = createLifecycleWorker(store, {
      requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete", onReady,
    }, reportFailure);
    workers.push(work);
    const agent = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Unattended transient hire", adapterType: "process", adapterConfig: { command: process.execPath },
    });
    return { agent, work, store, runHost, onReady, reportFailure };
  }

  function assertAutomaticDeadline(row: Awaited<ReturnType<typeof current>>, now: number, delay: number, label: string) {
    expect.soft(row.lifecycleOperation?.retryRequired ?? false, `${label}: must not park`).toBe(false);
    expect.soft(row.lifecycleOperation?.verificationFailures ?? 0, `${label}: transient must not spend verificationFailures`).toBe(0);
    const retryAt = row.lifecycleOperation?.retryAt;
    expect.soft(retryAt, `${label}: must save retryAt`).toBeDefined();
    expect.soft(Date.parse(retryAt ?? "") - now, `${label}: retryAt delta must be ${delay / 1000}s`).toBe(delay);
    expect.soft(row.lifecycleError ?? "", `${label}: diagnostic is secret-safe`).not.toContain(PRIVATE_DETAIL);
  }

  it.each([
    {
      title: "supersedes(rf5-hire-transient R1; SUPERSEDE-RF5-HIRE-TRANSIENT-1117.md): three HOST transients back off 60/120/240s; fourth reaches ready without touch by minute eight",
      errors: [hostError("test_environment_unavailable"), hostError("native_probe_cleanup_pending"), hostError("native_probe_cleanup_pending")],
    },
    {
      title: "R1u: three UNCLASSIFIED HOST failures back off 60/120/240s; fourth reaches ready without touch by minute eight",
      // A plain Error deliberately has no recognized code. This reproduces the
      // recorded unclassified host class, without inventing a recognized code.
      errors: [new Error(PRIVATE_DETAIL), new Error(PRIVATE_DETAIL), new Error(PRIVATE_DETAIL)],
    },
  ])("$title", async ({ errors }) => {
    let attempts = 0;
    const fixture = await hire(async () => {
      const error = errors[attempts++];
      if (error) throw error;
    });
    const startedAt = Date.now();
    let operationId: string | undefined;
    for (let failure = 0; failure < errors.length; failure++) {
      const now = Date.now();
      await fixture.work.process(fixture.agent.id);
      const row = await current(fixture.agent.id);
      operationId ??= row.lifecycleOperation!.id;
      expect.soft(row.lifecycleOperation!.id, "same hire operation; no config save/Retry").toBe(operationId);
      expect.soft(attempts, `failure ${failure + 1} actually reached HOST`).toBe(failure + 1);
      assertAutomaticDeadline(row, now, MINUTE * 2 ** failure, `failure ${failure + 1}`);
      // Honor only persisted deadlines, even on RED. A parked row gets one
      // ordinary clock tick, never a row edit or explicit Retry to wake it.
      const retryAt = Date.parse(row.lifecycleOperation?.retryAt ?? "");
      vi.setSystemTime(Number.isFinite(retryAt) ? retryAt : now + MINUTE);
    }
    await fixture.work.process(fixture.agent.id);
    expect.soft(attempts, "fourth automatic verification must run").toBe(4);
    expect.soft(await current(fixture.agent.id), "no POST /lifecycle/retry, configuration save, or repair").toMatchObject({
      lifecycleState: "ready", lifecycleError: null,
    });
    expect.soft(fixture.onReady, "normal ready handoff exactly once").toHaveBeenCalledOnce();
    expect.soft(Date.now() - startedAt, "60 + 120 + 240s gives recovery at minute seven").toBe(7 * MINUTE);
    expect.soft(Date.now() - startedAt, "unattended recovery by simulated minute eight").toBeLessThanOrEqual(8 * MINUTE);
  });

  // R2 acquisition site: server/src/services/agent-environment-test.ts:306
  // environmentRuntime.acquireRunLease; verifier resolves this target at
  // agent-harness-verification.ts:163 BEFORE withManagedAiProbe at :171 and
  // retained cleanup reconciliation in ai-connection-runtime.ts:306.
  // Do not count this injected driver's runHost calls as real box acquisitions.
  // The builder's verification-retry.test.ts acquisition-seam test covers this;
  // this judge's injected runHost seam must not pretend to measure acquisitions.
  it.todo("R2: zero acquisitions while cleanup is pending, then exactly one per cleanup-admitted attempt — acquisition-seam coverage is in the builder's verification-retry.test.ts, not this injected lifecycle driver");

  it.each([
    { row: "R3a", code: "harness_test_failed", failures: 3, budgeted: true, reason: "The execution test did not pass" },
    { row: "R3b", code: "harness_auth_failed", failures: 1, budgeted: false, reason: "Authentication failed" },
    { row: "R3c", code: "ai_connection_default_missing", failures: 1, budgeted: false, reason: "personal default" },
  ])("supersedes(rf5-hire-transient R3; SUPERSEDE-RF5-HIRE-TRANSIENT-1117.md): $row $code parks after $failures failure(s), with the true reason and no retryAt", async ({ code, failures, budgeted, reason }) => {
    const accountFailure = new HttpError(422, PRIVATE_DETAIL);
    recordAiConnectionConfigurationFailure(accountFailure, "ai_connection_default_missing");
    let attempts = 0;
    const fixture = await hire(async () => {
      attempts++;
      throw code === "ai_connection_default_missing" ? accountFailure : hostError(code);
    });
    for (let index = 0; index < failures; index++) {
      await fixture.work.process(fixture.agent.id);
      const row = await current(fixture.agent.id);
      expect.soft(row.lifecycleOperation?.verificationFailures ?? 0,
        `${code}: only harness_test_failed spends verificationFailures`).toBe(budgeted ? index + 1 : 0);
      if (index < failures - 1) {
        expect(row.lifecycleOperation?.retryRequired).not.toBe(true);
        const due = Date.parse(row.lifecycleOperation!.retryAt!);
        expect(due).toBeGreaterThan(Date.now());
        vi.setSystemTime(due);
      }
    }
    const parked = await current(fixture.agent.id);
    expect.soft(attempts, "parking at exactly the required failure").toBe(failures);
    expect.soft(parked.lifecycleOperation?.retryRequired, "required manual repair parks immediately").toBe(true);
    expect.soft(parked.lifecycleOperation, "parked operations have no automatic deadline").not.toHaveProperty("retryAt");
    expect.soft(parked.lifecycleError, "park with the true failure reason").toContain(reason);
    expect.soft(parked.lifecycleError).toContain("Automatic verification is paused");
    expect.soft(parked.lifecycleError).not.toContain(PRIVATE_DETAIL);
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await fixture.work.process(fixture.agent.id);
    expect.soft(attempts, "clock alone cannot unpark a manual repair").toBe(failures);
    expect.soft(fixture.onReady).not.toHaveBeenCalled();
  });

  // R4 is RFL bar b's TEXT CONTRACT, not merely a retry-classification check:
  // no visible lifecycleError line before 10 min; at/after 10 min exactly one
  // line containing /retrying automatically/i; keep retrying; clear on success.
  it("supersedes(rf5-hire-transient R4; SUPERSEDE-RF5-HIRE-TRANSIENT-1117.md): continuous outage backs off for 60/120 minutes (8/12 attempts), has one line from minute ten, and clears on success", async () => {
    // Derive the schedule independently from the rule, not production policy:
    // 60, 120, 240, 480 seconds, then 900 seconds capped, from failure one.
    const expectedMinutes: number[] = [];
    let nextMinute = 0;
    for (let failure = 0; nextMinute <= 120; failure++) {
      expectedMinutes.push(nextMinute);
      nextMinute += Math.min(2 ** failure, 15);
    }
    expect(expectedMinutes.filter(minute => minute <= 60)).toEqual([0, 1, 3, 7, 15, 30, 45, 60]);
    expect(expectedMinutes).toEqual([0, 1, 3, 7, 15, 30, 45, 60, 75, 90, 105, 120]);
    let healthy = false;
    const attemptMinutes: number[] = [];
    const startedAt = Date.now();
    const fixture = await hire(async () => {
      attemptMinutes.push((Date.now() - startedAt) / MINUTE);
      if (!healthy) throw hostError("native_probe_cleanup_pending");
    });
    // Evaluate every minute, including minute ten BETWEEN the minute-seven and
    // minute-fifteen probes. Visibility must not be delayed to the next probe;
    // evaluating a row must also not bypass its persisted retryAt admission.
    for (let minute = 0; minute <= 120; minute++) {
      vi.setSystemTime(startedAt + minute * MINUTE);
      const previousAttempts = attemptMinutes.length;
      await fixture.work.process(fixture.agent.id);
      const row = await current(fixture.agent.id);
      const lines = (row.lifecycleError ?? "").split(/\r?\n/).filter(line => line.trim());
      if (minute < 10) {
        expect.soft(lines, `minute ${minute}: no lifecycleError line before ten minutes`).toHaveLength(0);
      } else {
        expect.soft(lines, `minute ${minute}: exactly ONE persistent-outage line`).toHaveLength(1);
        expect.soft(lines.filter(line => line.includes("retrying automatically")),
          `minute ${minute}: missing 'retrying automatically' line`).toHaveLength(1);
      }
      expect.soft(row.lifecycleOperation?.retryRequired ?? false, `minute ${minute}: must not park`).toBe(false);
      expect.soft(row.lifecycleOperation?.verificationFailures ?? 0, `minute ${minute}: transient must not spend verificationFailures`).toBe(0);
      expect.soft(row.lifecycleError ?? "", `minute ${minute}: diagnostic is secret-safe`).not.toContain(PRIVATE_DETAIL);
      expect.soft(attemptMinutes, `minute ${minute}: exact backoff admission, no early or missing attempts`)
        .toEqual(expectedMinutes.filter(time => time <= minute));
      if (attemptMinutes.length > previousAttempts) {
        assertAutomaticDeadline(row, Date.now(), Math.min(2 ** (attemptMinutes.length - 1), 15) * MINUTE, `outage minute ${minute}`);
      }
      if (minute === 60) {
        expect.soft(attemptMinutes, "first hour inclusive (0 through 60): exactly eight attempts").toHaveLength(8);
        expect.soft(attemptMinutes.length, "first hour attempts <= 10").toBeLessThanOrEqual(10);
      }
    }
    expect.soft(attemptMinutes, "two hours inclusive (0 through 120): exactly twelve attempts").toHaveLength(12);
    healthy = true;
    // The next capped deadline is minute 135. No Retry, config save or row edit.
    vi.setSystemTime(startedAt + nextMinute * MINUTE);
    await fixture.work.process(fixture.agent.id);
    expect.soft(attemptMinutes, "one automatic success after the two-hour outage").toEqual([...expectedMinutes, 135]);
    expect.soft(await current(fixture.agent.id), "successful recovery clears persistent-outage line").toMatchObject({
      lifecycleState: "ready", lifecycleError: null,
    });
    expect.soft(fixture.onReady).toHaveBeenCalledOnce();
  });
});
