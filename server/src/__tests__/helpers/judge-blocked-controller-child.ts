// RFL-requested real, independently booted controller for judge-slow-foreign.
// Slow asynchronous preparation must keep renewing; it is not an event-loop stall.
import { eq, sql } from "drizzle-orm";
import { closeLivenessDb, createDb, heartbeatRuns } from "@paperclipai/db";
import { currentControllerProcess } from "../../services/controller-process-identity.js";
import { legacyControllerClaim, watchLegacyControllerLease } from "../../services/legacy-controller-lease.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { connectionString, runId, applicationName, slow } = JSON.parse(input) as {
  connectionString: string; runId: string; applicationName: string; slow: boolean;
};
const db = createDb(connectionString, { maxConnections: 2, applicationName });
const stamp = await currentControllerProcess();
const [run] = await db.update(heartbeatRuns).set({
  ...legacyControllerClaim("legacy"), controllerProcess: stamp,
}).where(eq(heartbeatRuns.id, runId)).returning();
if (!run) throw new Error("judge_preparation_run_missing");
const controller = new AbortController();
const watch = watchLegacyControllerLease(db, run, controller);
try {
  await watch.assertOwned();
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, runId })}\n`);
  if (slow) await db.execute(sql`select pg_sleep(110) /* judge-slow-foreign-preparation */`);
  await watch.assertOwned("dispatching");
  const [resumed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  process.stdout.write(`${JSON.stringify({ resumed: true,
    gateAdmitted: !controller.signal.aborted && resumed?.executionStage === "dispatching"
      && resumed.controllerBootId === stamp.bootId && resumed.status === "running",
    lateRenewal: !!resumed?.controllerLeaseExpiresAt && !!run.controllerLeaseExpiresAt
      && resumed.controllerLeaseExpiresAt > run.controllerLeaseExpiresAt,
  })}\n`);
} finally {
  watch.stop();
  await closeLivenessDb(db, 1);
  await db.$client.end();
}
