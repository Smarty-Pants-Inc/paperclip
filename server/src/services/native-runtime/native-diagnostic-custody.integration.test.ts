import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunDiagnostics, type Db } from "@paperclipai/db";
import { createNativeRunTrace } from "./native-run-trace.js";
import { accountUnconfirmedNativeRunDiagnostics, nativeRunDiagnosticCustody } from "./native-run-diagnostics.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported || process.platform === "win32")("diagnostic custody across SIGKILL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-diagnostic-custody-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Diagnostic custody", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Diagnostic custody", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Diagnostic custody" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
    return { companyId, agentId, issueId, runId };
  }

  it("captures without the run allocator lock, removes confirmed delivery, and retains failures through finalization", async () => {
    const binding = await fixture();
    const capture = nativeRunDiagnosticCustody(db, binding);
    const event = { eventType: "run.performance.span", payload: { schema: "paperclip.run-performance-span.v1", span: "runner.session.bootstrap" } };
    const costs: number[] = [];
    await db.transaction(async tx => {
      // This is the lock mode used by the real allocator. Capture must finish
      // on another connection while this lock remains held, not after release.
      await tx.execute(sql`select id from heartbeat_runs where id = ${binding.runId} for no key update`);
      for (let n = 0; n < 10; n++) {
        const startedAt = performance.now();
        const acknowledged = await capture([event]);
        costs.push(performance.now() - startedAt);
        await acknowledged();
      }
    });
    console.log(JSON.stringify({ measurement: "custody-insert-under-allocator-lock", samplesMs: costs }));
    expect(await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId))).toEqual([]);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const trace = createNativeRunTrace({ runId: binding.runId, custody: capture, onEvent: async () => { await gate; } });
    await trace.record({ name: "runner.session.bootstrap", startedAtMs: 1, endedAtMs: 2, attributes: { provider: "pi_rpc", secret: "must-not-persist" } }, { deferRunLog: true });
    const [pending] = await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId));
    expect(pending.event.payload).not.toHaveProperty("secret");
    release(); await trace.finish("ok");
    expect(await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId))).toEqual([]);

    const failed = createNativeRunTrace({ runId: binding.runId, custody: capture, onEvent: async () => { throw new Error("sink unavailable"); } });
    await failed.record({ name: "runner.session.bootstrap", startedAtMs: 1, endedAtMs: 2 }, { deferRunLog: true });
    await failed.finish("ok");
    await accountUnconfirmedNativeRunDiagnostics(db, { ...binding, companyId: randomUUID() });
    const [unconfirmed] = await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId));
    expect(unconfirmed.lossReason).toBeNull();
    await accountUnconfirmedNativeRunDiagnostics(db, binding);
    const [lost] = await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId));
    expect(lost.lossReason).toBe("delivery_unconfirmed_at_finalization");
    expect(lost.event.payload).toMatchObject({ span: "runner.session.bootstrap", wallStartedAtMs: 1, durationMs: 1 });
    await expect(nativeRunDiagnosticCustody(db, { ...binding, companyId: randomUUID() })([event])).rejects.toThrow();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
    expect(await db.select().from(nativeRunDiagnostics).where(eq(nativeRunDiagnostics.runId, binding.runId))).toEqual([]);
  });

  it.each(["cold", "warm", "pi-warm"])("retains the %s admission receipts when the controller dies before the deferred sink write", async mode => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-crash-"));
    const { companyId, agentId, issueId, runId } = await fixture();
    const admittedPath = join(root, "admitted.json");
    const log = await open(join(root, "child.log"), "w");
    const child = spawn(process.execPath, ["../node_modules/vitest/vitest.mjs", "run", "src/services/native-runtime/native-session-executor.test.ts", "-t", "diagnostic custody crash child"], {
      cwd: new URL("../../..", import.meta.url), detached: true, stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, PAPERCLIP_DIAGNOSTIC_CRASH_FIXTURE: JSON.stringify({ connectionString: database.connectionString,
        binding: { companyId, agentId, issueId, runId, executionWorkspaceId: randomUUID() }, admittedPath, mode }) },
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    let killed = false;
    try {
      let admitted: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 400; attempt++) {
        try { admitted = JSON.parse(await readFile(admittedPath, "utf8")); break; } catch { /* Wait for the actual admission marker. */ }
        if (child.exitCode !== null) throw new Error(await readFile(join(root, "child.log"), "utf8"));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!admitted) throw new Error(`Controller did not admit: ${await readFile(join(root, "child.log"), "utf8")}`);
      process.kill(-child.pid!, "SIGKILL"); killed = true;
      const terminal = await exited;
      expect(terminal.signal).toBe("SIGKILL");
      const events = await db.execute(sql`select event_type, payload from heartbeat_run_events where run_id = ${runId}`);
      const [journal] = await db.execute(sql`select to_regclass('native_run_diagnostics') as relation`);
      // An absent journal at the unfixed revision is not a setup failure: it
      // means the real run-event store is the only durable custody available.
      const pending = journal.relation ? await db.execute(sql`select event from native_run_diagnostics where run_id = ${runId}`) : [];
      const names = [...events.map(row => (row.payload as Record<string, unknown>)?.span),
        ...pending.map(row => ((row.event as Record<string, unknown>)?.payload as Record<string, unknown>)?.span)];
      console.log(JSON.stringify({ measurement: "crash-custody", mode, admitted, terminal, runEventCount: events.length,
        durableSpans: names.filter(Boolean), pendingCount: pending.length }));
      expect(names).toEqual(expect.arrayContaining([mode !== "cold" ? "runner.session.resume" : "runner.session.bootstrap",
        "runner.turn.submit", "runner.session.startup", "runner.turn.submitted_to_started"]));
      if (mode === "pi-warm") {
        const receipts = [...events.map(row => row.payload), ...pending.map(row => (row.event as Record<string, unknown>)?.payload)];
        expect(receipts).toEqual(expect.arrayContaining([
          expect.objectContaining({ schema: "paperclip.startup-reuse.v1", layer: "runner", state: "reused" }),
          expect.objectContaining({ schema: "paperclip.startup-reuse.v1", layer: "provider_session", state: "reused" }),
        ]));
      }
    } finally {
      if (!killed) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ } }
      await exited; await log.close(); await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
