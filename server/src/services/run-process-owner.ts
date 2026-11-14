import { execFile } from "node:child_process";
import type { heartbeatRuns } from "@paperclipai/db";
import { proveOwnerGone, type LocalOwnerStamp, type OwnerProof, type ProcessProbe } from "./owner-proof.js";
import { runProcessOwnerStamp } from "./native-runtime/native-owner-stamps.js";

/** The process identity a heartbeat run records for its adapter child
 * (`persistHeartbeatRunProcessMetadata`). */
export type RunProcessIdentity = Pick<typeof heartbeatRuns.$inferSelect,
  "processPid" | "processGroupId" | "processStartedAt" | "processHostHash">;

/**
 * The owner stamp the lost-process reapers judge a run's adapter child by.
 *
 * It is the shared `runProcessOwnerStamp` (native-owner-stamps.ts) with the
 * one-release local proof for rows saved before `process_host_hash` (#19871,
 * #19883; single-host servers only). A row that recorded only a process group
 * is judged by that group: its leader's PID is the group id. The active
 * execution reaper, the orphan sweep and hot-restart adoption all read it, so
 * they reach one verdict for one row.
 *
 * Returns null when the run recorded no process.
 */
export function lostProcessOwnerStamp(run: RunProcessIdentity, scope: string): LocalOwnerStamp | null {
  const pid = run.processPid ?? run.processGroupId ?? null;
  if (pid === null) return null;
  return runProcessOwnerStamp({ ...run, processPid: pid }, scope, { legacyFallback: true });
}

/** Proves whether a run's adapter child is gone. Null when no process was
 * recorded. `unprovable` never releases the run: its operator action is Stop. */
export async function proveRunProcessGone(run: RunProcessIdentity, scope: string,
  probe?: ProcessProbe): Promise<OwnerProof | null> {
  const stamp = lostProcessOwnerStamp(run, scope);
  return stamp ? proveOwnerGone(stamp, probe) : null;
}

/** Positive, same-host process-table read for the spawn/persist crash window.
 * Runner argv AND inherited run attribution are checked: an adapter child need
 * not be runnerd and may have no persisted PID yet. No diagnostics escape this
 * proof (the listing includes environments). A failed/unsupported read is not
 * an empty owner set. Remote/foreign-host launches need their own proof.
 */
export async function noLocalRunnerProcessesForRuns(runIds: readonly string[]): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const listing = await new Promise<string | null>(resolve => {
    execFile("ps", ["-axeww", "-o", "command="], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
  return listing !== null && !listing.split("\n").some(line => runIds.some(id =>
    line.includes(`--run-id ${id}`) || line.includes(`PAPERCLIP_RUN_ID=${id}`)));
}
