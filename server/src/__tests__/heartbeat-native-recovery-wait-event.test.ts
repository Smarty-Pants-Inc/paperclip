import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRunEvents,
  heartbeatRuns, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  NATIVE_RETAINED_OWNER_WAIT, RETAINED_OWNER_LEASE_WAIT_MESSAGE, STOPPED_RUN_TOOLS_WAIT_MESSAGE,
} from "../services/native-runtime/native-controller-recovery.js";

// Keep reason: S095 step 2. The real heartbeat writes the run event of a
// pre-claim recovery wait (heartbeat.ts, NativeSessionResumeScheduledError).
// Only the executor edge is scripted: it ends exactly as the S095 fence's
// deferral does at native-session-executor.ts executePaperclipNativeSession's
// catch (deferNativeControllerRecovery with the wait's words, then the typed
// NativeControllerRecoveryWaitingError). The per-state words themselves are
// pinned at that production entry by native-recovered-owner-followup.test.ts
// ("S095 rf-3: the deferral's failureDetail tells the truth").
const fixture = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const recovery = await import("../services/native-runtime/native-controller-recovery.js");
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const { heartbeatRuns } = await import("@paperclipai/db");
      await input.db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
        || '{"nativeExecutionInput":{}}'::jsonb` }).where(eq(heartbeatRuns.id, input.execution.binding.runId));
      const retryAt = new Date(Date.now() + 30_000);
      await recovery.deferNativeControllerRecovery(input.db, { ...input.execution.binding, leaseOwner: input.leaseOwner,
        retryAt, message: fixture.message });
      throw new recovery.NativeControllerRecoveryWaitingError(retryAt, undefined,
        fixture.message ? { message: fixture.message } : undefined);
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("S095 step 2: the recovery wait's run event", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-native-recovery-wait-event-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "native-recovery-wait-event-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible User",
      email: "responsible-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => {
      const stat = await fs.lstat(dir).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(dir, 0o700);
      for (const entry of await fs.readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
  });

  async function deferredRun(message: string | undefined) {
    fixture.message = message;
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "S095", issuePrefix,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/faux" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued", wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, responsibleUserId: "responsible-user", issueNumber: 1,
      identifier: `${issuePrefix}-1`, startedAt: new Date() });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatService(db, {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async id => {
        if (id !== runId) return;
        // The successor's Boat box.
        await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, provider: "boat",
          providerLeaseId: `bx_${runId.slice(0, 8)}`, status: "active", leasePolicy: "reuse_by_environment",
          metadata: { driver: "sandbox", remoteCwd: "/workspace" } });
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "observed" })
          .where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      },
    });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "lifecycle"), sql`${heartbeatRunEvents.payload}->>'retryReasonCode' = ${NATIVE_RETAINED_OWNER_WAIT}`));
    return { finalization, events };
  }

  it.each([
    ["no ACTIVE lease of the stopped run", STOPPED_RUN_TOOLS_WAIT_MESSAGE],
    ["the stopped run's lease still ACTIVE", RETAINED_OWNER_LEASE_WAIT_MESSAGE],
  ])("S095 step 2: with %s the run event and the failureDetail carry the wait's own words", async (_label, message) => {
    const { finalization, events } = await deferredRun(message);
    expect.soft(finalization).toMatchObject({ phase: "retryable_failure", attempt: 0, failureCode: NATIVE_RETAINED_OWNER_WAIT });
    expect.soft((finalization!.failureDetail as { message?: string }).message).toBe(message);
    expect(events.map(event => event.message)).toEqual([message]);
    expect((events[0]!.payload as { failureDetail?: { message?: string } }).failureDetail?.message).toBe(message);
  }, 60_000);

  it("S095 step 2: a retained-owner wait without words keeps today's run event", async () => {
    const { events } = await deferredRun(undefined);
    expect(events.map(event => event.message)).toEqual(["native continuation waiting for the retained controller lease"]);
  }, 60_000);
});
