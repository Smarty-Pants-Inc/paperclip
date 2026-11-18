import { readFileSync } from "node:fs";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

/**
 * adopt-stopu-ugate (rf-4 + RFL 00:50Z, binding): the ONE proof that no process
 * of a person-stopped turn can still write the box's workspace.
 *
 * NSE's clean-close record (nativeStoppedSessionClose.clean) proves only that
 * Pi's close ladder completed for the turn's own process groups; an escaped or
 * daemonised child (setsid / nohup) survives it (LOCAL Pi, x3). On Boat the
 * Runner's suspension barrier (runnerd-codex-transport.ts finishClose,
 * runnerSuspended / runnerLossReaped) is never surfaced to the server: the
 * only server-visible trace is the close not throwing, so it is not a receipt.
 * This check is therefore required before the CLOSED-case export everywhere.
 *
 * By the box's process table (/proc on the box, through the box's existing
 * command path CommandManagedRuntimeRunner.execute): every process that
 * started at or after the turn start, other than this check's own chain (the
 * runner/exec agent that runs it) and kernel threads, is SIGKILLed (bounded:
 * NO_STOPPED_TURN_PROCESS_KILL_ROUNDS) and the table is read again; proven
 * only when none remain. A box that shares the controller's kernel (same
 * boot_id: a local/test box) is scoped to processes whose cwd or an open fd is
 * inside the workspace, so the controller's own processes are never touched.
 * Any failure to run or read (unreachable box, no /proc, timeout) is NOT proof.
 *
 * compose8's crash-path command is switched to this at the merge.
 */
export type StoppedTurnBox = { runner: Pick<CommandManagedRuntimeRunner, "execute">; remoteCwd: string };
export type StoppedTurnProcessProof =
  | { proven: true; killed: string[]; scoped: boolean }
  | { proven: false; detail: string; remaining?: string[] };

export const NO_STOPPED_TURN_PROCESS_TIMEOUT_MS = 15_000;
export const NO_STOPPED_TURN_PROCESS_KILL_ROUNDS = 10;
/** Box-clock tolerance: a process started up to this long before the recorded turn start still counts. */
export const NO_STOPPED_TURN_PROCESS_CLOCK_SLACK_MS = 2_000;

const SCRIPT = String.raw`
T=$1; ROOT=$2; CB=$3; ROUNDS=$4; KEEP=$5; RID=$6
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || { echo "ERR no_workspace"; exit 5; }
BID=; read -r BID < /proc/sys/kernel/random/boot_id 2>/dev/null
SCOPED=0; [ -n "$CB" ] && [ "$BID" = "$CB" ] && SCOPED=1
HZ=$(getconf CLK_TCK 2>/dev/null) || HZ=100; [ -n "$HZ" ] || HZ=100
BT=; while read -r k v rest; do [ "$k" = btime ] && BT=$v; done < /proc/stat
[ -n "$BT" ] || { echo "ERR no_proc"; exit 4; }
SELF=$$; ANC=" "; p=$$
while [ -n "$p" ] && [ "$p" -gt 0 ] 2>/dev/null; do
  ANC="$ANC$p "; [ "$p" = 1 ] && break
  st=; read -r st < /proc/$p/stat 2>/dev/null || break; r=\${st##*) }; set -- $r; p=$2
done
RUNNER=" "; for a in $ANC; do [ "$a" = 1 ] || RUNNER="$RUNNER$a "; done
inroot() { case "$1" in "$ROOT"|"$ROOT"/*) return 0;; esac; return 1; }
marked() { [ -n "$RID" ] && tr '\0' '\n' < "$1/environ" 2>/dev/null | grep -qx "PAPERCLIP_RUN_ID=$RID"; }
runnerchild() {
  q=$1; n=0
  while [ -n "$q" ] && [ "$q" -gt 1 ] 2>/dev/null && [ $n -lt 64 ]; do
    case "$RUNNER" in *" $q "*) return 0;; esac
    st=; read -r st < /proc/$q/stat 2>/dev/null || return 1; r=\${st##*) }; set -- $r; q=$2; n=$((n+1))
  done
  return 1
}
scan() {
  FOUND=
  for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    case "$ANC" in *" $pid "*) continue;; esac
    st=; read -r st < $d/stat 2>/dev/null || continue
    r=\${st##*) }; set -- $r
    [ "$1" = Z ] && continue
    [ "$pid" = 2 ] && continue; [ "$2" = 2 ] && continue
    [ "$2" = "$SELF" ] && continue
    start=$((BT + \${20} / HZ))
    [ "$start" -lt "$T" ] && continue
    if [ "$KEEP" = retained ] && tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -q -- '--mode rpc'; then continue; fi
    hit=0; c=$(readlink "$d/cwd" 2>/dev/null) && inroot "$c" && hit=1
    if [ "$hit" = 0 ]; then for f in "$d"/fd/*; do l=$(readlink "$f" 2>/dev/null) && inroot "$l" && { hit=1; break; }; done; fi
    if [ "$SCOPED" = 1 ]; then
      [ "$hit" = 1 ] || marked "$d" || continue
    else
      # whole box: the turn's own (PAPERCLIP_RUN_ID of this run, inherited by
      # escaped children), or a workspace process that did NOT come from the
      # runner's own process chain (runnerd / the exec agent / the export's
      # own tar or sync are descendants of this check's ancestors and carry no
      # turn id): those survive.
      if marked "$d"; then :; elif [ "$hit" = 1 ] && ! runnerchild "$2"; then :; else continue; fi
    fi
    FOUND="$FOUND $pid"
  done
}
KILLED=; i=0; scan
if [ -n "$FOUND" ]; then for k in $FOUND; do kill -TERM "$k" 2>/dev/null && KILLED="$KILLED $k"; done; sleep 0.2; scan; fi
while [ -n "$FOUND" ] && [ "$i" -lt "$ROUNDS" ]; do
  for k in $FOUND; do kill -KILL "$k" 2>/dev/null && KILLED="$KILLED $k"; done
  sleep 0.2; i=$((i+1)); scan
done
if [ -n "$FOUND" ]; then echo "REMAIN$FOUND"; exit 3; fi
echo "NONE scoped=$SCOPED killed=$KILLED"
`.replace(/\\\$/g, "$");

