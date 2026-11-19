// Keep reason: captured live P0 BEFORE state; never fake the PostgreSQL boundary.
// Source: testing-lead's tl-capture-1119 brief and gate2 2026-11-19 takes.
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { assertCapturedRoundTrip, loadCapturedFixture, readCapturedFixture, withCapturedControllerIdentity,
  type CapturedControllerIdentity } from "./helpers/load-captured-fixture.js";
import * as controllerProcess from "../services/controller-process-identity.js";

const syntheticDir = fileURLToPath(new URL("./fixtures/synthetic/capture-loader/", import.meta.url));
const configuredDirs = process.env.PAPERCLIP_CAPTURE_DIRS;
const configuredRoot = process.env.PAPERCLIP_CAPTURE_ROOT;
let captureDirs: string[] = [];
if (configuredDirs !== undefined) {
  captureDirs = configuredDirs.split(",").map(dir => dir.trim()).filter(Boolean).map(dir => resolve(dir));
  if (!captureDirs.length) throw new Error("PAPERCLIP_CAPTURE_DIRS must name at least one capture directory");
} else if (configuredRoot !== undefined) {
  if (!configuredRoot.trim()) throw new Error("PAPERCLIP_CAPTURE_ROOT must name a private capture root");
  const root = resolve(configuredRoot);
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      if ((await stat(join(dir, "MANIFEST.json"))).isFile()) captureDirs.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!captureDirs.length) throw new Error("PAPERCLIP_CAPTURE_ROOT contains no capture directories with MANIFEST.json");
}

