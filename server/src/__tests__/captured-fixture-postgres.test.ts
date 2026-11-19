// Keep reason: captured live P0 BEFORE state; never fake the PostgreSQL boundary.
// Source: testing-lead's tl-capture-1119 brief and gate2 2026-11-19 takes.
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertCapturedRoundTrip, loadCapturedFixture, readCapturedFixture } from "./helpers/load-captured-fixture.js";

const fixtures = ["gate2-p0-before", "gate2-p0-repeat", "gate4-steer-hand-v1", "gate4-after-end-fail-v1"];
const root = process.env.CAPTURE_FIXTURE_ROOT ?? fileURLToPath(new URL("./fixtures/captured/", import.meta.url));
for (const fixture of fixtures) {
  describe(`captured real-PG boundary: ${fixture}`, () => {
    let db: ReturnType<typeof createDb>;
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let issue: string;
    beforeAll(async () => {
      console.info(`HARNESS probing real PostgreSQL: ${fixture}`);
      const support = await getEmbeddedPostgresTestSupport();
      if (!support.supported) throw new Error("Capture demo requires real PostgreSQL; unavailable is not a pass");
      console.info(`HARNESS starting migrated real PostgreSQL: ${fixture}`);
      database = await startEmbeddedPostgresTestDatabase("paperclip-captured-fixture-");
      db = createDb(database.connectionString);
      console.info(`HARNESS loading capture: ${fixture}`);
      const loaded = await loadCapturedFixture(db, `${root}/${fixture}`);
      issue = loaded.manifest.issue;
      console.info(`LOADED ${fixture}: ${Object.values(loaded.inserted).reduce((a, b) => a + b, 0)} rows; nullable FK columns restored=${loaded.restoredEdges}`);
    }, 120_000);
    afterAll(async () => {
      await db?.$client.end({ timeout: 5 });
      await database?.cleanup();
    }, 30_000);

    it("round-trips every captured table row-for-row using the original SQL", async () => {
      const counts = await assertCapturedRoundTrip(db, `${root}/${fixture}`);
      console.info(`ROUND_TRIP PASS ${fixture}: ${JSON.stringify(counts)}`);
    }, 60_000);

    it("keeps user IDs exact and synthesizes only the documented harness identity fields", async () => {
      const { rows } = await readCapturedFixture(`${root}/${fixture}`);
      const ids = await db.$client.unsafe<{ id: string }[]>('SELECT id FROM public."user" ORDER BY id');
      expect(ids.map(r => r.id).sort()).toEqual(rows.user.map(r => String(r.id)).sort());
      const [counts] = await db.$client.unsafe<{ bad: number }[]>(`SELECT count(*)::int AS bad FROM public."user"
        WHERE name <> 'captured-user-' || left(id,8) OR email <> 'captured-' || left(id,8) || '@capture.invalid'
        OR email_verified IS DISTINCT FROM false OR created_at <> 'epoch'::timestamptz OR updated_at <> 'epoch'::timestamptz`);
      expect(counts.bad).toBe(0);
    });

    it.runIf(fixture === "gate2-p0-before")("refuses schema skew without an explicit pinned mapping", async () => {
      const dir = await mkdtemp(join(tmpdir(), "paperclip-captured-skew-"));
      try {
        await cp(`${root}/${fixture}`, dir, { recursive: true });
        const manifest = JSON.parse(await readFile(join(dir, "MANIFEST.json"), "utf8"));
        manifest.schema_columns[0].character_maximum_length = 987;
        const canonical = (v: unknown): string => v !== null && typeof v === "object"
          ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
            : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
          : JSON.stringify(v);
        manifest.schema_fingerprint = createHash("sha256").update(canonical(manifest.schema_columns)).digest("hex");
        await writeFile(join(dir, "MANIFEST.json"), JSON.stringify(manifest), { mode: 0o600 });
        await expect(loadCapturedFixture(db, dir)).rejects.toThrow("Harness schema fingerprint mismatch");
      } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it("preserves the captured failure or steering-order evidence", async () => {
      if (fixture === "gate4-steer-hand-v1") {
        const events = await db.$client.unsafe<{ seq: number; payload: Record<string, unknown> }[]>(
          "SELECT seq::int AS seq,payload FROM heartbeat_run_events WHERE run_id=$1 AND seq BETWEEN 260 AND 320 ORDER BY seq",
          ["fcdf9174-b883-404d-85fa-46f9b22d2895"]);
        expect(events.map(e => e.seq)).toEqual(Array.from({ length: 61 }, (_, n) => 260 + n));
        const payload = (seq: number) => ((events.find(e => e.seq === seq)!.payload.prpEvent as Record<string, unknown>).payload as Record<string, unknown>);
        expect(payload(265).kind).toBe("steering_acknowledgement");
        expect(payload(271).kind).toBe("userMessage");
        expect(payload(296).kind).toBe("agentMessage");
        expect(payload(310).channel).toBe("final");
        console.info(`STEER_ORDER PRESENT ${fixture}: ack265 < user271 < agent296 < final310; all 61 events retained`);
        return;
      }
      if (fixture === "gate4-after-end-fail-v1") {
        const runs = await db.$client.unsafe<{ id: string; status: string; error_code: string | null; event_count: number; first_seq: number; last_seq: number }[]>(
          `SELECT r.id,r.status,r.error_code,count(e.id)::int AS event_count,min(e.seq)::int AS first_seq,max(e.seq)::int AS last_seq
           FROM heartbeat_runs r LEFT JOIN heartbeat_run_events e ON e.run_id=r.id
           WHERE r.issue_id=$1 AND (r.id::text LIKE '99ad41ce%' OR r.id::text LIKE 'f5a19940%' OR r.id::text LIKE '038baba6%')
           GROUP BY r.id ORDER BY r.created_at`, [issue]);
        expect(runs.map(r => [r.id.slice(0, 8), r.status, r.error_code, r.event_count])).toEqual([
          ["99ad41ce", "succeeded", null, 468], ["f5a19940", "failed", "native_run_failed", 289], ["038baba6", "succeeded", null, 400],
        ]);
        for (const run of runs) { expect(run.first_seq).toBe(1); expect(run.last_seq).toBe(run.event_count); }
        console.info(`AFTER_END_FAILURE PRESENT ${fixture}: succeeded99ad41ce -> failedf5a19940(native_run_failed) -> succeeded038baba6; events 468+289+400 retained`);
        return;
      }
      const actions = await db.$client.unsafe<{ id: string; cause: string; created_at: Date }[]>(
        "SELECT id,cause,created_at FROM issue_recovery_actions WHERE source_issue_id=$1 AND cause='native_continuation_requires_reconciliation'", [issue]);
      expect(actions).toHaveLength(1);
      const cancelled = await db.$client.unsafe<{ id: string }[]>(
        "SELECT id FROM heartbeat_runs WHERE issue_id=$1 AND status='cancelled' AND error_code='operator_interrupted' AND finished_at < $2::timestamptz", [issue, actions[0].created_at]);
      expect(cancelled).toHaveLength(1);
      const [split] = await db.$client.unsafe<{ distinct_runs: number }[]>(
        `SELECT count(DISTINCT w.run_id)::int AS distinct_runs FROM agent_wakeup_requests w
         JOIN heartbeat_runs r ON r.id=w.run_id
         WHERE r.issue_id=$1 AND r.id<>$2 AND w.run_id IS NOT NULL`, [issue, cancelled[0].id]);
      expect(split.distinct_runs).toBe(2);
      console.info(`FAILING_STATE PRESENT ${fixture}: cancelled run -> reconciliation action -> two successor run IDs`);
    });

    // This deliberately fails against the capture, NOT a claimed product fix.
    // Opt in explicitly to demonstrate the product invariant RED on both takes.
    it.runIf(process.env.CAPTURE_DEMO_RED === "1" && fixture.startsWith("gate2-"))("DEMO RED: interrupted work should not require reconciliation", async () => {
      const [row] = await db.$client.unsafe<{ recovery_count: number }[]>(
        "SELECT count(*)::int AS recovery_count FROM issue_recovery_actions WHERE source_issue_id=$1 AND cause='native_continuation_requires_reconciliation'", [issue]);
      expect(row.recovery_count, "captured P0 violates the desired no-reconciliation invariant").toBe(0);
    });
  });
}
