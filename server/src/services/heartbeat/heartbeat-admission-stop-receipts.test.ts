import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { agentRunSupersededByFreshContinuation } from "../../agent-run-cancellation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-process-start-events.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { fenceUnverifiedPredecessorsAtAdmission } from "./predecessor-admission.js";

const support = await getEmbeddedPostgresTestSupport();
// KEEP: guards admission authority against stale, forged and cross-generation
// stop receipts. Real PostgreSQL and the production admission transaction;
// assembled next-message execution is covered by the independent judge RED.
(support.supported ? describe : describe.skip)("admission stop receipt chronology", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("admission-stop-receipts-");
    db = createDb(database.connectionString, { maxConnections: 3 });
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission stop", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "codex_local", status: "idle" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const cases = [
    ["local later stop", false], ["local older stop", true], ["local equal-time stop", true],
    ["local later launch request", true], ["local later identity", true], ["local runner-authored stop", true],
    ["remote later released stop", false], ["remote later active stop", false], ["remote later destroy", false],
    ["remote older stop", true], ["remote equal-time stop", true], ["remote future stop", true],
    ["remote invalid time", true], ["remote missing time", true], ["remote other run", true],
    ["remote other company", true], ["remote other lease", true], ["remote other sandbox", true],
    ["remote later launch request", true], ["remote later identity", true], ["remote same-time launch", true],
    ["remote recovered stop", false], ["remote recovered older stop", true],
    ["remote pending cleanup", true], ["remote one unstopped lease", true], ["no receipt", true],
  ] as const;
  it.each(cases)("%s (fenced=%s)", async (shape, fenced) => {
    const start = Date.now() - 120_000, failureAt = new Date(start + 30_000), stoppedAt = new Date(start + 60_000);
    const [issue] = await db.insert(issues).values({ companyId, title: shape, status: "in_progress", assigneeAgentId: agentId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id,
      runtimeMode: "native", status: "failed", errorCode: "runner_process_termination_unconfirmed",
      createdAt: new Date(start), finishedAt: failureAt }).returning();
    const [candidate] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id,
      runtimeMode: "native", status: "running", createdAt: new Date() }).returning();
    const event = async (eventType: string, at: Date, sourceEventId?: string) => {
      const recorded = await appendHeartbeatRunEvent(db, { companyId, agentId, runId: source!.id, eventType });
      await db.update(heartbeatRunEvents).set({ createdAt: at, sourceEventId: sourceEventId ?? null })
        .where(eq(heartbeatRunEvents.id, recorded.row.id));
    };
    if (shape.startsWith("local")) {
      await event(PROCESS_START_REQUESTED, new Date(start));
      await event("native.local_process_stopped", shape.includes("older") ? new Date(start + 10_000)
        : shape.includes("equal-time") ? failureAt : stoppedAt, shape.includes("runner-authored") ? "forged" : undefined);
    }
    if (shape.startsWith("remote")) {
      await event(PROCESS_IDENTITY_RECORDED, new Date(start));
      const identity = { id: randomUUID(), companyId, heartbeatRunId: source!.id, provider: "boat", providerLeaseId: randomUUID() };
      const receipt = { ...remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId,
        state: shape.includes("destroy") ? "destroyed" : "stopped" })!, confirmedAt: stoppedAt.toISOString() };
      if (shape.includes("older")) receipt.confirmedAt = new Date(start + 10_000).toISOString();
      if (shape.includes("equal-time")) receipt.confirmedAt = failureAt.toISOString();
      if (shape.includes("future")) receipt.confirmedAt = new Date(Date.now() + 60_000).toISOString();
      if (shape.includes("invalid time")) receipt.confirmedAt = "invalid";
      if (shape.includes("missing time")) delete (receipt as Partial<typeof receipt>).confirmedAt;
      if (shape.includes("other run")) receipt.runId = randomUUID();
      if (shape.includes("other company")) receipt.companyId = randomUUID();
      if (shape.includes("other lease")) receipt.leaseId = randomUUID();
      if (shape.includes("other sandbox")) receipt.providerLeaseId = randomUUID();
      const active = shape.includes("active"), recovered = shape.includes("recovered");
      await db.insert(environmentLeases).values({ ...identity, acquiredAt: new Date(start),
        status: active ? "active" : recovered || shape.includes("pending cleanup") ? "pending_cleanup" : "released",
        releasedAt: active ? null : stoppedAt, cleanupStatus: active ? null : "success",
        metadata: recovered ? { workspaceRecoveryCleanup: { runId: source!.id, stopReceipt: receipt } }
          : { remoteExecutionTermination: receipt } });
      if (shape.includes("one unstopped")) await db.insert(environmentLeases).values({ ...identity, id: randomUUID(),
        providerLeaseId: randomUUID(), acquiredAt: new Date(start) });
    }
    if (shape.includes("later launch")) await event(PROCESS_START_REQUESTED, new Date(start + 90_000));
    if (shape.includes("later identity")) await event(PROCESS_IDENTITY_RECORDED, new Date(start + 90_000));
    if (shape.includes("same-time launch")) await event(PROCESS_START_REQUESTED, stoppedAt);
    const admitted = await fenceUnverifiedPredecessorsAtAdmission(db, candidate!);
    const [updated] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source!.id));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue!.id));
    expect(agentRunSupersededByFreshContinuation(updated)).toBe(fenced);
    expect(admitted.contextSnapshot?.forceFreshSession === true).toBe(fenced);
    expect(actions).toHaveLength(fenced ? 1 : 0);
    if (!fenced) expect(admitted.updatedAt).toEqual(candidate!.updatedAt);
  });
});
