import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb, secretAccessEvents, userSecretDefinitions } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { deleteCompany } from "../services/company-deletion.js";
import { drainSecretResolutionWrites, enqueueSecretAccessEvent, flushSecretResolutionWrites } from "../services/secret-resolution-writes.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitAt(gate: ReturnType<typeof barrier>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([gate.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
function sqlState(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && typeof error.code === "string") return error.code;
    error = "cause" in error ? error.cause : undefined;
  }
}

suite("secret audit recovery vs company deletion lock order (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("secret-audit-deadlock");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  });
  afterAll(async () => {
    try { if (db) await flushSecretResolutionWrites(db); }
    finally { await cleanup?.(); }
  });

  it.each(["recovery", "deletion"] as const)("does not deadlock when %s detects the cycle first", async detector => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Deleting audit tenant", issuePrefix: `A${companyA.slice(0, 7)}` },
      { id: companyB, name: "Live audit tenant", issuePrefix: `B${companyB.slice(0, 7)}` },
    ]);
    const [secret] = await db.insert(companySecrets).values({ companyId: companyA, key: "delete-during-recovery", name: "Delete during recovery", provider: "local_encrypted", externalRef: "disposable-reference" }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId: companyA, key: "deleted", name: "Missing audit reference" }).returning();
    const event = { provider: "local_encrypted", actorType: "system", consumerType: "system", consumerId: "lock-order", outcome: "success" };
    await enqueueSecretAccessEvent(db, { ...event, companyId: companyA, secretId: secret.id, userSecretDefinitionId: definition.id });
    await enqueueSecretAccessEvent(db, { ...event, companyId: companyB });
    await db.delete(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));

    const recoveryEntered = barrier();
    const startRecovery = barrier();
    const secretDeleted = barrier();
    const finishDeletion = barrier();
    const transaction = db.transaction.bind(db);
    const observedErrors: Array<{ operation: string; code: string | undefined }> = [];
    let recoveryPid = 0;
    let deletionPid = 0;
    let transactionNumber = 0;
    const warning = vi.spyOn(logger, "warn");
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const number = ++transactionNumber;
      const operation = number === 2 ? "deletion" : "recovery";
      try {
        return await transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
          await tx.execute(sql.raw(`SET LOCAL deadlock_timeout = '${detector === operation ? (operation === "recovery" ? "1s" : "20ms") : "5s"}'`));
          const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          if (number === 1) {
            recoveryPid = backend.pid;
            recoveryEntered.resolve();
            await startRecovery.promise;
          }
          if (number === 2) deletionPid = backend.pid;
          const controlled = new Proxy(tx, {
            get(target, property, receiver) {
              if (number === 2 && property === "delete") {
                return (table: Parameters<typeof tx.delete>[0]) => {
                  const query = target.delete(table);
                  if (table !== companySecrets) return query;
                  return new Proxy(query, {
                    get(builder, key, queryReceiver) {
                      if (key === "where") return (...args: Parameters<typeof query.where>) =>
                        Promise.resolve(builder.where(...args)).then(async result => {
                          secretDeleted.resolve();
                          await finishDeletion.promise;
                          return result;
                        });
                      return Reflect.get(builder, key, queryReceiver);
                    },
                  });
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
          return callback(controlled);
        }, config);
      } catch (error) {
        observedErrors.push({ operation, code: sqlState(error) });
        throw error;
      }
    });
    let flush: Promise<unknown> | undefined;
    let deletion: Promise<unknown> | undefined;
    let results: PromiseSettledResult<unknown>[] = [];
    let childWaitObserved = false;
    try {
      flush = flushSecretResolutionWrites(db);
      const flushResult = Promise.allSettled([flush]);
      await waitAt(recoveryEntered, "real FK recovery");
      deletion = deleteCompany(db, companyA);
      const deletionResult = Promise.allSettled([deletion]);
      await waitAt(secretDeleted, "company and secret deletion locks");
      startRecovery.resolve();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [waiting] = await db.execute<{ blocked: boolean }>(sql`
          SELECT ${deletionPid} = ANY(pg_blocking_pids(${recoveryPid})) AS blocked`);
        if (waiting.blocked) { childWaitObserved = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      finishDeletion.resolve();
      results = [...await flushResult, ...await deletionResult];
      const liveEvents = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyB));
      const deletedEvents = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyA));
      const remainingCompany = await db.select().from(companies).where(eq(companies.id, companyA));
      const drops = warning.mock.calls.filter(call => call[1] === "Dropped secret audit events for deleted companies");
      const evidence = JSON.stringify({ detector, childWaitObserved, observedErrors, operations: results.map(result => result.status), liveEvents: liveEvents.length, deletedEvents: deletedEvents.length, deletedCompanyRemaining: remainingCompany.length, droppedCounts: drops.map(call => call[0]) });
      console.info(evidence);
      if (process.env.SECRET_DEADLOCK_EVIDENCE) await appendFile(process.env.SECRET_DEADLOCK_EVIDENCE, `${evidence}\n`);
      expect(childWaitObserved).toBe(true);
      expect(observedErrors.filter(error => error.code === "40P01")).toEqual([]);
      expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(remainingCompany).toHaveLength(0);
      expect(liveEvents).toHaveLength(1);
      expect(deletedEvents).toHaveLength(0);
      expect(drops).toHaveLength(1);
      expect(drops[0][0]).toEqual({ kind: "audit", droppedCount: 1 });
      await drainSecretResolutionWrites();
      await flushSecretResolutionWrites(db);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyB))).toHaveLength(1);
    } finally {
      startRecovery.resolve();
      finishDeletion.resolve();
      await Promise.allSettled([flush, deletion]);
      spy.mockRestore();
      warning.mockRestore();
      await deleteCompany(db, companyA);
      await flushSecretResolutionWrites(db);
    }
  }, 30_000);
});
