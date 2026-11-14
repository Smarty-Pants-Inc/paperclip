import { createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";

// Test-only second controller process. All inputs name the parent's disposable
// PostgreSQL fixture. No production config or provider is used.
const db = createDb(process.env.RFL_LOCAL_DATABASE_URL!);
const companyId = process.env.RFL_COMPANY_ID!;
const issueId = process.env.RFL_ISSUE_ID!;
const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
try {
  if (process.env.RFL_CRASH_BEFORE_QUEUE === "1") {
    await recoveryService(db, {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts),
      afterStrandedLatestRunRead: async () => process.exit(77),
    }).reconcileStrandedAssignedIssues({ companyId, issueId });
    throw new Error("Expected crash point was not reached");
  }
  await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId, unanswered: false });
  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  if (process.env.RFL_STOP_FIRST === "1") {
    if (runs.length !== 1) throw new Error(`Expected one initial run, got ${runs.length}`);
    await heartbeat.cancelRun(runs[0]!.id, "RFL operator stopped queued import run", {
      suppressImmediateRecovery: true,
      resultJson: { cancelledByActorType: "user", cancelledByUserId: process.env.RFL_ACTOR_ID! },
    });
  }
  const after = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  console.log(JSON.stringify({ pid: process.pid, check: "separate-controller", runs: after.map(r => ({ id: r.id, status: r.status })) }));
} finally {
  await heartbeat.drainActiveRunExecutions();
  await db.$client.end();
}
