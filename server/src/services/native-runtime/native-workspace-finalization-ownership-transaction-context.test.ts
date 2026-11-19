import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { assertNoOpenTransaction, holdsOpenTransaction } from "@paperclipai/db/transaction-context";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";

// Keep reason: the dedicated advisory lock must not hide ordinary-pool transactions.
describe("native workspace finalization ownership transaction context", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  let runId: string;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_TX_NETWORK_GUARD", "throw");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-finalization-tx-guard-");
    db = createDb(temporary.connectionString, { maxConnections: 3 });
    await db.insert(companies).values({ id: companyId, name: "Finalization transaction guard", issuePrefix: "FTG" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Finalization agent",
      adapterType: "paperclip_runner", status: "running" });
  }, 30_000);

  beforeEach(async () => {
    const issueId = randomUUID();
    runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Finalize workspace",
      status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "succeeded" });
  });

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 1 });
    } finally {
      try { await temporary?.cleanup(); }
      finally { vi.unstubAllEnvs(); }
    }
  });

  it("allows a guarded runner call during advisory-lock-only ownership work", async () => {
    const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, async ownership => {
      assertNoOpenTransaction("runner:execute");
      expect(holdsOpenTransaction()).toBe(false);
      await ownership.assertHeld();
      return "copyback completed";
    });
    expect(result).toEqual({ acquired: true, value: "copyback completed" });
  });

  it("still rejects a guarded runner call in an ordinary-pool transaction inside ownership work", async () => {
    const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, async () => {
      await expect(db.transaction(async tx => {
        await tx.execute(sql`select 1`);
        expect(holdsOpenTransaction()).toBe(true);
        assertNoOpenTransaction("runner:execute");
      })).rejects.toThrow("network_call_in_db_transaction: runner:execute");
      return "ordinary transaction guarded";
    });
    expect(result).toEqual({ acquired: true, value: "ordinary transaction guarded" });
  });

  it("still counts an ordinary-pool savepoint inside ownership work", async () => {
    const result = await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, async () => {
      await db.transaction(async tx => {
        await expect(tx.transaction(async savepoint => {
          await savepoint.execute(sql`select 1`);
          expect(holdsOpenTransaction()).toBe(true);
          assertNoOpenTransaction("runner:execute");
        })).rejects.toThrow("network_call_in_db_transaction: runner:execute");
        // Rolling back the savepoint must not close its ordinary parent frame.
        expect(holdsOpenTransaction()).toBe(true);
        expect(() => assertNoOpenTransaction("runner:execute")).toThrow("network_call_in_db_transaction");
      });
      return "ordinary savepoint guarded";
    });
    expect(result).toEqual({ acquired: true, value: "ordinary savepoint guarded" });
  });
});
