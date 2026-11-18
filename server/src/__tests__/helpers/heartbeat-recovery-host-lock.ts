import { spawn } from "node:child_process";

export const HEARTBEAT_RECOVERY_HOST_LOCK_WAIT_MS = 30 * 60 * 1000;
const lockPath = "/tmp/paperclip-heartbeat-recovery.lock";

/** Hold flock until teardown (or the worker dies and closes the stdin pipe). */
export async function acquireHeartbeatRecoveryHostLock(): Promise<() => Promise<void>> {
  console.info(`[heartbeat recovery] waiting for host lock ${lockPath} (up to 30 min)`);
  const child = spawn("flock", [
    "--exclusive", "--timeout", "1800", "--conflict-exit-code", "75",
    "--no-fork", lockPath, "sh", "-c", "printf 'locked\\n'; cat >/dev/null",
  ], { stdio: ["pipe", "pipe", "inherit"] });
  // A failed spawn/early exit can close stdin before teardown gets to it.
  child.stdin.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal?: string | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const acquired = await Promise.race([
    new Promise<true>((resolve) => child.stdout.once("data", () => resolve(true))),
    exited.then(() => false as const),
  ]);
  if (!acquired) {
    child.stdin.end();
    const result = await exited;
    throw new Error(result.code === 75
      ? `Timed out after 30 min waiting for host lock ${lockPath}`
      : `Could not acquire host lock ${lockPath}: ${result.error?.message ?? `exit ${result.code}, signal ${result.signal}`}`);
  }
  console.info(`[heartbeat recovery] acquired host lock ${lockPath}`);
  return async () => {
    child.stdin.end();
    const result = await exited;
    if (result.code !== 0) {
      throw new Error(`Host lock ${lockPath} holder exited unexpectedly: ${result.error?.message ?? `exit ${result.code}, signal ${result.signal}`}`);
    }
    console.info(`[heartbeat recovery] released host lock ${lockPath}`);
  };
}
