import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issues, projects, projectWorkspaces,
} from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// Keep reason: the chat task-creation incident exhausted the pool while its
// caller held a transaction. A single connection makes that self-deadlock
// deterministic without reproducing production load.
(support.supported ? describe : describe.skip)("services reuse the caller's transaction connection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-transaction-reader-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  async function withinDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Service did not resolve within 5000 ms on a one-connection pool")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Transaction reader", issuePrefix: `T${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Assignable worker", status: "idle" }).returning();
    return { companyId, agentId: agent.id };
  }

  it("creates an assigned issue in an existing transaction without borrowing from the pool", async () => {
    const { companyId, agentId } = await fixture();
    // Race inside the transaction so a timeout rolls it back and releases the
    // reserved connection; the failed regression must not hang fixture teardown.
    const created = await db.transaction(tx => withinDeadline(issueService(db).create(companyId, {
      title: "Task from a chat transaction", assigneeAgentId: agentId,
    }, tx)));
    expect(created).toMatchObject({ companyId, title: "Task from a chat transaction", assigneeAgentId: agentId });
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored).toMatchObject({ companyId, assigneeAgentId: agentId });
  });

  it("validates a configured workspace source using the supplied transaction reader", async () => {
    const { companyId, agentId } = await fixture();
    const [project] = await db.insert(projects).values({ companyId, name: "Configured project" }).returning();
    const [source] = await db.insert(projectWorkspaces).values({
      companyId, projectId: project.id, name: "Configured source", cwd: "/tmp/transaction-reader-source",
    }).returning();
    const selection = { kind: "configured_source" as const, projectWorkspaceId: source.id, mode: "shared" as const };
    const result = await db.transaction(tx => withinDeadline(executionWorkspaceService(db).validateSelection({
      companyId, projectId: project.id, assigneeAgentId: agentId, selection,
      actor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    }, tx)));
    expect(result).toEqual({
      executionWorkspaceId: null, projectWorkspaceId: source.id, executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });
  });

  it("creates a user-assigned issue in an existing transaction without borrowing from the pool", async () => {
    const { companyId } = await fixture();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member",
    });
    const created = await db.transaction(tx => withinDeadline(issueService(db).create(companyId, {
      title: "Human task from a chat transaction", assigneeUserId: userId,
    }, tx)));
    expect(created).toMatchObject({ companyId, title: "Human task from a chat transaction", assigneeUserId: userId });
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(stored).toMatchObject({ companyId, assigneeUserId: userId });
  });
});
