import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { executionProjectionsForRuns } from "./execution-projection.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("persisted stopped-workspace projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stopped-workspace-projection");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each([
    ["ai_connection_default_missing", "no_ai_connection", "No AI connection attached"],
    ["ai_connection_required", "ai_connection_unavailable", "AI connection needs attention"],
    ["harness_auth_failed", "authentication_failed", "AI authentication failed"],
    ["harness_model_unavailable", "model_unavailable", "Selected AI model unavailable"],
    ["harness_command_unavailable", "command_unavailable", "Agent execution command unavailable"],
    ["harness_cwd_invalid", "working_directory_unavailable", "Agent working directory unavailable"],
    ["test_environment_unavailable", "environment_unavailable", "Agent environment unavailable"],
    ["harness_test_failed", "verification_failed", "Agent verification failed"],
    ["private-internal-code", "setup_failed", "Agent setup failed"],
    ["__proto__", "setup_failed", "Agent setup failed"],
    [undefined, "setup_failed", "Agent setup failed"],
  ])("classifies persisted setup %s without exposing internal text, and clears it after readiness", async (failureCode, code, title) => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Setup wait", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner",
      status: "paused", lifecycleState: "verifying", lifecycleHolds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 1, retryRequired: true },
      lifecycleError: "private provider text must not leave setup" });
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ failureCode })}::jsonb` })
      .where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued" });
    const projected = (await executionProjectionsForRuns(db, companyId, [runId])).get(runId);
    expect(projected).toMatchObject({
      phase: "queued", label: "Agent setup needs attention", cause: "agent_setup_failed", canStop: true,
      setupFailure: { code, title }, nextAction: expect.any(String),
    });
    expect(JSON.stringify(projected)).not.toMatch(/private|__proto__/);
    await db.update(agents).set({
      lifecycleError: "Execution configuration check failed. The remote Runner is being updated.",
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 1,
        retryAt: new Date(Date.now() + 60_000).toISOString(), ...{ failureCode } },
    }).where(eq(agents.id, agentId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)).toMatchObject({
      phase: "queued", label: "Waiting for agent setup", cause: "agent_setup_pending",
      nextAction: "This turn starts automatically after the agent finishes setup and verification.",
    });
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)).not.toHaveProperty("setupFailure");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect((await executionProjectionsForRuns(db, randomUUID(), [runId])).size).toBe(0);
    await db.update(agents).set({ lifecycleState: "ready", status: "idle", lifecycleError: null }).where(eq(agents.id, agentId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)).toMatchObject({ label: "Queued", cause: null });
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)).not.toHaveProperty("setupFailure");
    // Historical or started work must not inherit a later setup failure.
    await db.update(agents).set({ lifecycleState: "verifying", status: "paused", lifecycleError: "safe failure" }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect((await executionProjectionsForRuns(db, companyId, [runId])).get(runId)?.label).toBe("Completed");
  });

});
