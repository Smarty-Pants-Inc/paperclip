import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * Marker, under an instance root, that this instance's database has recorded a
 * heartbeat run. Some runs end with run rows and heartbeat_run_events but no
 * data/run-logs file (for example a run cancelled before start, a run that fails
 * setup, or a conversation reset). The worktree-instance reaper keeps an instance
 * whose embedded DB directory holds data AND that has this marker, so those DB
 * traces are never deleted with the instance root, and it never queries the DB
 * to decide (R-keep-all-traces, never-OK).
 */
export const INSTANCE_HEARTBEAT_RUN_MARKER = path.join("data", "heartbeat-runs-recorded");

const written = new Map<string, Promise<void>>();

/**
 * Write the marker once per instance root per process, before the first run
 * row or run event that may outlive a run log. Best effort: a failure is logged
 * and retried on the next call; it never fails the run write.
 */
export async function markInstanceHasHeartbeatRuns(instanceRoot = resolvePaperclipInstanceRoot()): Promise<void> {
  const file = path.join(instanceRoot, INSTANCE_HEARTBEAT_RUN_MARKER);
  let pending = written.get(file);
  if (!pending) {
    pending = (async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    })();
    written.set(file, pending);
  }
  try {
    await pending;
  } catch (error) {
    written.delete(file);
    logger.warn({ err: error, file }, "could not write the instance heartbeat-run marker");
  }
}
