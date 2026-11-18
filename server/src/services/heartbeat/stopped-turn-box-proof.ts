import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import type { environmentRuntimeService } from "../environment-runtime.js";
import { STOPPED_SESSION_CLOSE_SCHEMA } from "./cancelled-warm-workspace-export.js";

/**
 * adopt-stopu-compose8 (rf-4 00:43Z, row 20, binding): the CRASH path.
 *
 * NSE records the clean close of a stopped warm session
 * (native-session-executor.ts releaseWarmNativeSession -> nativeStoppedSessionClose)
 * and F13 exports nothing without it (cancelled-warm-workspace-export.ts
 * hasCleanStoppedSessionClose). When the SERVER crashed after the durable
 * cancel and before that record, the proof can never arrive from NSE, but the
 * box is alive. So the proof is established after the fact, on the box, with
 * one bounded command over the existing runner command path
 * (target.runner.execute, bypassSession, as sandbox-runner-port-holders.ts
 * inspectSandboxSessionRunner): every process whose environment carries the
 * stopped turn's PAPERCLIP_RUN_ID (set by the Runner for the turn and inherited
 * by its tools: packages/paperclip-runner configured-environment.ts) is killed,
 * its whole process group when the group is the turn's alone, and the scan is
 * repeated until none remain.
 */
export const STOPPED_TURN_KILL_AND_VERIFY_SCRIPT = [
  "const fs=require('fs');const runId=process.argv[1];const NUL=String.fromCharCode(0);",
  "const self=new Set([process.pid,process.ppid]);",
  "function scan(){let entries;try{entries=fs.readdirSync('/proc')}catch{return null}",
  "if(!fs.existsSync('/proc/self/stat'))return null;const all=[];let unreadable=0;",
  "for(const d of entries){if(String(Number(d))!==d)continue;const pid=Number(d);if(self.has(pid))continue;",
  "let st;try{const s=fs.readFileSync('/proc/'+d+'/stat','utf8');st=s.slice(s.lastIndexOf(')')+2).split(' ')}catch{continue}",
  "if(st[0]==='Z'||st[0]==='X')continue;let env=null;",
  "try{env=fs.readFileSync('/proc/'+d+'/environ','utf8').split(NUL)}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')unreadable++}",
  "all.push({pid,pgid:Number(st[2]),turn:env!==null&&env.includes('PAPERCLIP_RUN_ID='+runId)})}",
  "return{all,unreadable}}",
  "const first=scan();if(!first){process.stdout.write(JSON.stringify({procfs:false}));process.exit(2)}",
  "const turn=first.all.filter(p=>p.turn);const groups=[...new Set(turn.map(p=>p.pgid))]",
  ".filter(g=>g>1&&first.all.every(p=>p.pgid!==g||p.turn));const killedGroups=[],killedPids=[];",
  "for(const g of groups){try{process.kill(-g,'SIGKILL');killedGroups.push(g)}catch{}}",
  "for(const p of turn){try{process.kill(p.pid,'SIGKILL');killedPids.push(p.pid)}catch{}}",
  "const until=Date.now()+2000;let last=first;",
  "const done=()=>{const remaining=last.all.filter(p=>p.turn).map(p=>p.pid);",
  "process.stdout.write(JSON.stringify({procfs:true,found:turn.map(p=>p.pid),killedGroups,killedPids,remaining,unreadable:last.unreadable}));",
  "process.exit(remaining.length?3:0)};",
  "const tick=()=>{last=scan()||last;if(!last.all.some(p=>p.turn)||Date.now()>=until)return done();setTimeout(tick,100)};",
  "turn.length?setTimeout(tick,50):done();",
].join("");

export type StoppedTurnBoxProof =
  | { outcome: "proven"; found: number[]; killedGroups: number[]; killedPids: number[]; unreadable: number }
  /** The box answered, but the turn's processes are not proven gone. */
  | { outcome: "not_proven"; reason: string }
  /** The box did not answer within the bound (by line: target / command). */
  | { outcome: "unanswered"; reason: "box_unreachable_target" | "box_unreachable_probe" };

/** The crash path: NSE never recorded the stopped session's close (neither
 * clean nor failed), and nothing owns the run any more (its controller lease
 * expired and no live finalization owner), so that record can never arrive. */
