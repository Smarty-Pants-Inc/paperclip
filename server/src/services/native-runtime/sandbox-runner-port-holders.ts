import { posix } from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { persistActivity } from "../activity-log.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT } from "./remote-runner-recovery-diagnostics.js";

export const SANDBOX_RUNNER_HOLDER_LIST_SCRIPT = [
  "set -eu",
  // B1 fence (b) G1: this run's own session directory is listed too. A finished run's runner left there
  // (this run continues its conversation) is classified like any other; this run's own live runner is
  // excluded by run id in retireSandboxRunnerPortHolders, never by directory.
  'root=$1',
  'test -d "$root/sessions" && test ! -L "$root/sessions" || exit 0',
  'for session in "$root"/sessions/*; do',
  '  test -d "$session" && test ! -L "$session" || continue',
  '  case "${session##*/}" in *.*) continue;; esac',
  '  identity="$session/runner/runner-process.identity"; state="$session/runner/runner-state.json"',
  '  test -f "$identity" && test ! -L "$identity" || continue',
  '  encoded_state=""',
  '  if test -f "$state" && test ! -L "$state"; then encoded_state=$(base64 < "$state" | tr -d "\\n"); fi',
  '  printf "%s\\t%s\\t%s\\n" "$identity" "$(base64 < "$identity" | tr -d "\\n")" "$encoded_state"',
  "done",
].join("\n");

