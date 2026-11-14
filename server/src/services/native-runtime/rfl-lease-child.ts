// RFL independent second-controller process. Only connects to the test-owned PG.
import { sql } from "drizzle-orm";
import { createDb, environmentLeases } from "@paperclipai/db";
import { currentControllerBootId, currentControllerProcessStamp, currentProcessSpaceHash } from "../controller-process-identity.js";
import { registerControllerInstanceLeaseWork, tickControllerInstanceLease } from "../controller-instance-lease.js";
import { withEnvironmentLeaseController } from "../environment-lease-controller.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
const db = createDb(process.env.RFL_TEST_DB!);
const lost: string[] = [];
let wakes = 0;
// Scheduling gate: the real worker callback is run explicitly, never a mocked renewal.
const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => { wakes++; }, stop: async () => {} }) } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
const work = registerControllerInstanceLeaseWork(db, coordinator, { onLost: reason => lost.push(reason) });
const deadline = setTimeout(() => process.exit(97), 45_000);
process.on("message", async (message: { action: string; companyId?: string; leaseId?: string }) => {
  try {
    if (message.action === "own") {
      const [owned] = await db.insert(environmentLeases).values({ id: message.leaseId!, companyId: message.companyId!, heartbeatRunId: null,
        status: "active", leasePolicy: "ephemeral", provider: "fake", providerLeaseId: `judge://${message.leaseId}`,
        updatedAt: sql`now()`, metadata: withEnvironmentLeaseController(null) }).returning();
      process.send?.({ kind: "owned", updatedAt: owned!.updatedAt.toISOString(), wakes, lost });
    } else if (message.action === "renew") {
      currentControllerProcessStamp(); await tickControllerInstanceLease();
      process.send?.({ kind: "renewed", wakes, lost });
    } else if (message.action === "quit") {
      clearTimeout(deadline); await work.stop(); await db.$client.end({ timeout: 1 }); process.exit(0);
    }
  } catch (error) { process.send?.({ kind: "error", message: error instanceof Error ? error.message : String(error) }); }
});
process.send?.({ kind: "ready", bootId: currentControllerBootId(), pid: process.pid, processSpace: currentProcessSpaceHash() });