export async function stoppedTurnCloseOwedAfterCrash(db: Db, run: typeof heartbeatRuns.$inferSelect,
  now: number): Promise<boolean> {
  const profile = run.runnerProfileJson as Record<string, unknown> | null | undefined;
  if (profile?.nativeStoppedSessionClose != null) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > now) return false;
  const [finalization] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner,
    leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId))).limit(1);
  return !(finalization?.leaseOwner && finalization.leaseExpiresAt && finalization.leaseExpiresAt.getTime() > now);
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<"timed_out">(resolve => { timer = setTimeout(() => resolve("timed_out"), ms); timer.unref?.(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One bounded command on the kept box (target resolution included in the
 * bound, as the bound's own reachability probe). */
export async function proveStoppedTurnGoneOnBox(input: {
  db: Db;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
  run: typeof heartbeatRuns.$inferSelect;
  lease: typeof environmentLeases.$inferSelect;
  environment: typeof environments.$inferSelect | undefined;
  timeoutMs: number;
}): Promise<StoppedTurnBoxProof> {
  const { db, run, lease, environment, environmentRuntime, timeoutMs } = input;
  let stage: "box_unreachable_target" | "box_unreachable_probe" = "box_unreachable_target";
  const attempt = async (): Promise<StoppedTurnBoxProof> => {
    if (!environment) return { outcome: "unanswered", reason: "box_unreachable_target" };
    const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
      environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never, environmentRuntime })
      .catch(() => null);
    if (!target || target.kind !== "remote" || !("runner" in target) || !target.runner)
      return { outcome: "unanswered", reason: "box_unreachable_target" };
    stage = "box_unreachable_probe";
    const result = await target.runner.execute({ command: "sh",
      args: ["-c", 'exec node -e "$1" "$2"', "paperclip-stopped-turn-kill", STOPPED_TURN_KILL_AND_VERIFY_SCRIPT, run.id],
      cwd: "/", bypassSession: true, timeoutMs }).catch(() => null);
    if (!result || result.timedOut) return { outcome: "unanswered", reason: "box_unreachable_probe" };
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(String(result.stdout ?? "").trim()) as Record<string, unknown>; } catch { parsed = null; }
    if (result.exitCode !== 0 || !parsed || parsed.procfs !== true || !Array.isArray(parsed.remaining) || parsed.remaining.length)
      return { outcome: "not_proven", reason: `stopped_turn_kill_unproven: exit=${result.exitCode} ${String(result.stdout ?? "").slice(0, 200)}` };
    const ints = (value: unknown) => Array.isArray(value) ? value.filter((v): v is number => Number.isSafeInteger(v)) : [];
    return { outcome: "proven", found: ints(parsed.found), killedGroups: ints(parsed.killedGroups),
      killedPids: ints(parsed.killedPids), unreadable: Number(parsed.unreadable) || 0 };
  };
  const outcome = await bounded(attempt(), timeoutMs);
  // By line: the bound passed while resolving the box (target) or while the
  // command ran on it (probe).
  return outcome === "timed_out" ? { outcome: "unanswered", reason: stage } : outcome;
}

/** Record the after-the-fact proof exactly where NSE records its clean close
 * (runnerProfileJson.nativeStoppedSessionClose, same schema and identity), so
 * hasCleanStoppedSessionClose accepts it. Never overwrites an NSE record. */
export async function recordStoppedTurnCloseProof(db: Db, run: typeof heartbeatRuns.$inferSelect,
  proof: Extract<StoppedTurnBoxProof, { outcome: "proven" }>): Promise<boolean> {
  const closeRecord = { schema: STOPPED_SESSION_CLOSE_SCHEMA, companyId: run.companyId, issueId: run.nativeIssueId,
    runId: run.id, sessionId: run.nativeSessionId ?? null, clean: true, via: "box_stopped_turn_kill_after_crash",
    found: proof.found, killedGroups: proof.killedGroups, killedPids: proof.killedPids, remaining: [],
    unreadableProcesses: proof.unreadable, at: new Date().toISOString() };
  const updated = await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
    || ${JSON.stringify({ nativeStoppedSessionClose: closeRecord })}::jsonb` }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ? 'nativeStoppedSessionClose')`))
    .returning({ id: heartbeatRuns.id });
  return updated.length === 1;
}
