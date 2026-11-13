import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  TRANSACTION_RETRY_ATTEMPTS,
  TransactionRetryInsideTransactionError,
  retryUnlessTransactionBound,
  transactionRetryStats,
  withTransactionRetry,
} from "./transaction-retry.js";

const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("withTransactionRetry never runs on a transaction-bound db", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("transaction-retry-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("refuses a transaction handle before any attempt, with a clear error", async () => {
    let attempts = 0;
    const countedBefore = transactionRetryStats.insideTransaction;
    const outcome = await db.transaction(async tx => withTransactionRetry(tx, async () => { attempts++; return "ran"; }))
      .then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(TransactionRetryInsideTransactionError);
    // smarty-dev#20455: the refusal is counted (and logged) so a production occurrence is visible.
    expect(transactionRetryStats.insideTransaction).toBe(countedBefore + 1);
    expect(String((outcome as Error).message)).toMatch(/transaction-bound db handle/);
    expect(attempts).toBe(0);
  });

  it("retryUnlessTransactionBound runs once inside a caller's transaction and retries on the pool db", async () => {
    let inside = 0;
    await expect(db.transaction(async tx => retryUnlessTransactionBound(tx, async () => { inside++; throw deadlock(); })))
      .rejects.toMatchObject({ code: "40P01" });
    expect(inside).toBe(1);
    let pooled = 0;
    await expect(retryUnlessTransactionBound(db, async attempt => { pooled++; if (attempt < 2) throw deadlock(); return "ok"; }))
      .resolves.toBe("ok");
    expect(pooled).toBe(2);
  });

  it("refuses a nested savepoint handle too", async () => {
    let attempts = 0;
    await expect(db.transaction(async tx => tx.transaction(async savepoint =>
      withTransactionRetry(savepoint, async () => { attempts++; }))))
      .rejects.toBeInstanceOf(TransactionRetryInsideTransactionError);
    expect(attempts).toBe(0);
  });

  it("retries a pool-level owner on 40P01 with a fresh transaction per attempt", async () => {
    const xids: number[] = [];
    const result = await withTransactionRetry(db, attempt => db.transaction(async tx => {
      const [row] = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`);
      xids.push(Number(row!.xid));
      if (attempt < TRANSACTION_RETRY_ATTEMPTS) throw deadlock();
      return attempt;
    }));
    expect(result).toBe(TRANSACTION_RETRY_ATTEMPTS);
    expect(new Set(xids).size).toBe(TRANSACTION_RETRY_ATTEMPTS);
  });
});
