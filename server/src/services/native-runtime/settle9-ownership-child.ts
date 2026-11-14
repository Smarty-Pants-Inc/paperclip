// Separate controller process. Only a disposable test PostgreSQL is used.
import { createDb } from '@paperclipai/db';
import { sql } from 'drizzle-orm';
import { environmentService } from '../environments.js';
import { currentControllerBootId, currentControllerProcessStamp, currentProcessSpaceHash } from '../controller-process-identity.js';
import { registerControllerInstanceLeaseWork, tickControllerInstanceLease } from '../controller-instance-lease.js';
import { renewNativeSessionExecutionLease, assertNativeSessionPreparationAuthority } from './native-execution-lease.js';
import type { createDeliveryWorkCoordinator } from '../delivery-work-coordinator.js';
const db = createDb(process.env.SETTLE9_TEST_DB!);
const lost: string[] = [];
const coordinator = { register: () => ({ ready: Promise.resolve(), wake: () => {}, stop: async () => {} }) } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
const work = registerControllerInstanceLeaseWork(db, coordinator, { onLost: reason => lost.push(reason) });
const deadline = setTimeout(() => process.exit(97), 60000);
process.on('message', async (m: { action: string; companyId: string; runId: string; issueId: string; environmentId: string; leaseOwner: string; attempt: number }) => {
  try {
    if (m.action === 'quit') { clearTimeout(deadline); await work.stop(); await db.$client.end({timeout: 1}); process.exit(0); }
    if (m.action === 'acquire') {
      const lease = await environmentService(db).acquireLease({ companyId: m.companyId, environmentId: m.environmentId, heartbeatRunId: m.runId, provider: 'fake' });
      process.send?.({kind: 'acquired', leaseId: lease.id});
    } else if (m.action === 'renew') {
      await renewNativeSessionExecutionLease({db, runId: m.runId, companyId: m.companyId, issueId: m.issueId,
        leaseOwner: m.leaseOwner, attempt: m.attempt});
      process.send?.({kind: 'renewed'});
    } else if (m.action === 'start') {
      await assertNativeSessionPreparationAuthority({db, companyId: m.companyId, runId: m.runId, leaseOwner: m.leaseOwner});
      process.send?.({kind: 'execution-admitted'});
    } else if (m.action === 'controller-renew') {
      currentControllerProcessStamp(); await tickControllerInstanceLease(); process.send?.({kind: 'controller-renewed', lost});
    } else if (m.action === 'backend') {
      const [row] = await db.execute(sql`select pg_backend_pid() as pid`); process.send?.({kind:'backend', pid: row!.pid});
    }
  } catch (error) { process.send?.({kind: 'refused', message: error instanceof Error ? error.message : String(error)}); }
});
process.send?.({kind: 'ready', bootId: currentControllerBootId(), pid: process.pid, processSpace: currentProcessSpaceHash()});