const RETIRABLE_HOLDER_RUN_STATUSES = new Set(["succeeded", "cancelled"]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SandboxRunnerHolder = {
  identityPath: string;
  nonce: string;
  pid: number;
  runnerInstanceId: string;
  processStartFingerprint: string | null;
  runId: string | null;
  idle: boolean;
};

function decode(value: string | undefined): string | null {
  if (!value) return null;
  try { return Buffer.from(value, "base64").toString("utf8"); } catch { return null; }
}

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function parseSandboxRunnerHolders(stdout: string): SandboxRunnerHolder[] {
  const holders: SandboxRunnerHolder[] = [];
  for (const line of stdout.split("\n")) {
    const [identityPath, encodedIdentity, encodedState] = line.split("\t");
    const identity = decode(encodedIdentity)?.trim().split("\n");
    if (!identityPath || !identity) continue;
    const [nonce, rawPid, startedAt, runnerInstanceId, fingerprint] = identity;
    const pid = Number(rawPid);
    if (!nonce || !/^[a-zA-Z0-9_-]+$/.test(nonce) || !Number.isSafeInteger(pid) || pid <= 0 || !startedAt
      || !runnerInstanceId || (fingerprint !== undefined && !/^linux:[0-9a-f-]+:[0-9]+$/.test(fingerprint))) continue;
    const state = parseObject(decode(encodedState));
    const runId = typeof state?.runId === "string" && state.runnerInstanceId === runnerInstanceId ? state.runId : null;
    const idle = state !== null && Array.isArray(state.outbox) && state.outbox.length === 0
      && state.pendingTerminalDelivery === null && state.pendingProviderCleanup == null && state.warmTransition == null;
    holders.push({ identityPath, nonce, pid, runnerInstanceId, processStartFingerprint: fingerprint ?? null, runId, idle });
  }
  return holders;
}

type HolderProbe = "alive" | "gone" | "unproven";

/** B1 fence (b) G2: runnerd is launched by `nohup setsid`, so it leads its own process group (pgid = its pid) and
 * its agent children live in that group. In group mode ($7 = group) a signal goes to the whole group once the
 * marker-verified leader is alive (to the pid alone when it leads no group: the no-setsid launch), and the runner
 * counts as alive while any group member is left, even after the leader exited. The leader-gone remnant group is
 * only signalled inside one reap that verified the leader first: while the group exists its id cannot be reused
 * as a pid. Exit codes are the check script's: 0 alive, 45 gone, anything else unproven. */
const GROUP_TARGET = '"-$4"';
const GROUP_MEMBERS_SCRIPT = String.raw`node -e 'try { process.kill(-Number(process.argv[1]), 0); } catch (error) { process.exit(error.code === "ESRCH" ? 1 : 2); }' "$4"`;
const HOLDER_CHECK_SCRIPT = [
  `(${REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT})`,
  "leader=$?",
  'if test "$leader" = 0; then',
  '  if test -n "${6:-}"; then if test "${7:-}" = group && kill -s 0 -- "-$4" 2>/dev/null; then kill -s "$6" -- ' + GROUP_TARGET + ' || exit 46; else kill -s "$6" "$4" || exit 46; fi; fi',
  "  exit 0",
  "fi",
  'test "$leader" = 45 && test "${7:-}" = group || exit "$leader"',
  `${GROUP_MEMBERS_SCRIPT} && members=0 || members=$?`,
  'test "$members" = 1 && exit 45',
  'test "$members" = 0 || exit 46',
  'if test -n "${6:-}"; then kill -s "$6" -- ' + GROUP_TARGET + " || exit 46; fi",
  "exit 0",
].join("\n");

async function checkHolder(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, label: string,
  signal?: "TERM" | "KILL", group = false): Promise<number | null> {
  const result = await runner.execute({
    command: "sh",
    args: ["-c", HOLDER_CHECK_SCRIPT,
      label, holder.identityPath, holder.nonce, holder.runnerInstanceId, String(holder.pid),
      holder.processStartFingerprint ?? "", signal ?? "", ...(group ? ["group"] : [])],
    bypassSession: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  return !result || result.timedOut ? null : result.exitCode;
}

async function probeHolder(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder,
  signal?: "TERM" | "KILL", group = false): Promise<HolderProbe> {
  const exitCode = await checkHolder(runner, holder, "paperclip-runner-port-holder-check", signal, group);
  if (exitCode === 0) return "alive";
  if (exitCode === 45 || exitCode === 47) return "gone";
  return "unproven";
}

async function listSandboxRunnerHolders(runner: CommandManagedRuntimeRunner, runtimeRoot: string) {
  const listed = await runner.execute({
    command: "sh",
    args: ["-c", SANDBOX_RUNNER_HOLDER_LIST_SCRIPT, "paperclip-runner-port-holders", runtimeRoot],
    bypassSession: true,
    timeoutMs: 15_000,
  }).catch(() => null);
  return { listed, holders: !listed || listed.exitCode !== 0 || listed.timedOut ? null : parseSandboxRunnerHolders(listed.stdout) };
}

function holderSessionDirectory(holder: SandboxRunnerHolder): string {
  return posix.basename(posix.dirname(posix.dirname(holder.identityPath)));
}

export async function sandboxSessionRunnerExited(input: {
  runner: CommandManagedRuntimeRunner;
  runtimeRoot: string;
  sessionDirectory: string;
}): Promise<boolean> {
  const { holders } = await listSandboxRunnerHolders(input.runner, input.runtimeRoot);
  const holder = holders?.find(candidate => holderSessionDirectory(candidate) === input.sessionDirectory);
  return holder !== undefined && await checkHolder(input.runner, holder, "paperclip-runner-exit-check") === 45;
}

export const SANDBOX_SESSION_RUNNER_INSPECT_SCRIPT = [
  "const fs=require('fs'),path=require('path');",
  "const dir=process.argv[1];",
  "const readSafe=f=>{try{if(fs.lstatSync(f).isSymbolicLink())return null;return fs.readFileSync(f,'utf8')}catch{return null}};",
  "let state=null;try{const v=JSON.parse(readSafe(path.join(dir,'runner-state.json')));if(v&&typeof v==='object'&&!Array.isArray(v))state=v}catch{}",
  "const marker=(readSafe(path.join(dir,'runner-process.identity'))||'').split(String.fromCharCode(10));",
  "const runnerId=marker[3]||null,markerPid=/^[1-9][0-9]*$/.test(marker[1]||'')?Number(marker[1]):null;",
  "const str=v=>typeof v==='string'?v:null;",
  "const out={state:state&&{lifecycle:str(state.lifecycle),runId:str(state.runId),normalizedSessionId:str(state.normalizedSessionId),",
  "runnerInstanceId:str(state.runnerInstanceId),settled:Array.isArray(state.outbox)&&state.outbox.length===0&&state.pendingTerminalDelivery==null",
  "&&state.pendingProviderCleanup==null&&state.warmTransition==null},markerPid,",
  "markerRunnerIdMatchesState:runnerId!==null&&state!==null&&state.runnerInstanceId===runnerId,procfs:false,unreadableProcesses:0,processes:[]};",
  "let entries=null;try{entries=fs.readdirSync('/proc')}catch{}",
  "if(entries&&fs.existsSync('/proc/self/cmdline')){out.procfs=true;for(const d of entries){",
  "if(String(Number(d))!==d||Number(d)===process.pid||Number(d)===process.ppid)continue;",
  "let a;try{a=fs.readFileSync('/proc/'+d+'/cmdline','utf8').split(String.fromCharCode(0))}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')out.unreadableProcesses++;continue}",
  "const carries=runnerId!==null&&a.includes('--runner-id')&&a.includes(runnerId);",
  "if(!carries&&(a[0]||'').split('/').pop()!=='paperclip-runnerd')continue;",
  "let st=null;try{const s=fs.readFileSync('/proc/'+d+'/stat','utf8');st=s.slice(s.lastIndexOf(')')+2).split(' ')[0]||null}catch{}",
  "out.processes.push({pid:Number(d),state:st,carriesRunnerId:carries})}}",
  "out.processes.sort((x,y)=>x.pid-y.pid);process.stdout.write(JSON.stringify(out));",
].join("");

export type SandboxSessionRunnerInspection = {
  state: { lifecycle: string | null; runId: string | null; normalizedSessionId: string | null;
    runnerInstanceId: string | null; settled: boolean } | null;
  markerPid: number | null;
  markerRunnerIdMatchesState: boolean;
  procfs: boolean;
  unreadableProcesses: number;
  processes: Array<{ pid: number; state: string | null; carriesRunnerId: boolean }>;
};

export async function inspectSandboxSessionRunner(input: {
  runner: CommandManagedRuntimeRunner;
  stateDirectory: string;
}): Promise<SandboxSessionRunnerInspection | null> {
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", 'exec node -e "$1" "$2"', "paperclip-runner-session-inspect", SANDBOX_SESSION_RUNNER_INSPECT_SCRIPT,
      input.stateDirectory],
    bypassSession: true,
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.timedOut || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as SandboxSessionRunnerInspection;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.processes) ? parsed : null;
  } catch { return null; }
}

