/**
 * adopt-stopu-proof: the process-gone proof for a person-stopped turn, AT the
 * export. Same name/signature as ugate2's (`noStoppedTurnProcessRemains(box,
 * turnStartedAt)`, al/fam-stopu-ugate) so that one can replace this one.
 *
 * Through the box's existing command path (the Runner's `execute`), read the
 * box's process table (/proc): every process working in the task workspace
 * (cwd under the box's remoteCwd) that started at or after the turn start,
 * except the Runner itself (the check's own ancestor chain), the
 * check's own helpers and a retained Pi RPC session (its idle receipt proves
 * it has no active turn), is sent TERM, then KILL, bounded, and must be gone.
 * This catches the turn's foreground command and an escaped (re-parented)
 * writer. Any doubt (no box, no turn start, a command failure, a timeout, a
 * survivor) is `false`: not proven. Limit: a writer that left the workspace
 * directory (cwd elsewhere) is not seen; the cwd scope keeps the check from
 * touching anything that is not the task's (a shared host, the Runner).
 */
export type StoppedTurnBox = {
  runner: {
    execute(input: { command: string; args?: string[]; cwd?: string; timeoutMs?: number; stdin?: string;
      env?: Record<string, string> }): Promise<{ exitCode: number | null; timedOut?: boolean; stdout?: string }>;
  };
  remoteCwd?: string;
};

export const STOPPED_TURN_PROCESS_CHECK_TIMEOUT_MS = 10_000;
export const STOPPED_TURN_PROCESS_GONE_MARKER = "paperclip-stopped-turn-processes-gone";

// POSIX sh; /proc only (no ps dependency). $1 = turn start (epoch seconds).
const SCRIPT = String.raw`
T="$1"; KEEP="$2"; ROOT="$3"
case "$ROOT" in /*) ;; *) echo "no workspace root"; exit 4;; esac
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || { echo "no workspace root"; exit 4; }
bt=$(sed -n 's/^btime //p' /proc/stat); hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
anc=" $$ "; p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do
  p=$(sed -n 's/^PPid:[[:space:]]*//p' /proc/$p/status 2>/dev/null); [ -n "$p" ] && anc="$anc$p "
done
newer() {
  for d in /proc/[0-9]*; do
    pid=${"$"}{d#/proc/}
    case "$anc" in *" $pid "*) continue;; esac
    pp=$(sed -n 's/^PPid:[[:space:]]*//p' "$d/status" 2>/dev/null) || continue
    [ -z "$pp" ] && continue; [ "$pp" = "2" ] && continue
    # the check's own helpers (any process descending from this shell)
    own=0; q=$pp; n=0
    while [ -n "$q" ] && [ "$q" -gt 1 ] && [ $n -lt 64 ]; do
      [ "$q" = "$$" ] && { own=1; break; }
      q=$(sed -n 's/^PPid:[[:space:]]*//p' /proc/$q/status 2>/dev/null); n=$((n+1))
    done
    [ $own = 1 ] && continue
    c=$(readlink "$d/cwd" 2>/dev/null) || continue
    case "$c/" in "$ROOT"/*) ;; *) continue;; esac
    st=$(sed 's/^.*) //' "$d/stat" 2>/dev/null | cut -d' ' -f20) || continue
    [ -z "$st" ] && continue
    [ $((bt + st / hz)) -lt "$T" ] && continue
    if [ "$KEEP" = "retained" ] && tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -q -- '--mode rpc'; then continue; fi
    printf '%s ' "$pid"
  done
}
left=$(newer)
[ -n "$left" ] && kill -TERM $left 2>/dev/null
i=0; while [ $i -lt 20 ]; do left=$(newer); [ -z "$left" ] && break; sleep 0.1; i=$((i+1)); done
[ -n "$left" ] && kill -KILL $left 2>/dev/null
i=0; while [ $i -lt 30 ]; do left=$(newer); [ -z "$left" ] && break; sleep 0.1; i=$((i+1)); done
if [ -n "$left" ]; then echo "remaining: $left"; exit 3; fi
echo ${STOPPED_TURN_PROCESS_GONE_MARKER}
`;

export async function noStoppedTurnProcessRemains(box: StoppedTurnBox | null | undefined,
  turnStartedAt: Date | string | null | undefined, options?: { retainedSession?: boolean; timeoutMs?: number }): Promise<boolean> {
  if (!box?.runner || !turnStartedAt) return false;
  const startedMs = new Date(turnStartedAt).getTime();
  if (!Number.isFinite(startedMs)) return false;
  const timeoutMs = options?.timeoutMs ?? STOPPED_TURN_PROCESS_CHECK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = box.runner.execute({ command: "sh", args: ["-c", SCRIPT, "stopped-turn-check",
      String(Math.floor(startedMs / 1000)), options?.retainedSession ? "retained" : "closed", box.remoteCwd ?? ""],
    cwd: box.remoteCwd, timeoutMs });
    run.catch(() => undefined);
    const result = await Promise.race([run, new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs + 1_000); timer.unref?.(); })]);
    return !!result && result.exitCode === 0 && !result.timedOut
      && (result.stdout ?? "").includes(STOPPED_TURN_PROCESS_GONE_MARKER);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
