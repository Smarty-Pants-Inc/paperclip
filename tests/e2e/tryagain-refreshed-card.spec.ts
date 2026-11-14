import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "../../server/node_modules/drizzle-orm/index.js";
import { test, expect, type APIResponse } from "@playwright/test";
import {
  agentWakeupRequests, agents, closeRegisteredClients, createDb, environments,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations, workspaceOperations,
} from "../../packages/db/src/index.ts";
import { heartbeatService } from "../../server/src/services/heartbeat.js";
import { getExecutionBlocker } from "../../server/src/services/execution-blocker.js";
import { issueRecoveryActionService } from "../../server/src/services/issue-recovery-actions.js";
import { recoveryService } from "../../server/src/services/recovery/service.js";
import { preserveNativeFailedWorkspace } from "../../server/src/services/native-runtime/native-failed-workspace-recovery.js";
import { remoteTerminationReceipt } from "../../server/src/services/remote-execution-termination.js";
import { createSystemRecovery } from "../../server/src/services/system-recovery-state.js";
import { hasVerifiedWorkspaceRepair } from "../../server/src/services/workspace-recovery-receipt.js";
import { startTaskDrain, stopTaskDrain } from "../../server/src/services/task-admission.js";

// This captures the actual task page and API on the local Playwright instance.
// The inserted failed runs and recovery records use Paperclip's real DB writers;
// the fixture agent is disabled so no provider or external execution starts.
test.use({ video: "on" });

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test("refused A reload exposes current B and Try again queues one B continuation", async ({ page, request }, info) => {
  test.setTimeout(240_000);
  const artifactDir = process.env.TASK_OUT ?? info.outputDir;
  await mkdir(artifactDir, { recursive: true });
  const video = page.video();
  const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
  const dbUrl = config.database.mode === "postgres"
    ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${(await readFile(
      path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8",
    )).split("\n")[3]}/paperclip`;
  const db = createDb(dbUrl);
  let dbClosed = false;
  const closeDb = async () => {
    if (dbClosed) return;
    dbClosed = true;
    await closeRegisteredClients(dbUrl);
  };

  await json(await request.patch("/api/instance/settings/experimental", {
    data: { enableAgentChat: true, enableClassicTaskInterface: false },
  }));
  const company = await json(await request.post("/api/companies", {
    data: { name: `Try again browser proof ${Date.now()}` },
  }));
  // Seed an idle agent directly: the browser proof must not launch a provider
  // or invoke agent lifecycle verification as a side effect of fixture setup.
  const agentId = randomUUID();
  const [agent] = await db.insert(agents).values({
    id: agentId,
    companyId: company.id,
    name: "Disabled recovery fixture",
    role: "engineer",
    status: "idle",
    lifecycleState: "ready",
    adapterType: "paperclip_runner",
    adapterConfig: {
      provider: "codex",
      model: "gpt-5.1-codex-mini",
      instructionsBundleMode: "managed",
      instructionsEntryFile: "AGENTS.md",
    },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
  }).returning();
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: {
      title: "Try again should use the refreshed run",
      description: "A stale recovery card must refresh to the current run before retrying.",
      status: "todo",
    },
  }));

  const issueRow = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
  const runRows = async () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id));
  const wakeRows = async () => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, company.id), eq(agentWakeupRequests.agentId, agent.id),
  ));
  const clickRetry = async (expectedSourceRunId: string, expectedStatus: number) => {
    await page.getByTestId("recovery-action-resolve-trigger").click();
    const item = page.getByText("Try again", { exact: true }).last();
    await expect(item).toBeVisible();
    const responsePromise = page.waitForResponse(response => {
      const req = response.request();
      return req.method() === "POST" && new URL(response.url()).pathname.endsWith("/recovery-actions/resolve")
        && req.postDataJSON()?.actionId === boardAction.id
        && req.postDataJSON()?.sourceRunId === expectedSourceRunId;
    });
    await item.click();
    const response = await responsePromise;
    expect(response.status()).toBe(expectedStatus);
    expect(response.request().postDataJSON()).toMatchObject({ actionId: boardAction.id, sourceRunId: expectedSourceRunId,
      outcome: "restored", sourceIssueStatus: "todo" });
    return response;
  };

  let boardAction: any;
  let sourceA = "";
  let sourceB = "";
  let flowCompleted = false;
  try {
    // Assign only after creation so the API never admits a fixture agent run.
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: agent.id,
      conversationAgentId: agent.id,
      conversationUserId: "local-board",
      conversationState: "active",
    }).where(eq(issues.id, issue.id));
    const now = Date.now();
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorUserId: "local-board",
      authorType: "user",
      conversationSessionGeneration: 0,
      body: "A saved chat message before the interrupted attempt.",
      createdAt: new Date(now - 20_000),
      updatedAt: new Date(now - 20_000),
    });
    const [createdA] = await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id,
      runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      errorCode: "adapter_failed", error: "Seeded terminal failure before workspace export",
      startedAt: new Date(now - 10_000), finishedAt: new Date(now - 1_000), updatedAt: new Date(now - 1_000),
    }).returning();
    sourceA = createdA!.id;
    await db.insert(nativeRunFinalizations).values({ companyId: company.id, issueId: issue.id, runId: sourceA, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: `Try again ${sourceA}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({
      companyId: company.id, issueId: issue.id, heartbeatRunId: sourceA, environmentId: environment!.id,
      provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
    }).returning();
    const reference = {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: sourceA,
      leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
    };
    const [failedA] = await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: reference } })
      .where(eq(heartbeatRuns.id, sourceA)).returning();
    const retainedA = await preserveNativeFailedWorkspace(db, failedA!);
    expect(retainedA?.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease!.id] } });
    const [systemHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(systemHold).toBeDefined();
    await db.update(issueRecoveryActions).set({ ownerType: "system" }).where(eq(issueRecoveryActions.id, systemHold!.id));
    await recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup }).escalateStrandedAssignedIssue({
      issue: await issueRow(), previousStatus: "in_progress", latestRun: retainedA!,
    });
    boardAction = (await issueRecoveryActionService(db).getActiveForIssue(company.id, issue.id))!;
    expect(boardAction).toMatchObject({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" });
    // The board recovery card hands the task back to its assignee. Keep the real
    // chat task at the canonical todo state so Try again remains Task Retry.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issue.id));

    // Load the real issue page while its card still points at A.
    const initial = await json(await request.get(`/api/issues/${issue.id}`));
    expect(initial.activeRecoveryAction.evidence.latestRunId).toBe(sourceA);
    await writeFile(path.join(artifactDir, "browser-debug-initial.json"), JSON.stringify({
      interruption: initial.interruption,
      activeRecoveryAction: initial.activeRecoveryAction,
      executionBlocker: await getExecutionBlocker(db, company.id, issue.id),
      issue: await issueRow(),
      agent: (await db.select().from(agents).where(eq(agents.id, agent.id)))[0],
    }, null, 2));
    expect(initial.interruption?.responsibility).toBe("system");
    await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
    await expect(page.getByTestId("recovery-action-resolve-trigger")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(artifactDir, "screenshot-1-old-card.png"), fullPage: true });
    expect((await json(await request.get(`/api/issues/${issue.id}`))).activeRecoveryAction.evidence.latestRunId).toBe(sourceA);

    // B arrives after this page render. Clicking A now gets the real server's 409;
    // the mutation invalidates the page query and reloads the same durable card at B.
    const bAt = new Date();
    const [createdB] = await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id,
      retryOfRunId: sourceA, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      contextSnapshot: { issueId: issue.id }, errorCode: "adapter_failed",
      startedAt: new Date(now - 500), finishedAt: bAt, createdAt: bAt,
    }).returning();
    sourceB = createdB!.id;
    // Establish the durable result of the first stale-source refusal on the
    // real recovery owner. The already-rendered browser still has A, so its
    // source-bound click must be refused; the normal GET below exposes B.
    const refusal = await issueRecoveryActionService(db).recordTaskRetrySourceRefusal({
      companyId: company.id, sourceIssueId: issue.id, recoveryActionId: boardAction.id,
      sourceRunId: sourceA, currentRunId: sourceB,
    });
    expect(refusal).toMatchObject({ schema: "paperclip.task-retry-source-refusal.v1",
      recoveryActionId: boardAction.id, sourceRunId: sourceA, currentRunId: sourceB });
    await recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup }).refreshStrandedAssignedIssueRecoveryProjection({
      companyId: company.id, issueId: issue.id, recoveryActionId: boardAction.id,
      sourceRunId: sourceA, currentRunId: sourceB,
    });
    await clickRetry(sourceA, 409);
    await page.reload();
    await expect(page.locator('[data-testid="task-retry-source-refusal"]')).toContainText(
      "The earlier Try again request named a run that was no longer current.", { timeout: 30_000 },
    );
    await expect.poll(async () => {
      const current = await json(await request.get(`/api/issues/${issue.id}`));
      return current.activeRecoveryAction?.evidence.latestRunId;
    }, { timeout: 15_000 }).toBe(sourceB);
    await expect(page.getByTestId("recovery-action-resolve-trigger")).toBeVisible();
    await page.screenshot({ path: path.join(artifactDir, "screenshot-2-refreshed-card-B.png"), fullPage: true });

    // The refreshed card click is still the source-bound Retry. A remains held,
    // so the real server records one deferred B intent instead of bypassing it.
    await clickRetry(sourceB, 200);
    const retryRows = (await wakeRows()).filter(row => row.reason === "task_retry"
      && (row.payload as Record<string, any> | null)?.issueId === issue.id);
    expect(retryRows).toHaveLength(1);
    expect((retryRows[0]!.payload as any).taskRetry.sourceRunId).toBe(sourceB);

    // Reproduce a safe, verified recovery of A and a no-provider B setup failure;
    // then ask the canonical owner to resume exactly the single accepted request.
    const sync = reference as Record<string, any>;
    const [repairedA] = await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...(failedA!.runnerProfileJson as Record<string, any>), nativeWorkspaceSync: { ...sync, state: "finalized", finalHostSha256: "c".repeat(64) },
    } }).where(eq(heartbeatRuns.id, sourceA)).returning();
    const [operation] = await db.insert(workspaceOperations).values({
      companyId: company.id, issueId: issue.id, heartbeatRunId: sourceA, phase: "workspace_recovery", status: "succeeded",
      finishedAt: new Date(), metadata: { recoveryActionId: systemHold!.id, leaseId: lease!.id,
        providerLeaseId: lease!.providerLeaseId, descriptorSha256: sync.descriptorSha256, finalHostSha256: "c".repeat(64) },
    }).returning();
    const generation = { ...createSystemRecovery(sourceA), state: "complete", phase: "reconcile_effects",
      attempts: 2, retriesUsed: 1, preservationOperationIds: [operation!.id] };
    await db.update(issueRecoveryActions).set({ evidence: { ...systemHold!.evidence,
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: sourceA, status: "recovered",
        stage: "saving_receipts", attempt: 1, requestIds: [] }, systemRecovery: generation,
    } }).where(eq(issueRecoveryActions.id, systemHold!.id));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...(lease!.metadata as Record<string, unknown>), pendingCleanupInFlight: false,
        remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }) },
    }).where(eq(environmentLeases.id, lease!.id));
    expect(await hasVerifiedWorkspaceRepair(db, repairedA!)).toBe(true);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, nativePhase: null,
      executionStage: "preparing", errorCode: "setup_failed",
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, sourceB));
    // Keep the actual browser server in worktree admission-suppressed mode and
    // hold this test process's dispatch during resume. The durable continuation
    // stays queued for the visible proof; no fixture provider/CLI is launched.
    const drain = startTaskDrain({ ttlMs: 30_000 });
    try {
      const actorId = "local-board";
      await heartbeatService(db).wakeup(agent.id, {
        source: "on_demand", triggerDetail: "manual", reason: "task_retry",
        requestedByActorType: "user", requestedByActorId: actorId,
        taskRetryRequestId: retryRows[0]!.id, payload: { issueId: issue.id },
        contextSnapshot: { issueId: issue.id, triggeredBy: "board", actorId, responsibleUserId: actorId },
        issueStateGuard: { assigneeAgentId: agent.id, statuses: ["todo", "in_progress", "in_review", "blocked"] },
        idempotencyKey: `task-retry-dispatch:${retryRows[0]!.id}`,
      }, retryRows[0]!.id);
    }
    finally {
      stopTaskDrain();
      expect(drain.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
    const continuations = (await runRows()).filter(row => row.contextSnapshot?.taskRetryRequestId === retryRows[0]!.id);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ status: "queued", contextSnapshot: {
      previousRunId: sourceB, taskRetryRequestId: retryRows[0]!.id,
    } });
    await page.reload();
    await expect(page.getByTestId("task-chat-live-transcript")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(artifactDir, "screenshot-3-B-continuation.png"), fullPage: true });
    await writeFile(path.join(artifactDir, "video-evidence.json"), JSON.stringify({
      issueId: issue.id, actionId: boardAction.id, sourceA, sourceB, acceptedRetryRequestId: retryRows[0]!.id,
      continuations: continuations.map(row => ({ id: row.id, status: row.status, previousRunId: row.contextSnapshot?.previousRunId })),
      browser: "Playwright Chromium", localServer: "tests/e2e/playwright.config.ts webServer", video: "video.webm",
    }, null, 2));
    flowCompleted = true;
  } finally {
    await closeDb();
    await page.context().close();
    if (video) {
      try {
        await video.saveAs(path.join(artifactDir, "video.webm"));
        await info.attach("tryagain-video", { path: path.join(artifactDir, "video.webm"), contentType: "video/webm" });
      } catch (error) {
        await writeFile(path.join(artifactDir, "video-save-error.txt"), String(error));
        if (flowCompleted) throw error;
      }
    }
  }
});
