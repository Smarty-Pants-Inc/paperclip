import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("legacy execution terminalization lock contention", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-terminalization-locks-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  // Keep: real catch paperclipai/paperclip#16417 / smarty-dev#20094 (LAB2
  // 6c48006c). A child FK lock must not turn completed work into adapter_failed
  // with failureCause 55P03. Exercise PostgreSQL, not mocked lock call counts.
  it.each(["run", "issue", "child foreign keys"] as const)(
    "preserves successful work while another connection holds %s key-share locks",
    async (lockedRow) => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Terminalization contention", issuePrefix: companyId.slice(0, 8) });
      await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "codex_local" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Completed work", status: "done", assigneeAgentId: agentId });
      const resultJson = { outcome: "SUCCEEDED", stdout: "Work completed before terminalization" };
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, runtimeMode: "legacy", status: "running",
        contextSnapshot: { issueId }, resultJson,
      }).returning();

      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('idle_in_transaction_session_timeout', '15000', true)`);
        if (lockedRow === "child foreign keys") {
          // PostgreSQL takes FOR KEY SHARE on both parents for this real FK insert.
          await tx.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: run.id, phase: "worktree_cleanup" });
        } else if (lockedRow === "run") {
          await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("key share");
        } else {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("key share");
        }
        markLocked();
        await released;
      });

      try {
        // Do not release the other connection until terminalization has settled.
        // The baseline's transaction-local 1000ms lock_timeout raises 55P03 here.
        await Promise.race([locked, holder]);
        await expect(terminalizeLegacyExecution({ db, run, status: "succeeded", reconcileIfNeeded: true,
          patch: { finishedAt: new Date(), exitCode: 0, error: null, errorCode: null, resultJson },
        })).resolves.toMatchObject({ id: run.id, status: "succeeded", exitCode: 0, errorCode: null, resultJson });
      } finally {
        release();
        await holder;
      }

      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(saved).toMatchObject({ status: "succeeded", error: null, errorCode: null, resultJson });
      expect(saved.resultJson).not.toHaveProperty("failureCause");
      expect(saved.errorCode).not.toBe("adapter_failed");
      if (lockedRow === "child foreign keys") {
        expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, run.id))).toHaveLength(1);
      }
    },
  );
});