async function waitUntilGone(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, waitMs: number, pollMs: number,
  group = false) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const probe = await probeHolder(runner, holder, undefined, group);
    if (probe !== "alive") return probe;
    if (Date.now() >= deadline) return "alive" as const;
    await new Promise(done => setTimeout(done, pollMs));
  }
}

export async function retireSandboxRunnerPortHolders(input: {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
  runner: CommandManagedRuntimeRunner;
  runtimeRoot: string;
  ownSessionRoot: string;
  providerLeaseId: string | null;
  adoptedRunId?: string | null;
  only?: { sessionDirectory: string; runId: string };
  retireInProcess: (holderRunId: string) => Promise<boolean>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}): Promise<string[]> {
  const { listed, holders } = await listSandboxRunnerHolders(input.runner, input.runtimeRoot);
  if (!holders) {
    throw new NativePredecessorRetirementUnprovenError(null, input.providerLeaseId,
      new Error(`runner_port_holder_inventory_unavailable: exit=${listed?.exitCode ?? "none"} timedOut=${listed?.timedOut ?? false}`));
  }
  const retired: string[] = [];
  for (const holder of holders) {
    if (input.only ? holderSessionDirectory(holder) !== input.only.sessionDirectory || holder.runId !== input.only.runId
      : holder.runId === input.runId || (holder.runId !== null && holder.runId === input.adoptedRunId)) continue;
    const initial = await probeHolder(input.runner, holder);
    if (initial === "gone") continue;
    const unproven = (reason: string) => new NativePredecessorRetirementUnprovenError(holder.runId, input.providerLeaseId,
      new Error(`runner_port_holder_${reason}`));
    if (initial === "unproven") throw unproven("unverifiable");
    if (holder.runId && await input.retireInProcess(holder.runId)) {
      if (await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500) !== "gone") throw unproven("still_running");
      retired.push(holder.runId);
      continue;
    }
    if (!holder.runId || !RUN_ID_PATTERN.test(holder.runId)) throw unproven("unknown_owner");
    const [owner] = await input.db.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, holder.runId))).limit(1);
    if (!owner) throw unproven("unknown_owner");
    if (!RETIRABLE_HOLDER_RUN_STATUSES.has(owner.status) || owner.agentId !== input.agentId || !holder.idle) {
      throw unproven("owner_not_settled");
    }
    // TERM then KILL the runner's whole process group; reaped only once no group member is left.
    // Nothing is deleted: the session's journal and state files stay on disk as its trace.
    let outcome: "stopped" | "killed" = "stopped";
    let probe = await probeHolder(input.runner, holder, "TERM", true);
    if (probe === "alive") probe = await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500, true);
    if (probe === "alive") {
      outcome = "killed";
      probe = await probeHolder(input.runner, holder, "KILL", true);
      if (probe === "alive") probe = await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500, true);
    }
    if (probe !== "gone") throw unproven("stop_unconfirmed");
    await persistActivity(input.db, {
      companyId: input.companyId, actorType: "system", actorId: "native-runtime", agentId: input.agentId,
      action: "native.runner_port_holder_retired", entityType: "heartbeat_run", entityId: input.runId, runId: input.runId,
      details: { holderRunId: holder.runId, holderRunnerInstanceId: holder.runnerInstanceId, holderStatus: owner.status, outcome,
        holderInOwnSession: input.ownSessionRoot !== "" && posix.dirname(posix.dirname(holder.identityPath)) === input.ownSessionRoot,
        providerLeaseId: input.providerLeaseId },
    });
    await input.onLog?.("stdout",
      `[paperclip-runner] Stopped the finished run ${holder.runId}'s idle Runner that still held this sandbox's Runner port (${outcome}).\n`)
      .catch(() => undefined);
    retired.push(holder.runId);
  }
  return retired;
}
