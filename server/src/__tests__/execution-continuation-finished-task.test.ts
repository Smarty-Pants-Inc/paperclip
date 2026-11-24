import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents, companies, createDb, closeRegisteredClients, issues,
  startEmbeddedPostgresTestDatabase, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";

// These wakes contain no Retry intent. Avoid loading the unrelated retry runtime
// while exercising the real continuation builder and company-scoped DB lookup.
vi.mock("../services/task-retry.js", () => ({ readTaskRetryIntent: () => null }));
import { buildExecutionContinuation } from "../services/execution-continuation.js";

describe("finished-task conversation continuation admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("continuation-finished-task-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (database) {
      await closeRegisteredClients(database.connectionString);
      await database.cleanup();
    }
  });

  it.each([
    { name: "marked Done comment admitted", status: "done", mark: true, reason: "issue_commented", changedOwner: false, wrongCompany: false, admitted: true },
    { name: "unmarked Done comment rejected", status: "done", mark: undefined, reason: "issue_commented", changedOwner: false, wrongCompany: false, admitted: false },
    { name: "truthy non-boolean marker rejected", status: "done", mark: "true", reason: "issue_commented", changedOwner: false, wrongCompany: false, admitted: false },
    { name: "marked non-comment wake rejected", status: "done", mark: true, reason: "issue_assigned", changedOwner: false, wrongCompany: false, admitted: false },
    { name: "changed assignee rejected", status: "done", mark: true, reason: "issue_commented", changedOwner: true, wrongCompany: false, admitted: false },
    { name: "cancelled task rejected", status: "cancelled", mark: true, reason: "issue_commented", changedOwner: false, wrongCompany: false, admitted: false },
    { name: "wrong company rejected", status: "done", mark: true, reason: "issue_commented", changedOwner: false, wrongCompany: true, admitted: false },
  ])("$name", async scenario => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Continuation guard", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } });
    let assigneeAgentId = agentId;
    if (scenario.changedOwner) {
      assigneeAgentId = randomUUID();
      await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "New owner", role: "engineer", adapterType: "paperclip_runner" });
    }
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished task", status: scenario.status, assigneeAgentId });
    const continuation = buildExecutionContinuation({ db, companyId: scenario.wrongCompany ? randomUUID() : companyId,
      issueId, agentId, summary: null, exposeLowTrustRaw: false,
      context: { issueId, wakeReason: scenario.reason, ...(scenario.mark === undefined ? {} : { finishedTaskConversation: scenario.mark }) },
    });
    if (scenario.admitted) await expect(continuation).resolves.toBeDefined();
    else await expect(continuation).rejects.toMatchObject({ code: "continuation_task_ownership_changed" });
    const [task] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    expect(task!.status).toBe(scenario.status);
    expect(task!.assigneeAgentId).toBe(assigneeAgentId);
  });
});
