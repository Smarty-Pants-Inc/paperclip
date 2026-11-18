import { posix } from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { persistActivity } from "../activity-log.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT } from "./remote-runner-recovery-diagnostics.js";

export const SANDBOX_RUNNER_HOLDER_LIST_SCRIPT = [
  "set -eu",
  // B1 fence (b) G1 (from 2edb1a05): this run's own session directory is listed too. A finished run's Runner left
  // there (this run continues its conversation) is classified like any other; this run's own live Runner is
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

/**
 * B1 fence (b), rf-4 shape: a Runner is every process group it RECORDED, not only runnerd.
 *
 * runnerd starts each provider in the provider's own process group (process_supervisor.rs `spawn_command`:
 * `command.process_group(0)`), so signalling runnerd's group leaves the provider alive. runnerd records
 * those groups durably: before any provider starts it calls `process_lineage::enable_journal(state_dir)`
 * (bin/paperclip-runnerd.rs, `run_durable`), which writes `<state-dir>/process-lineage/writer-<pid>.json`;
 * every SupervisedProcess then journals its lineage (`LineageTracker::start` -> `Journal::create`) to
 * `lineage-<pid>-<n>.json`: `groups` [[pgid, leader start ticks]] and `members` [[pid, start ticks]]
 * (process_lineage/journal.rs `JournalRecord`). A journal is removed by runnerd only once that lineage was
 * proven gone (`Journal::retire`).
 *
 * The check below (node, after the marker-verified leader check; $5 the leader's exit code) reads that
 * record read-only and, from one /proc table:
 * - recorded groups: runnerd's own group (pid, its start ticks) and every journalled group. A group
 *   counts while any process is in it that started no earlier than its leader; a group whose leader PID
 *   now names a process with another start time is a reused ID and is never touched.
 * - recorded members: runnerd itself and every journalled member, by PID and exact start ticks (a
 *   no-setsid runnerd that leads no group is signalled by its PID only, never its parent's group).
 * - with a signal: TERM or KILL to each live recorded group and each live recorded member outside one.
 * Exit 0 while any recorded process is left, 45 when none is; 46 a signal failed. 49 unclassifiable:
 * a live runnerd keeps no journal (its writer marker is missing or names another generation), a
 * journal or the marker cannot be read or parsed, or /proc cannot be read. Unclassifiable fails closed.
 * Nothing is written or deleted. Journals of another LIVE writer are that writer's and are skipped.
 * The script is embedded in single quotes: it must not contain a single quote.
 */
export const RECORDED_GROUPS_CHECK_SCRIPT = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [identityPath, rawPid, fingerprint, leaderCode, signal] = process.argv.slice(1);
const pid = Number(rawPid), leaderAlive = leaderCode === "0";
const unclassifiable = reason => { process.stderr.write("runner_recorded_groups_unclassifiable: " + reason + "\n"); process.exit(49); };
const self = new Set([process.pid, process.ppid]);
const stat = p => {
  try {
    const s = fs.readFileSync("/proc/" + p + "/stat", "utf8"), f = s.slice(s.lastIndexOf(") ") + 2).trim().split(/\s+/);
    return { state: f[0], pgrp: Number(f[2]), start: Number(f[19]) };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; unclassifiable("process " + p + " unreadable"); }
};
let entries;
try { entries = fs.readdirSync("/proc"); } catch { unclassifiable("no process table"); }
if (!fs.existsSync("/proc/self/stat")) unclassifiable("no process table");
const table = new Map();
for (const d of entries) { if (String(Number(d)) !== d) continue; const s = stat(d); if (s && s.state !== "Z") table.set(Number(d), s); }
const read = file => {
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; unclassifiable(file + " unreadable"); }
  if (!info.isFile()) unclassifiable(file + " is not a regular file");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; unclassifiable(file + " unreadable"); }
};
const id = v => Number.isSafeInteger(v) && v > 0;
const identity = v => v !== null && typeof v === "object" && id(v.pid) && id(v.started);
const pairs = v => Array.isArray(v) && v.every(e => Array.isArray(e) && e.length === 2 && id(e[0]) && Number.isSafeInteger(e[1]) && e[1] >= 0);
const directory = path.join(path.dirname(identityPath), "process-lineage");
const ticks = /^linux:[-a-fA-F0-9]+:([0-9]+)$/.exec(fingerprint || "");
let writer = read(path.join(directory, "writer-" + pid + ".json"));
if (writer !== null && (writer.schema !== "paperclip.runner.process-lineage-writer.v1" || !identity(writer.writer) || writer.writer.pid !== pid)) unclassifiable("writer marker invalid");
const leader = table.get(pid);
const runnerStart = ticks ? Number(ticks[1]) : leaderAlive && leader ? leader.start : writer ? writer.writer.started : null;
if (writer !== null && runnerStart !== null && writer.writer.started !== runnerStart) {
  if (leaderAlive) unclassifiable("writer marker names another runnerd generation");
  writer = null;
}
if (leaderAlive && writer === null) unclassifiable("the live runnerd keeps no process lineage journal");
const groups = new Map(), members = new Map();
if (runnerStart !== null) { groups.set(pid, runnerStart); members.set(pid, runnerStart); }
let names = [];
try { names = fs.readdirSync(directory); } catch (error) { if (error.code !== "ENOENT") unclassifiable("journal directory unreadable"); }
for (const name of names) {
  if (!name.startsWith("lineage-") || !name.endsWith(".json")) continue;
  const record = read(path.join(directory, name));
  if (record === null) continue;
  if (record.schema !== "paperclip.runner.process-lineage.v1" || !identity(record.writer) || !pairs(record.groups) || !pairs(record.members)
    || (record.root != null && !pairs([record.root]))) unclassifiable(name + " is not a lineage record");
  const own = record.writer.pid === pid && (runnerStart === null || record.writer.started === runnerStart);
  const writerProcess = table.get(record.writer.pid);
  if (!own && writerProcess && writerProcess.start === record.writer.started) continue;
  for (const [g, s] of record.groups) groups.set(g, Math.min(groups.get(g) ?? s, s));
  for (const [p, s] of record.members) members.set(p, s);
  if (record.root != null && record.root[1] !== 0) members.set(record.root[0], record.root[1]);
}
const live = new Set(), liveGroups = new Set(), liveMembers = new Set();
for (const [g, s] of groups) {
  const groupLeader = table.get(g);
  if (groupLeader && groupLeader.start !== s) continue;
  for (const [p, e] of table) if (!self.has(p) && e.pgrp === g && e.start >= s) { live.add(p); liveGroups.add(g); }
}
for (const [p, s] of members) {
  const e = table.get(p);
  if (e && e.start === s && !self.has(p)) { live.add(p); if (!liveGroups.has(e.pgrp)) liveMembers.add(p); }
}
if (signal && live.size > 0) {
  let failed = false;
  const send = target => { try { process.kill(target, "SIG" + signal); } catch (error) { if (error.code !== "ESRCH") failed = true; } };
  for (const g of liveGroups) send(-g);
  for (const p of liveMembers) send(p);
  if (failed) process.exit(46);
}
process.exit(live.size > 0 ? 0 : 45);
`;

const HOLDER_CHECK_SCRIPT = [
  `(${REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT})`,
  "leader=$?",
  // 0 the marker-verified runnerd is alive; 45 it exited; 47 its PID now names another process.
  'case "$leader" in 0|45|47) ;; *) exit "$leader";; esac',
  `exec node -e '${RECORDED_GROUPS_CHECK_SCRIPT}' "$1" "$4" "\${5:-}" "$leader" "\${6:-}"`,
].join("\n");

async function checkHolder(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, label: string,
  signal?: "TERM" | "KILL"): Promise<number | null> {
  const result = await runner.execute({
    command: "sh",
    args: ["-c", HOLDER_CHECK_SCRIPT,
      label, holder.identityPath, holder.nonce, holder.runnerInstanceId, String(holder.pid),
      holder.processStartFingerprint ?? "", ...(signal ? [signal] : [])],
    bypassSession: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  return !result || result.timedOut ? null : result.exitCode;
}

async function probeHolder(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder,
  signal?: "TERM" | "KILL"): Promise<HolderProbe> {
  const exitCode = await checkHolder(runner, holder, "paperclip-runner-port-holder-check", signal);
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

async function waitUntilGone(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, waitMs: number, pollMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const probe = await probeHolder(runner, holder);
    if (probe !== "alive") return probe;
    if (Date.now() >= deadline) return "alive" as const;
    await new Promise(done => setTimeout(done, pollMs));
  }
}

/** TERM, then KILL, every process group and member the Runner recorded (runnerd's and each provider's),
 * each step verified: "gone" only once no member of ANY recorded group is left. */
async function stopRecordedGroups(runner: CommandManagedRuntimeRunner, holder: SandboxRunnerHolder, waitMs: number, pollMs: number) {
  let outcome: "stopped" | "killed" = "stopped";
  let probe = await probeHolder(runner, holder, "TERM");
  if (probe === "alive") probe = await waitUntilGone(runner, holder, waitMs, pollMs);
  if (probe === "alive") {
    outcome = "killed";
    probe = await probeHolder(runner, holder, "KILL");
    if (probe === "alive") probe = await waitUntilGone(runner, holder, waitMs, pollMs);
  }
  return { probe, outcome };
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
      // The server's own close ends runnerd; its providers run in their own groups and may outlive it. Proven
      // gone only when every group the Runner recorded is empty: else TERM then KILL them and verify again.
      let closed = await waitUntilGone(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500);
      if (closed === "alive") closed = (await stopRecordedGroups(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500)).probe;
      if (closed !== "gone") throw unproven("still_running");
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
    // TERM then KILL runnerd and every provider group it recorded; nothing is deleted (the session's
    // journal, state and lineage files stay on disk as its trace).
    const { probe, outcome } = await stopRecordedGroups(input.runner, holder, input.waitMs ?? 10_000, input.pollMs ?? 500);
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
