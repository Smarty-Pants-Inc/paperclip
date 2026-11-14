// Local subprocess fixture for the unchanged independent RFL race tests.
// The judge handoff omitted this helper. No provider may start in this process.
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";

const connectionString = process.env.RFL_LOCAL_DATABASE_URL;
const companyId = process.env.RFL_COMPANY_ID;
const issueId = process.env.RFL_ISSUE_ID;
if (!connectionString || !companyId || !issueId) throw new Error("Missing local RFL fixture binding");
const db = createDb(connectionString);
const heartbeat = heartbeatService(db, {
  runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} },
});
try {
  const recovery = recoveryService(db, {
    enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
    afterStrandedLatestRunRead: async ({ runId }) => {
      if (process.env.RFL_CRASH_BEFORE_QUEUE === "1") {
        if (runId !== null) throw new Error("Crash witness must precede initial admission");
        process.exit(77);
      }
    },
  });
  await recovery.reconcileStrandedAssignedIssues({ companyId, issueId });
  if (process.env.RFL_STOP_FIRST === "1") {
    const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    if (!first) throw new Error("Expected real queued admission before Stop");
    await heartbeat.cancelRun(first.id, "RFL operator stopped queued import run", {
      suppressImmediateRecovery: true,
      resultJson: { cancelledByActorType: "user", cancelledByUserId: process.env.RFL_ACTOR_ID },
    });
  }
  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  console.log(JSON.stringify({ check: "rfl-peer", pid: process.pid, runs: runs.map(({ id, status }) => ({ id, status })) }));
} finally {
  await heartbeat.drainActiveRunExecutions();
  await db.$client.end();
}
