import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
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
/** Live registrations; non-zero means "a process heartbeat was registered". */
let registrationCount = 0;
const isRegistered = () => registrationCount > 0;
/** Call sites already warned about a registry miss (warn once per site). */
const warnedSites = new Set<string>();

export function registerProcessHeartbeat(db: Db, heartbeat: Heartbeat): void {
  if (!processHeartbeats.has(db)) registrationCount += 1;
  processHeartbeats.set(db, heartbeat);
}

/**
 * The registered heartbeat for this exact Db object, else undefined (the
 * caller falls back to a bare instance). A miss while a process heartbeat IS
 * registered means the caller holds a different Db object, usually a
 * transaction handle; the root-bound registered heartbeat would sweep/promote
 * OUTSIDE that transaction (stale reads, self-deadlock on the caller's row
 * locks), so it is NOT substituted. The miss is never silent: warn once per
 * call site. `site` is required and must be DISTINCT per call site (warn-once
 * is keyed by it; a shared label would silence every site after the first).
 * Nothing registered (tests that never boot a server): no warn.
 * Never throws: a wrong throw would stop runs.
 */
export function processHeartbeatFor(db: Db, site: string): Heartbeat | undefined {
  const registered = processHeartbeats.get(db);
  if (registered || !isRegistered() || warnedSites.has(site)) return registered;
  warnedSites.add(site);
  logger.warn({ event: "process_heartbeat_registry_miss", site },
    "Heartbeat lookup got a Db object other than the registered one; using a bare heartbeat");
  return undefined;
}

/** Registered process heartbeat, else a bare one (loaded lazily). */
export async function wiredHeartbeatFor(db: Db, site: string): Promise<Heartbeat> {
  const registered = processHeartbeatFor(db, site);
  if (registered) return registered;
  const { heartbeatService } = await import("./heartbeat.js");
  return heartbeatService(db);
}

/** Test seam: forget the registered heartbeat for this database. */
export function clearProcessHeartbeat(db: Db): void {
  if (processHeartbeats.delete(db)) registrationCount -= 1;
  if (!isRegistered()) warnedSites.clear();
}
