import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

/** Marks the async context while a DB transaction callback runs. A frame closes when its callback settles,
 * so work merely started inside a transaction (fire and forget) is not counted once that transaction ends.
 * A transaction opened directly in a dedicated lock session (and its savepoints) is marked 'dedicated lock
 * session', not counted: upstream's designed finalization-lock pattern (workspace-source-lock.ts). */
type Frame = { open: boolean; dedicated: boolean; lockSession?: true; parent: Frame | undefined };
const openTransaction = new AsyncLocalStorage<Frame>();

export function runInDedicatedLockSession<T>(work: () => T): T {
  return openTransaction.run({ open: false, dedicated: true, lockSession: true, parent: openTransaction.getStore() }, work);
}

export function runInTransactionContext<T>(work: () => T, savepoint = false): T {
  const parent = openTransaction.getStore();
  const dedicated = parent?.dedicated === true && (savepoint ? !parent.lockSession : parent.lockSession === true);
  const frame: Frame = { open: true, dedicated, parent };
  return openTransaction.run(frame, () => {
    const close = () => { frame.open = false; };
    try {
      const result = work();
      if (result instanceof Promise) return result.finally(close) as T;
      close();
      return result;
    } catch (error) { close(); throw error; }
  });
}

export function holdsOpenTransaction(): boolean {
  for (let frame = openTransaction.getStore(); frame; frame = frame.parent) if (frame.open && !frame.dedicated) return true;
  return false;
}

/** PAPERCLIP_TX_NETWORK_GUARD: "throw" (tests, dev gates), "off", else log: one structured warn per call site. */
const warnedSites = new Set<string>();
export function assertNoOpenTransaction(client: string): void {
  const mode = process.env.PAPERCLIP_TX_NETWORK_GUARD;
  if (mode === "off" || !holdsOpenTransaction()) return;
  const error = new Error(`network_call_in_db_transaction: ${client} was called while this async context holds an open DB transaction`);
  const stack = error.stack ?? "";
  const site = `${client}@${stack.split("\n").slice(2, 4).map(line => line.trim()).join(" <- ")}`;
  const worker = (globalThis as { __vitest_worker__?: { filepath?: string; current?: { name?: string } } }).__vitest_worker__;
  const record = { level: "warn", event: "network_call_in_db_transaction", client, site, mode: mode ?? "log",
    testFile: worker?.filepath, test: worker?.current?.name, stack };
  const report = process.env.PAPERCLIP_TX_NETWORK_GUARD_REPORT;
  if (report) appendFileSync(report, `${JSON.stringify(record)}\n`);
  if (mode === "throw") throw error;
  if (warnedSites.has(site)) return;
  warnedSites.add(site);
  console.warn(JSON.stringify(record));
}
