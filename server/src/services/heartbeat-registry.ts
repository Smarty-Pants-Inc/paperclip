import type { Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

/**
 * The one heartbeat this server process built with its real wiring (the
 * plugin worker manager in particular). Paths that must start or promote runs
 * from outside a heartbeat closure (issue-lock settlement, the native
 * finalizer's post-commit drain, steering ingestion) use it, so a promoted run
 * is executed by the instance that can reach plugin sandbox workers. A bare
 * `heartbeatService(db)` is only the fallback when nothing is registered
 * (tests that never boot the server).
 */
const processHeartbeats = new WeakMap<Db, Heartbeat>();

export function registerProcessHeartbeat(db: Db, heartbeat: Heartbeat): void {
  processHeartbeats.set(db, heartbeat);
}

export function processHeartbeatFor(db: Db): Heartbeat | undefined {
  return processHeartbeats.get(db);
}

/** Registered process heartbeat, else a bare one (loaded lazily). */
export async function wiredHeartbeatFor(db: Db): Promise<Heartbeat> {
  const registered = processHeartbeats.get(db);
  if (registered) return registered;
  const { heartbeatService } = await import("./heartbeat.js");
  return heartbeatService(db);
}

/** Test seam: forget the registered heartbeat for this database. */
export function clearProcessHeartbeat(db: Db): void {
  processHeartbeats.delete(db);
}
