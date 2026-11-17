import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { setPluginEventBus } from "../activity-log.js";
import { createPluginEventBus } from "../plugin-event-bus.js";
import { deliverExecutionStatuses } from "../execution-status-delivery.js";
import { createHeartbeatLifecycle } from "../heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { nativeResultCommitWork } from "./native-result-commit-work.js";
import { nativeRunProjectionWork } from "./native-run-projection-work.js";

const support = await getEmbeddedPostgresTestSupport();
// Recorded catch: gate 5 GAT-143 / 03e3c903 finished natively without waking
// fleet-bridge until cron. Exercise real status transactions and the real bus;
// no provider process is needed to reproduce the host's missing publication.
describe.skipIf(!support.supported)("native terminal plugin events", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const bus = createPluginEventBus();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-plugin-events-");
    db = createDb(temporary.connectionString);
    setPluginEventBus(bus);
  });
  afterEach(() => bus.clearPlugin("fleet-bridge-test"));
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const contractSha256 = `contract-${contractId}`;
    await db.insert(companies).values({ id: companyId, name: "Native plugin events", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deliver the terminal event", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal", canonicalSha256: contractSha256,
      contractJson: { revision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
        objective: "Finish the work", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "running", nativeSessionId: sessionId, runnerInstanceId, completionContractId: contractId,
      completionContractSha256: contractSha256, contextSnapshot: { issueId }, startedAt: new Date() });
    const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId, runId, sessionId,
      completionContractId: contractId, completionContractSha256: contractSha256, sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "plugin-events-test" });
    await port.openRun({ identity: { companyId, agentId, issueId, runId, sessionId }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${runId}:result` });
    const events: PluginEvent[] = [];
    const committedStatuses: string[] = [];
    const pendingHandlers: Promise<void>[] = [];
    bus.forPlugin("fleet-bridge-test").subscribe("agent.run.finished", { companyId }, async event => {
      if (event.payload.runId !== runId) return;
      events.push(event);
      const pending = db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
        .then(([run]) => { committedStatuses.push(run.status); });
      pendingHandlers.push(pending);
      await pending;
    });
    const lifecycle = createHeartbeatLifecycle(db, {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() }, companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) }, treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async () => ({})),
      getAgentInvokability: vi.fn(async () => ({ invokable: true as const })), emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    });
    return { companyId, agentId, issueId, runId, events, committedStatuses, pendingHandlers, lifecycle };
  }

  it.each(["result_commit", "committed_projection", "live_heartbeat"] as const)(
    "publishes agent.run.finished exactly once when %s wins native completion", async winner => {
      const f = await fixture();
      const scope = { companyId: f.companyId, runId: f.runId };
      const commit = nativeResultCommitWork(db);
      const projection = nativeRunProjectionWork(db);
      if (winner === "result_commit") {
        await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: f.runId, phase: "workspace_finalize", status: "succeeded" });
        const entries = await commit.load(scope);
        expect(entries).toHaveLength(1);
        await commit.check(entries[0]);
      } else {
        await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded" });
        // Committing task disposition alone is not a terminal run transition.
        expect(f.events).toHaveLength(0);
        if (winner === "committed_projection") {
          const entries = await projection.load(scope);
          expect(entries).toHaveLength(1);
          // Two workers observing the same candidate must not double-publish.
          await Promise.all([projection.check(entries[0]), projection.check(entries[0])]);
        } else {
          expect((await f.lifecycle.setRunStatusIfRunning(f.runId, "succeeded", { finishedAt: new Date() })).updated).toBe(true);
        }
      }
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run).toMatchObject({ status: "succeeded", finishedAt: expect.any(Date) });
      // The late live completion must observe the existing terminal state, not
      // produce another event. Replays and retryable live broadcasts aren't new
      // lifecycle transitions either.
      expect((await f.lifecycle.setRunStatusIfRunning(f.runId, "succeeded", { finishedAt: new Date() })).updated).toBe(false);
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(await projection.load(scope)).toHaveLength(0);
      expect(await commit.load(scope)).toHaveLength(0);
      const publish = vi.fn();
      await expect(deliverExecutionStatuses(db, { publish, failpoint: () => { throw new Error("after publish"); } })).rejects.toThrow("after publish");
      await deliverExecutionStatuses(db, { publish });
      await Promise.all(f.pendingHandlers);
      expect(f.events).toHaveLength(1);
      expect(f.events[0]).toMatchObject({ eventType: "agent.run.finished", companyId: f.companyId,
        actorId: f.agentId, actorType: "agent", entityId: f.runId, entityType: "heartbeat_run",
        payload: { runId: f.runId, agentId: f.agentId, issueId: f.issueId, status: "succeeded",
          startedAt: run.startedAt!.toISOString(), finishedAt: run.finishedAt!.toISOString() } });
      expect(f.committedStatuses).toEqual(["succeeded"]);
    },
  );
});
