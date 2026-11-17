import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "./execution-control-work.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { reconcileRetainedWorkspaces, type PassiveSweep } from "./workspace-recovery.js";
import { nextWorkspaceRecoveryAt, OWED_RESTORE_HOLD_RECHECK_MS } from "./system-recovery.js";

export function registerWorkspaceRecoveryWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  runtime: EnvironmentRuntimeService, onRecovered: Parameters<typeof reconcileRetainedWorkspaces>[2],
  canRun: () => boolean = () => true) {
  const pending = new Set<Promise<void>>();
  let stopped = false;
  let scan: Promise<void> | undefined;
  let wakeWhileBusy = false;
  const passiveSweep: PassiveSweep = {};
  const schedule = executionControlSchedule(db);
  // restore-card8 item 4 (rf-3 J1): an idle worker (nothing scheduled) keeps the
  // owed-hold re-check period (OWED_RESTORE_HOLD_RECHECK_MS) armed, so a hold
  // written while it is idle whose wake was lost is found within one period. That
  // tick, with no wake since, first runs the bounded due check the worker already
  // uses (nextWorkspaceRecoveryAt: limit-1 reads, the unadopted one on the
  // adoption partial index) and scans only when it finds owed or due work.
  let idleRecheck = false, wokenSinceIdle = false;
  const wake = () => { wokenSinceIdle = true; worker.wake(); };
  const worker = registerExecutionControlWork(coordinator, [{
    queue: DELIVERY_QUEUES.workspaceRecovery,
    onSettled: () => { wokenSinceIdle = true; passiveSweep.restart = true; if (pending.size >= 2) wakeWhileBusy = true; },
    run: () => scan = (async () => {
      const recheckOnly = idleRecheck && !wokenSinceIdle;
      idleRecheck = false; wokenSinceIdle = false;
      if (recheckOnly && await nextWorkspaceRecoveryAt(db) === null) return;
      const sweep = passiveSweep, cursor = sweep.cursor;
      const work = await reconcileRetainedWorkspaces(db, runtime, onRecovered, true, continueSweep => {
        if (!stopped && (continueSweep || wakeWhileBusy)) { wakeWhileBusy = false; wake(); }
      }, sweep);
      if (sweep.restart && !sweep.complete && sweep.cursor !== cursor && !stopped) wake();
      for (const job of work ?? []) {
        pending.add(job);
        const settled = () => { pending.delete(job); };
        void job.then(settled, settled);
      }
    })(),
    next: async () => {
      if (pending.size >= 2) return null;
      const at = await schedule.workspaceRecovery();
      idleRecheck = at === null;
      return at ?? Date.now() + OWED_RESTORE_HOLD_RECHECK_MS;
    },
  }], () => !stopped && canRun());
  return { ready: worker.ready, async stop() {
    stopped = true;
    await scan?.catch(() => {});
    await Promise.all(pending);
  } };
}
