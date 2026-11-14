// Real controller process for the preparation-ownership integration test.
// Input is a temporary test database and an existing run, never operator config.
import { eq, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { currentControllerProcess } from "../../services/controller-process-identity.js";
import { legacyControllerClaim, watchLegacyControllerLease } from "../../services/legacy-controller-lease.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { connectionString, runId, applicationName } = JSON.parse(input) as {
  connectionString: string; runId: string; applicationName: string;
};
const db = createDb(connectionString, { maxConnections: 2, applicationName });
const stamp = await currentControllerProcess();
const [run] = await db.update(heartbeatRuns).set({
  ...legacyControllerClaim("legacy"), controllerProcess: stamp,
}).where(eq(heartbeatRuns.id, runId)).returning();
if (!run) throw new Error("test_preparation_run_missing");
const watch = watchLegacyControllerLease(db, run, new AbortController());
try {
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, runId })}\n`);
  await db.execute(sql`select pg_sleep(120) /* d11c-owner-preparing */`);
} finally {
  watch.stop();
  await db.$client.end();
}
