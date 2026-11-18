// Independent review-fleet-4 regressions. Data-safety keep reason: durable receipt order.
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createHeartbeatRunOutput } from "./run-output.js";
import { createHeartbeatLifecycle } from "./run-lifecycle.js";
import { addRunSecretMaterial, createAgentIdentityRedactor } from "../agent-identity-redaction.js";

const at = (second: number) => `2026-11-16T19:07:${String(second).padStart(2, "0")}.007Z`;

describe("independent real PostgreSQL receipt stamp integrity regressions", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    // No skip: missing embedded PG is a failure, never a pass.
    temporary = await startEmbeddedPostgresTestDatabase("receipt-stamp-integrity-");
    db = createDb(temporary.connectionString);
    const [version] = await db.$client`select version()`;
    console.log("REAL_POSTGRES_VERSION", version);
  }, 90_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function recorder(secrets: string[] = []) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "rf4 receipt judge", issuePrefix: `S${companyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "receipt judge", adapterType: "process", status: "idle" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    const identityRedactor = createAgentIdentityRedactor();
    addRunSecretMaterial(identityRedactor, secrets);
    const lifecycle = createHeartbeatLifecycle(db, { getCurrentUserRedactionOptions: async () => ({ enabled: false }) } as never);
    const output = createHeartbeatRunOutput(db, {
      run, runId: run.id, issueId: null, secretKeys: new Set(), identityRedactor,
      runLogStore: { begin: async () => ({ store: "local_file", logRef: `judge/${run.id}` }), append: async () => 0,
        enqueue: async () => ({ committed: Promise.resolve(0) }), flush: async () => undefined } as never,
      // This is the REAL lifecycle redaction/bounding/append, not a capture stub.
      appendRunEvent: lifecycle.appendRunEvent,
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const handlers = await output.begin(run);
    const rows = () => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(asc(heartbeatRunEvents.seq));
    return { handlers, rows };
  }

  it("S3 integrity regression: receipt fields survive the real persistence payload key bound", async () => {
    const r = await recorder();
    const payload = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, "ok"]));
    await r.handlers.onAdapterEvent({ eventType: "tool.output", stream: "stdout", payload });
    await r.handlers.finishAdapterEvents();
    const [event] = await r.rows();
    expect(event.payload?.adapterEventIndex).toBe(1);
    expect(typeof event.payload?.receivedAt).toBe("string");
  });

  it("S3 integrity regression: finishing held adapter fields cannot overwrite the server-owned stamp", async () => {
    const r = await recorder(["synthetic-secret-token-0001"]);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at(1)));
    await r.handlers.onAdapterEvent({ eventType: "tool.output", stream: "stdout", payload: {
      receivedAt: { output: "synthetic-secret" }, adapterEventIndex: { output: "synthetic-secret" }, output: "normal output\\n",
    } });
    expect(await r.rows()).toHaveLength(0);
    await r.handlers.finishAdapterEvents();
    const [event] = await r.rows();
    expect(event.payload?.receivedAt).toBe(at(1));
    expect(event.payload?.adapterEventIndex).toBe(1);
  });
});