let controllerBootId: string | null | undefined;
function readControllerBootId(): string {
  if (controllerBootId === undefined) {
    try { controllerBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; }
    catch { controllerBootId = null; }
  }
  return controllerBootId ?? "";
}

export async function noStoppedTurnProcessRemains(box: StoppedTurnBox | null | undefined,
  turnStartedAt: Date | string | null | undefined, options?: {
    timeoutMs?: number;
    /** NSE retained the warm session: its Pi RPC process (--mode rpc) is spared. */
    retainedSession?: boolean;
    /** The stopped run: processes carrying its PAPERCLIP_RUN_ID are the turn's. */
    runId?: string;
    bypassSession?: boolean;
  }): Promise<StoppedTurnProcessProof> {
  if (!box?.runner || !box.remoteCwd) return { proven: false, detail: "no_box_command_path" };
  const startedMs = turnStartedAt ? new Date(turnStartedAt).getTime() : NaN;
  if (!Number.isFinite(startedMs)) return { proven: false, detail: "turn_start_unknown" };
  const since = Math.floor((startedMs - NO_STOPPED_TURN_PROCESS_CLOCK_SLACK_MS) / 1000);
  const result = await box.runner.execute({ command: "sh", args: ["-c", SCRIPT, "sh", String(since), box.remoteCwd,
    readControllerBootId(), String(NO_STOPPED_TURN_PROCESS_KILL_ROUNDS),
    options?.retainedSession ? "retained" : "closed", options?.runId ?? ""], cwd: box.remoteCwd,
    timeoutMs: options?.timeoutMs ?? NO_STOPPED_TURN_PROCESS_TIMEOUT_MS,
    ...(options?.bypassSession ? { bypassSession: true } : {}) } as Parameters<StoppedTurnBox["runner"]["execute"]>[0]).catch((error: unknown) => ({
    exitCode: -1, timedOut: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  const out = String(result.stdout ?? "").trim().split("\n").pop() ?? "";
  if (result.exitCode === 0 && !result.timedOut && out.startsWith("NONE ")) {
    const scoped = /scoped=1/.test(out);
    const killed = (out.split("killed=")[1] ?? "").trim().split(/\s+/).filter(Boolean);
    return { proven: true, killed, scoped };
  }
  if (out.startsWith("REMAIN")) return { proven: false, detail: "stopped_turn_process_remains",
    remaining: out.slice("REMAIN".length).trim().split(/\s+/).filter(Boolean) };
  return { proven: false, detail: (result.timedOut ? "process_check_timed_out"
    : `process_check_failed:${out || String(result.stderr ?? "").trim()}`).slice(0, 300) };
}
