// A fresh controller process for judge-pausing-s2's restart-after-B row: argv = connection string,
// agent id, the parent's clock (ms). It runs one lifecycle sweep with the provider still reporting
// the old box as running, then prints RESTART_PROCESS_RESULT=<json> and exits.
import { eq } from "drizzle-orm";
import { agents, createDb, environmentLeases, heartbeatRuns } from "@paperclipai/db";

const [connectionString, agentId, nowArg] = process.argv.slice(2);
const offset = Number(nowArg) - Date.now();
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [string]));
  }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate as DateConstructor;

const { startAgentLifecycle } = await import("../../services/agent-lifecycle.js");
const { createLifecycleDriver } = await import("../../services/agent-lifecycle-driver.js");
const { heartbeatService } = await import("../../services/heartbeat.js");
const { environmentRuntimeService } = await import("../../services/environment-runtime.js");

const db = createDb(connectionString!);
let inspectCount = 0;
const runtime = environmentRuntimeService(db);
const inspectLeaseResource = async (leaseId: string) => {
  inspectCount += 1;
  const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
  return { providerLeaseId: lease?.providerLeaseId ?? null, state: "running" } as never;
};
const heartbeat = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource, releaseRunLeases: async () => [] } as never });
const owner = startAgentLifecycle(db, createLifecycleDriver(db, { call: async () => undefined } as never, heartbeat), () => true);
try {
  await owner.sweep();
} finally {
  await owner.stop();
}
const [agent] = await db.select().from(agents).where(eq(agents.id, agentId!));
const runStatuses = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId!))).map(run => run.status);
console.log(`RESTART_PROCESS_RESULT=${JSON.stringify({ pid: process.pid, inspectCount, agent, runStatuses })}`);
process.exit(0);