const fixtures = [
  { fixture: "synthetic-loader", dir: syntheticDir, synthetic: true },
  ...[...new Set(captureDirs)].map(dir => ({ fixture: basename(dir), dir, synthetic: false })),
];
if (!captureDirs.length) {
  for (const fixture of ["gate2-p0-before", "gate2-p0-repeat", "gate4-steer-hand-v1", "gate4-after-end-fail-v1"]) {
    it.skip(`captured ${fixture}: set PAPERCLIP_CAPTURE_DIRS or PAPERCLIP_CAPTURE_ROOT to load private captures`, () => {});
  }
}
for (const { fixture, dir, synthetic } of fixtures) {
  describe(`${synthetic ? "synthetic" : "captured"} real-PG boundary: ${fixture}`, () => {
    let db: ReturnType<typeof createDb>;
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let issue: string;
    let controllers: CapturedControllerIdentity[];
    beforeAll(async () => {
      console.info(`HARNESS probing real PostgreSQL: ${fixture}`);
      const support = await getEmbeddedPostgresTestSupport();
      if (!support.supported) throw new Error("Capture demo requires real PostgreSQL; unavailable is not a pass");
      console.info(`HARNESS starting migrated real PostgreSQL: ${fixture}`);
      database = await startEmbeddedPostgresTestDatabase("paperclip-captured-fixture-");
      db = createDb(database.connectionString);
      console.info(`HARNESS loading capture: ${fixture}`);
      const loaded = await loadCapturedFixture(db, dir);
      issue = loaded.manifest.issue;
      controllers = loaded.controllers;
      console.info(`LOADED ${fixture}: ${Object.values(loaded.inserted).reduce((a, b) => a + b, 0)} rows; nullable FK columns restored=${loaded.restoredEdges}`);
    }, 120_000);
    afterAll(async () => {
      await db?.$client.end({ timeout: 5 });
      await database?.cleanup();
    }, 30_000);

    it("round-trips every captured table row-for-row using the original SQL", async () => {
      const counts = await assertCapturedRoundTrip(db, dir);
      if (synthetic) expect(counts).toEqual({
        companies: 1, agents: 1, issues: 1, heartbeat_runs: 1,
        agent_wakeup_requests: 1, heartbeat_run_events: 1, issue_recovery_actions: 1,
      });
      console.info(`ROUND_TRIP PASS ${fixture}: ${JSON.stringify(counts)}`);
    }, 60_000);

    it.skipIf(synthetic)("replays controller host proof red / green / different-host control without changing captured rows", async () => {
      const { evaluateNativeControllerTakeover } = await import("../services/native-runtime/native-restart-recovery.js");
      // Use the production schema's timestamp codecs, not raw-driver strings.
      const owners = await db.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.issueId, issue), isNotNull(nativeRunFinalizations.controllerPid),
      )).orderBy(nativeRunFinalizations.runId);
      expect(owners.length > 0, "private capture must contain a recorded controller").toBe(true);
      const originalHost = controllerProcess.currentProcessSpaceHash();
      const originalBoot = controllerProcess.currentControllerBootId();
      const nextDecisions = new Set<string>();
      for (const owner of owners) {
        const identity = controllers.find(c => c.runId === owner.runId);
        // Boolean assertions cannot leak captured identities on failure.
        expect(identity !== undefined, "loaded owner must have a captured identity").toBe(true);
        expect(identity!.hostHash === owner.controllerHostHash, "identity must come from this owner's captured row").toBe(true);
        expect(identity!.bootId === owner.controllerBootId, "recorded owner boot must be preserved").toBe(true);
        expect(originalBoot !== identity!.bootId, "replay must be a new controller boot").toBe(true);
        const now = new Date();
        // Approved takes include terminal rows whose leases have been cleared.
        // Require stopped-controller proof even for these rows: otherwise the
        // normal unowned shortcut never exercises the host check at all.
        const replay = () => evaluateNativeControllerTakeover({ owner, now,
          requireStoppedController: true, requireRecordedProcessSpace: true });
        const red = await withCapturedControllerIdentity(identity!, replay, "disabled");
        expect(red.allowed).toBe(false);
        expect(red.reason).toBe("controller_host_unprovable");
        const green = await withCapturedControllerIdentity(identity!, replay);
        // A replay PID may belong to another local process. Passing the host
        // check is NOT permission to bypass that next, real PID-identity check.
        expect(["controller_process_dead", "expired_lease_controller_process_dead", "controller_pid_recycled",
          "controller_pid_start_inconsistent", "controller_still_alive"].includes(green.reason),
          "recorded PID space must reach the next real PID-identity decision").toBe(true);
        nextDecisions.add(green.reason);
        const control = await withCapturedControllerIdentity(identity!, replay, "different");
        expect(control.allowed).toBe(false);
        expect(control.reason).toBe("controller_host_unprovable");
        expect(controllerProcess.currentProcessSpaceHash() === originalHost, "host seam must be restored").toBe(true);
        expect(controllerProcess.currentControllerBootId() === originalBoot, "current boot must not be replaced").toBe(true);
      }
      // A failing callback must not leave the process pretending to be the capture host.
      await expect(withCapturedControllerIdentity(controllers.find(c => c.runId === owners[0].runId)!, async () => {
        throw new Error("capture replay failure sentinel");
      })).rejects.toThrow("capture replay failure sentinel");
      expect(controllerProcess.currentProcessSpaceHash() === originalHost, "throwing replay must restore host seam").toBe(true);
      await assertCapturedRoundTrip(db, dir);
      console.info(`HOSTID PASS ${fixture}: red=controller_host_unprovable; green=${[...nextDecisions].sort().join(",")}; control=controller_host_unprovable; owners=${owners.length}; rows unchanged`);
    }, 60_000);

    it.skipIf(synthetic)("keeps user IDs exact and synthesizes only the documented harness identity fields", async () => {
      const { rows } = await readCapturedFixture(dir);
      const ids = await db.$client.unsafe<{ id: string }[]>('SELECT id FROM public."user" ORDER BY id');
      expect(ids.map(r => r.id).sort()).toEqual(rows.user.map(r => String(r.id)).sort());
      const [counts] = await db.$client.unsafe<{ bad: number }[]>(`SELECT count(*)::int AS bad FROM public."user"
        WHERE name <> 'captured-user-' || left(id,8) OR email <> 'captured-' || left(id,8) || '@capture.invalid'
        OR email_verified IS DISTINCT FROM false OR created_at <> 'epoch'::timestamptz OR updated_at <> 'epoch'::timestamptz`);
      expect(counts.bad).toBe(0);
    });

    it.runIf(synthetic)("refuses schema skew without an explicit pinned mapping", async () => {
      const skewDir = await mkdtemp(join(tmpdir(), "paperclip-captured-skew-"));
      try {
        await cp(dir, skewDir, { recursive: true });
        const manifest = JSON.parse(await readFile(join(skewDir, "MANIFEST.json"), "utf8"));
        manifest.schema_columns[0].character_maximum_length = 987;
        const canonical = (v: unknown): string => v !== null && typeof v === "object"
          ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
            : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
          : JSON.stringify(v);
        manifest.schema_fingerprint = createHash("sha256").update(canonical(manifest.schema_columns)).digest("hex");
        await writeFile(join(skewDir, "MANIFEST.json"), JSON.stringify(manifest), { mode: 0o600 });
        await expect(loadCapturedFixture(db, skewDir)).rejects.toThrow("Harness schema fingerprint mismatch");
      } finally { await rm(skewDir, { recursive: true, force: true }); }
    });

    it.runIf(["gate2-p0-before", "gate2-p0-repeat", "gate2-p0-before-v3", "gate2-p0-repeat-v3", "gate4-steer-hand-v1", "gate4-after-end-fail-v1"].includes(fixture))("preserves the captured failure or steering-order evidence", async () => {
      if (fixture === "gate4-steer-hand-v1") {
        const events = await db.$client.unsafe<{ seq: number; payload: Record<string, unknown> }[]>(
          `SELECT seq::int AS seq,payload FROM heartbeat_run_events WHERE run_id IN
           (SELECT r.id FROM heartbeat_runs r JOIN heartbeat_run_events e ON e.run_id=r.id
            WHERE r.issue_id=$1 GROUP BY r.id HAVING count(*)=328)
           AND seq BETWEEN 260 AND 320 ORDER BY seq`, [issue]);
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
           WHERE r.issue_id=$1 AND r.status IN ('succeeded','failed')
           GROUP BY r.id ORDER BY r.created_at`, [issue]);
        expect(runs.map(r => [r.status, r.error_code, r.event_count])).toEqual([
          ["succeeded", null, 468], ["failed", "native_run_failed", 289], ["succeeded", null, 400],
        ]);
        for (const run of runs) { expect(run.first_seq).toBe(1); expect(run.last_seq).toBe(run.event_count); }
        console.info(`AFTER_END_FAILURE PRESENT ${fixture}: succeeded -> failed(native_run_failed) -> succeeded; events 468+289+400 retained`);
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
    it.runIf(process.env.CAPTURE_DEMO_RED === "1" && fixture.startsWith("gate2-p0-"))("DEMO RED: interrupted work should not require reconciliation", async () => {
      const [row] = await db.$client.unsafe<{ recovery_count: number }[]>(
        "SELECT count(*)::int AS recovery_count FROM issue_recovery_actions WHERE source_issue_id=$1 AND cause='native_continuation_requires_reconciliation'", [issue]);
      expect(row.recovery_count, "captured P0 violates the desired no-reconciliation invariant").toBe(0);
    });
  });
}
