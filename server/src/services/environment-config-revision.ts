import type { Db } from "@paperclipai/db";
import { databaseWorkScopeKey, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db/work-signals";

const topic = "environment-config-revision";
const revisions = new WeakMap<object, { value: number }>();

/** One in-memory revision per DB owner, shared by its transaction/child pools.
 * Definitions are instance-wide. Intent AND settlement invalidate: a read
 * during an open transaction must not remain cached after its outer commit.
 * The existing deployment notification bridge also invalidates on reconnect.
 */
export async function environmentConfigRevision(db: object): Promise<number> {
  const owner = databaseWorkScopeKey(db);
  let revision = revisions.get(owner);
  if (!revision) {
    revision = { value: 0 };
    const current = revision;
    subscribeDatabaseWork(db, topic, () => { current.value++; });
    revisions.set(owner, revision);
  }
  // Normally in-memory only. A failed/ambiguous transaction must settle before
  // its cached pre-commit read can be trusted; reuse the DB's XID reconciliation.
  await reconcileDatabaseWork(db, topic);
  return revision.value;
}

export function notifyEnvironmentConfigChange(transaction: object): Promise<void> {
  return signalDatabaseWork(transaction, topic);
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Also accepts an existing transaction: savepoints retain outer settlement. */
export function withEnvironmentConfigChange<T>(db: Pick<Db | Transaction, "transaction">,
  write: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyEnvironmentConfigChange(tx);
    return write(tx);
  });
}
