import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { createPluginWorkerManager } from "./plugin-worker-manager.js";

// RED for ad056b15's shape: a DB transaction that awaits a provider/runner network call.
// The guard (packages/db/src/transaction-context.ts) must throw in tests (PAPERCLIP_TX_NETWORK_GUARD=throw).
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("no provider/Boat/runner call inside an open DB transaction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("tx-network-guard-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("runs in throw mode under the test setup", () => {
    expect(process.env.PAPERCLIP_TX_NETWORK_GUARD).toBe("throw");
  });

  it("refuses a provider RPC awaited inside a transaction (and inside a savepoint), not outside", async () => {
    const manager = createPluginWorkerManager();
    const call = () => manager.call("boat", "environmentExecute", {} as never);
    await expect(db.transaction(async () => { await call(); })).rejects.toThrow(/network_call_in_db_transaction: provider:environmentExecute/);
    await expect(db.transaction(tx => tx.transaction(async () => { await call(); }))).rejects.toThrow(/network_call_in_db_transaction/);
    // Outside any transaction the call proceeds (here: no worker registered).
    await expect(call()).rejects.toThrow(/No worker registered/);
    // Work only started inside a transaction is not counted once that transaction has ended.
    let later!: Promise<unknown>;
    await db.transaction(async () => { later = new Promise(resolve => setTimeout(resolve, 50)).then(call); });
    await expect(later).rejects.toThrow(/No worker registered/);
  });
});
