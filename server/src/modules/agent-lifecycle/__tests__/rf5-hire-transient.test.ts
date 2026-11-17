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

(support.supported ? describe : describe.skip)("rf5 hire transient RED at rc3-c1", () => {
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

  function assertAutomaticDeadline(row: Awaited<ReturnType<typeof current>>, now: number, label: string) {
    expect.soft(row.lifecycleOperation?.retryRequired ?? false, `${label}: must not park`).toBe(false);
    expect.soft(row.lifecycleOperation?.verificationFailures ?? 0, `${label}: transient must not spend verificationFailures`).toBe(0);
    const retryAt = row.lifecycleOperation?.retryAt;
    expect.soft(retryAt, `${label}: must save retryAt`).toBeDefined();
    expect.soft(Date.parse(retryAt ?? ""), `${label}: ordinary-error retryAt is now + 60s`).toBe(now + MINUTE);
    expect.soft(row.lifecycleError ?? "", `${label}: diagnostic is secret-safe`).not.toContain(PRIVATE_DETAIL);
  }

  it("R1: three consecutive HOST transients retry at 60s without spending budget; fourth reaches ready without touch in five minutes", async () => {
    const errors = [
      hostError("test_environment_unavailable"),
      hostError("native_probe_cleanup_pending"),
      hostError("native_probe_cleanup_pending"),
    ];
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
      assertAutomaticDeadline(row, now, `failure ${failure + 1}`);
      // Honor the actual saved deadline even on RED (base backs off to 120s).
      // A parked base has no deadline: one more ordinary clock tick proves
      // process() cannot wake it; never remove retryRequired to force progress.
      const retryAt = Date.parse(row.lifecycleOperation?.retryAt ?? "");
      vi.setSystemTime(Number.isFinite(retryAt) ? retryAt : now + MINUTE);
    }
    await fixture.work.process(fixture.agent.id);
    expect.soft(attempts, "fourth automatic verification must run").toBe(4);
    expect.soft(await current(fixture.agent.id), "no POST /lifecycle/retry, configuration save, or repair").toMatchObject({
      lifecycleState: "ready", lifecycleError: null,
    });
    expect.soft(fixture.onReady, "normal ready handoff exactly once").toHaveBeenCalledOnce();
    expect.soft(Date.now() - startedAt, "unattended recovery within five simulated minutes").toBeLessThanOrEqual(5 * MINUTE);
  });

  // R2 acquisition site: server/src/services/agent-environment-test.ts:306
  // environmentRuntime.acquireRunLease; verifier resolves this target at
  // agent-harness-verification.ts:163 BEFORE withManagedAiProbe at :171 and
  // retained cleanup reconciliation in ai-connection-runtime.ts:306.
  // Do not count this injected driver's runHost calls as real box acquisitions.
  it.todo("R2: zero acquisitions while cleanup is pending, then exactly one per cleanup-admitted attempt — lifecycle driver exposes no probe acquisition/cleanup-proof seam; requires real probe integration, not a synthetic acquisition counter");

  it.each([
    { last: "harness_test_failed", reason: "The execution test did not pass" },
    { last: "harness_auth_failed", reason: "Authentication failed" },
    { last: "ai_connection_default_missing", reason: "personal default" },
  ])("R3: two genuine harness failures then $last still park at three with the true reason and no retryAt", async ({ last, reason }) => {
    const accountFailure = new HttpError(422, PRIVATE_DETAIL);
    recordAiConnectionConfigurationFailure(accountFailure, "ai_connection_default_missing");
    const errors = [hostError("harness_test_failed"), hostError("harness_test_failed"),
      last === "ai_connection_default_missing" ? accountFailure : hostError(last)];
    let attempts = 0;
    const fixture = await hire(async () => { throw errors[attempts++]; });
    for (let index = 0; index < 3; index++) {
      await fixture.work.process(fixture.agent.id);
      const row = await current(fixture.agent.id);
      expect(row.lifecycleOperation?.verificationFailures).toBe(index + 1);
      if (index < 2) {
        expect(row.lifecycleOperation?.retryRequired).not.toBe(true);
        const due = Date.parse(row.lifecycleOperation!.retryAt!);
        expect(due).toBeGreaterThan(Date.now());
        vi.setSystemTime(due);
      }
    }
    const parked = await current(fixture.agent.id);
    expect(parked.lifecycleOperation).toMatchObject({ verificationFailures: 3, retryRequired: true });
    expect(parked.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(parked.lifecycleError).toContain(reason);
    expect(parked.lifecycleError).toContain("Automatic verification is paused");
    expect(parked.lifecycleError).not.toContain(PRIVATE_DETAIL);
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    await fixture.work.process(fixture.agent.id);
    expect(attempts).toBe(3);
    expect(fixture.onReady).not.toHaveBeenCalled();
  });

  // R4 is RFL bar b's TEXT CONTRACT, not merely a retry-classification check:
  // no visible lifecycleError line before 10 min; at/after 10 min exactly one
  // line containing /retrying automatically/i; keep retrying; clear on success.
  it("R4: persistent outage stays quiet before ten minutes, then has one retrying automatically line, continues retrying and clears on success", async () => {
    let healthy = false;
    let attempts = 0;
    const fixture = await hire(async () => {
      attempts++;
      if (!healthy) throw hostError("native_probe_cleanup_pending");
    });
    const startedAt = Date.now();
    for (let minute = 0; minute <= 11; minute++) {
      vi.setSystemTime(startedAt + minute * MINUTE);
      const now = Date.now();
      await fixture.work.process(fixture.agent.id);
      const row = await current(fixture.agent.id);
      const lines = (row.lifecycleError ?? "").split(/\r?\n/).filter(line => line.trim());
      if (minute < 10) {
        expect.soft(lines, `minute ${minute}: no lifecycleError line before ten minutes`).toHaveLength(0);
      } else {
        expect.soft(lines, `minute ${minute}: exactly ONE persistent-outage line`).toHaveLength(1);
        expect.soft(lines.filter(line => /retrying automatically/i.test(line)),
          `minute ${minute}: missing 'retrying automatically' line`).toHaveLength(1);
      }
      assertAutomaticDeadline(row, now, `outage minute ${minute}`);
      expect.soft(attempts, `minute ${minute}: retries continue every minute`).toBe(minute + 1);
    }
    healthy = true;
    vi.setSystemTime(startedAt + 12 * MINUTE);
    await fixture.work.process(fixture.agent.id);
    expect.soft(attempts, "post-outage automatic attempt reaches host").toBe(13);
    expect.soft(await current(fixture.agent.id), "successful recovery clears persistent-outage line").toMatchObject({
      lifecycleState: "ready", lifecycleError: null,
    });
    expect.soft(fixture.onReady).toHaveBeenCalledOnce();
  });
});
