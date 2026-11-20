import { notifyInstructionCollection } from "./instruction-collection-notifications.js";
import { instructionCopyRetryAt } from "./instruction-copy-retry.js";
import { notifyDirectoryCleanup } from "./directory-cleanup-notifications.js";
import { notifyEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { AGENT_FILES_SAVE_PENDING_INSTRUCTION, agentFileHoldWriteCondition, pinLeaseForCollection, unpinLeaseForCollection } from "./agent-file-save-hold.js";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { agents, heartbeatRuns, environmentLeases, environments, agentInstructionWorkingCopies as copies, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { syncDirectoryToSsh, restoreWorkspaceFromSshExecution } from "@paperclipai/adapter-utils/ssh";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget, type PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { withDirectoryMergeLock, directorySnapshotSha256, parseDirectorySnapshot, serializeDirectorySnapshot, type DirectoryMergeLockOperation, type DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { createHash, randomUUID } from "node:crypto";
import { AGENT_FILES_CONTRACT, AgentFileLimitError, agentFileStore, agentStorageWarning, inspectAgentDirectory, type AgentFileConflict } from "./agent-file-store.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { excludeAgentRuntimeFromGit } from "./agent-instruction-git-exclusion.js";
import { resolveInstructionActor } from "./agent-instruction-authorization.js";
import { HttpError, conflict, notFound } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { agentDirectoryBaselineDigest, agentDirectoryProbeProgram, observeLocalAgentDirectory } from "./agent-directory-probe.js";
import { hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "./remote-execution-termination.js";
import { cachedAgentFileManifest, captureAgentFileCheckpoint, checkpointBaseline, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";
import { logger } from "../middleware/logger.js";
import { crashPoint } from "@paperclipai/shared/crash-points";

type Copy = typeof copies.$inferSelect;
function adoptionAuthority(row: Copy) {
  const { updatedAt: _updatedAt, nextAttemptAt: _nextAttemptAt, ...authority } = row;
  return authority;
}

export class AgentDirectoryReuseInvalidatedError extends Error {}
export class AgentDirectoryOperationBusyError extends HttpError {
  constructor() { super(409, "Agent directory operation is already active"); }
}
const completed = new Set(["saved", "unchanged", "resolved"]);
/** The one instruction shown while a stopped agent-file save is unverified. */
export { AGENT_FILES_SAVE_PENDING_INSTRUCTION };
/** A stopped save that failed or could not be verified holds its exact source,
 * mirror, baseline, owner and lease. It is never completion: only a verified
 * save/unchanged receipt (or proven prior destruction) ends the hold. */
export function agentFileSaveHeld(row: Pick<Copy, "state" | "receipt"> | null | undefined): boolean {
  return Boolean(row && row.receipt?.schema === AGENT_FILES_CONTRACT && row.receipt?.savePending != null && !completed.has(row.state));
}
/** Hold code for retained note-delivery aside copies that could not be surfaced. */
export const AGENT_FILES_ASIDE_UNSURFACED = "AGENT_FILES_ASIDE_UNSURFACED";
/**
 * LATE-ABORT (RFL + rf-3): hold code of a stopped save whose abort came after
 * store.apply passed the canonical commit boundary and whose write had not
 * settled within AGENT_FILE_LATE_ABORT_SETTLE_MS. It is neither "cancelled"
 * nor "saved": the collection keeps its lock, and the settling write replaces
 * this hold with its real outcome (saved, or a failed-save hold).
 */
export const AGENT_FILES_SAVE_STILL_RUNNING = "AGENT_FILES_SAVE_STILL_RUNNING";
export const AGENT_FILES_SAVE_STILL_RUNNING_INSTRUCTION = "Agent-file changes are still being saved. The stop came too late to cancel this save; it is recorded as saved or failed when it finishes. Do not discard or release this sandbox yet.";
/** How long an aborted collection waits for a canonical write that already
 * passed its commit boundary before it reports "still saving". Kept below the
 * retirement deadline owner's own 1 s settle wait
 * (AGENT_FILE_RETIREMENT_ABORT_SETTLE_MS), so that owner receives the
 * collector's own report instead of writing a "not saved" hold over a save
 * that is landing. */
export const AGENT_FILE_LATE_ABORT_SETTLE_MS = 750;
/** The one operator instruction for a held stopped copy, keyed on the hold's
 * own code (receipt.savePending.code), not on the row's last error. */
export function agentFileHoldInstruction(row: Pick<Copy, "receipt" | "executionRoot" | "location"> | null | undefined): string {
  const holdCode = (row?.receipt?.savePending as { code?: unknown } | undefined)?.code;
  if (holdCode === AGENT_FILES_SAVE_STILL_RUNNING) return AGENT_FILES_SAVE_STILL_RUNNING_INSTRUCTION;
  if (holdCode !== AGENT_FILES_ASIDE_UNSURFACED) return AGENT_FILES_SAVE_PENDING_INSTRUCTION;
  const asideRoot = path.posix.join(row!.executionRoot, ".paperclip-runtime", "notes-aside");
  return `Agent note copies retained during note delivery could not be checked, so this agent directory was not released. To keep them, copy ${asideRoot} from the sandbox (${row!.location}) into the agent's folder, and any ${path.posix.join(row!.executionRoot, ".paperclip-runtime", "notes-*", "aside")} a failed retention left behind.`;
}
/** Cleanup authority. An unavailable receipt settles only when no save is held:
 * preparation failed before provider use, or exact destruction was proven. */
/**
 * AF-ABORT (RFL row-22 / rf-4): ends an agent-directory operation-lock
 * session when `signal` aborts, instead of when the held work returns.
 * Same pattern as pl/cancel-finalize2 (5e0eac367, the ownership callback
 * returns at the deadline) plus workspace-source-lock.ts's statement cancel:
 * a statement still running on THIS lock session (matched by pid and
 * backend_start) is cancelled with pg_cancel_backend from a control
 * connection bounded to 1 s, then the lock callback rejects, so the
 * dedicated connection closes and its advisory lock is released. The
 * abandoned work keeps no lock and re-checks `signal`.
 */
/**
 * review-fleet-3 (smarty-dev#20787): releases the session advisory lock on the
 * SAME dedicated session that took it. The merged base's
 * withDedicatedDbConnection caches a successful connection (upstream #21769),
 * so the session's end can no longer be relied on to drop the lock. The unlock
 * is bounded; when it fails, times out or reports the lock was not held by
 * this session, the session is ended so it is never cached still holding it.
 */
async function releaseOperationLock(dedicated: Db, lockKey: string): Promise<void> {
  let released = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const unlock = dedicated.execute(sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0)) as released`);
    unlock.catch(() => undefined);
    const [row] = await Promise.race([unlock, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("agent_directory_lock_release_timeout")), 2_000);
    })]);
    released = (row as { released?: unknown } | undefined)?.released === true;
  } catch (error) {
    logger.warn({ err: error }, "Agent directory operation lock release failed; ending its session");
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!released) await dedicated.$client.end({ timeout: 0 }).catch(() => undefined);
}
export async function endLockSessionOnAbort<T>(db: Db, session: { pid: number; backendStart: string }, work: Promise<T>, signal: AbortSignal,
  tooLate?: () => boolean): Promise<T> {
  work.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // LATE-ABORT: the canonical write is past its commit boundary and lands
      // (or fails) as a whole. The lock session stays until its outcome is
      // recorded; settleLateAbort bounds how long the caller waits for it.
      if (tooLate?.()) return;
      void withDedicatedDbConnection(db, async control => {
        const timer = setTimeout(() => { void control.$client.end({ timeout: 0 }); }, 1000);
        try {
          await control.execute(sql`select pg_cancel_backend(pid) from pg_stat_activity
            where pid = ${session.pid} and backend_start = ${session.backendStart}::timestamptz
              and datname = current_database() and usename = current_user and state = 'active'`);
        } finally { clearTimeout(timer); }
      }).catch(() => undefined).then(() => reject(signal.reason ?? new Error("agent_directory_operation_aborted")));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
/** One stopped collection's canonical-write progress, shared by its steps and
 * by the owner of its lock. `boundary`: store.apply passed the canonical
 * commit boundary (set in the same tick as its last abort check), so an abort
 * can no longer cancel the write. `recorded`: the collection is writing, or
 * has written, the write's real outcome on its copy row after a too-late
 * abort. `done`: that outcome (saved, or the failed-save hold) is on the row;
 * what remains of the collection is cleanup. */
export type AgentFileCanonicalWrite = { boundary: boolean; recorded: boolean; done: boolean };
type LateAbort<T> = { write: AgentFileCanonicalWrite; settleMs: number;
  /** The report at the bound while the write is still landing: the durable
   * "still saving" hold; undefined when the outcome is being recorded right
   * now (the bound re-checks for at most LATE_ABORT_RECORD_SLACK_MS). */
  stillSaving: () => Promise<T | undefined>;
  /** Non-blocking answer while the outcome UPDATE is still in flight. It must
   * not write over that outcome or wait for its row lock. */
  pending: () => T;
  /** The recorded outcome (write.done: saved, or the failed-save hold), marked `abortCameTooLate`. */
  outcome: () => Promise<T> };
/** How often the bound re-checks a late outcome that is being recorded right now. */
const LATE_ABORT_RECORD_POLL_MS = 25;
/** Extra time to observe a nearly finished outcome record, never its full I/O
 * duration. Independent of the poll/read/write so a blocked DB call cannot
 * turn a late-abort answer into an unbounded wait. */
const LATE_ABORT_RECORD_SLACK_MS = 100;
/**
 * LATE-ABORT (RFL + rf-3 agreed contract): an abort that arrives after the
 * canonical commit boundary never rejects the collection as cancelled.
 * `operation` (which owns the lock until it settles) is awaited for at most
 * `settleMs` from the abort: within that bound the collection returns its real
 * outcome (SAVED, marked `abortCameTooLate`). At the bound the collection
 * returns the durable "still saving" report instead, or the outcome already
 * on the row (the saved record, or the failed-save hold): that record is the
 * answer, and what remains of the collection (its lease unpin, its cleanup)
 * continues after it without delaying it. If that record is mid-write, a
 * non-persisting "still saving" answer ends the wait within `settleMs` plus
 * LATE_ABORT_RECORD_SLACK_MS; the in-flight UPDATE is never overwritten.
 * Meanwhile `operation` keeps the lock, records SAVED (or the failure) when the write settles, and only then
 * releases.
 * Once that outcome is on the row (`write.done`) the lock is no longer kept:
 * an abort during the remaining cleanup ends the lock session at once, as for
 * any aborted collection (no lock across a provider call), and the collection
 * returns the recorded outcome instead of "cancelled". An abort before the
 * boundary is not handled here: it keeps its early rejection and nothing
 * canonical has changed.
 */
export function settleLateAbort<T>(operation: Promise<T>, signal: AbortSignal, late: LateAbort<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined, recordDeadline: NodeJS.Timeout | undefined;
    let reported = false, settled = false;
    const report = (value: T) => {
      if (settled || reported) return;
      reported = true;
      if (timer) clearTimeout(timer);
      if (recordDeadline) clearTimeout(recordDeadline);
      // Only the answer is bounded. The operation still owns its lock and is
      // joined for graceful drain until the real outcome is recorded.
      trackAgentFileCheckpoint(operation).catch(() => undefined);
      resolve(value);
    };
    const onAbort = () => {
      if (!late.write.boundary) return;
      if (late.write.done) {
        // The write is on the row; only cleanup remains. That cleanup is
        // abandoned like any aborted work; the recorded outcome is the answer.
        reported = true;
        trackAgentFileCheckpoint(operation).catch(() => undefined);
        void late.outcome().then(resolve, reject);
        return;
      }
      const atBound = () => {
        if (settled || reported) return;
        // PERSIST-FAILURE (rf-3 R7): an outcome already on the row, saved or
        // the failed-save hold, is the answer at the bound. The collection's
        // own bookkeeping after it never keeps the caller waiting.
        void (late.write.done ? late.outcome() : late.stillSaving()).then(value => {
          if (settled || reported) return;
          if (value === undefined) {
            // Observe a nearly finished record, but never wait past recordDeadline.
            timer = setTimeout(atBound, LATE_ABORT_RECORD_POLL_MS);
            return;
          }
          report(value);
        }, error => logger.warn({ err: error }, "Agent-file save is still running after a late abort; its report could not be written, bounded pending answer remains scheduled"));
      };
      timer = setTimeout(atBound, late.settleMs);
      recordDeadline = setTimeout(() => {
        if (!settled && !reported) report(late.pending());
      }, late.settleMs + LATE_ABORT_RECORD_SLACK_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(value => { settled = true; if (!reported) resolve(value); }, error => {
      settled = true;
      if (!reported) reject(error);
      // After a report, the abort's own rejection of the abandoned cleanup is expected.
      else if (error !== signal.reason) logger.warn({ err: error }, "Agent-file collection failed after its outcome was reported");
    }).finally(() => {
      if (timer) clearTimeout(timer);
      if (recordDeadline) clearTimeout(recordDeadline);
      signal.removeEventListener("abort", onAbort);
    });
  });
}
/**
 * AF-ABORT: the same remote target, except that once `signal` aborts its
 * sandbox runner starts no new provider command (every runner method throws
 * the abort first). This also stops a library operation already in flight
 * (an upload's own follow-up or failure cleanup) from issuing more commands
 * after its stuck command returns. A command already running is not
 * re-entered; the runner API has no cancel, so it ends by its own timeout.
 */
export function abortableExecutionTarget<T extends AdapterExecutionTarget | null | undefined>(target: T, signal?: AbortSignal): T {
  if (!signal || !target || target.kind !== "remote" || target.transport !== "sandbox" || !target.runner) return target;
  const runner = new Proxy(target.runner, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      return typeof value === "function"
        ? (...args: unknown[]) => { signal.throwIfAborted(); return value.apply(object, args); }
        : value;
    },
  });
  return new Proxy(target, { get: (object, property, receiver) => property === "runner" ? runner : Reflect.get(object, property, receiver) }) as T;
}
function settled(row: Copy): boolean {
  return completed.has(row.state) || row.state === "unavailable" && !agentFileSaveHeld(row);
}
function withoutSaveHold(receipt: Record<string, unknown> | null | undefined) {
  // LATE-ABORT: `abortCameTooLate` describes the collection that wrote a
  // record. A later record replaces it (and sets it again only for itself).
  const { savePending: _savePending, abortCameTooLate: _abortCameTooLate, ...rest } = receipt ?? {};
  return rest;
}
const transports = new Map<string, PreparedAdapterExecutionTargetRuntime>();
// Service facades and recovery collectors share these in-process saves. Track
// the whole operation (including queued locks and receipt/cleanup writes), not
// the native run: a detached provider may keep running on the next controller.
const pendingAgentFileCheckpoints = new Set<Promise<void>>();
export function pendingAgentFileCheckpointCount(): number {
  return pendingAgentFileCheckpoints.size;
}

export function trackAgentFileCheckpoint<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(() => undefined, () => undefined);
  pendingAgentFileCheckpoints.add(settled);
  void settled.then(() => pendingAgentFileCheckpoints.delete(settled));
  return operation;
}

/** Join only saves already started; never collect, stop or finalize a run. */
export async function drainAgentFileCheckpoints(): Promise<void> {
  while (pendingAgentFileCheckpoints.size > 0) {
    await Promise.all([...pendingAgentFileCheckpoints]);
  }
}
const key = (row: Pick<Copy, "companyId" | "runId">) => `${row.companyId}:${row.runId}`;
function sandboxTransferRoot(row: Copy, remoteCwd: string): string {
  const origin = typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId);
  return path.posix.join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "agent-file-transfers", row.agentId, origin);
}
export function isAgentDirectoryCopy(row: Pick<Copy, "receipt"> | null): boolean {
  return row?.receipt?.schema === AGENT_FILES_CONTRACT;
}
function baseline(row: Copy) {
  const snapshot = parseDirectorySnapshot(row.receipt?.baseline);
  if (!snapshot || directorySnapshotSha256(snapshot) !== row.baseHash) throw new Error("Agent directory baseline is invalid");
  return snapshot;
}
function pendingConflicts(row: Copy): AgentFileConflict[] {
  // Old receipts have only conflicts. An explicit empty queue means delivered.
  const value = row.receipt?.pendingConflicts ?? row.receipt?.conflicts;
  return Array.isArray(value) ? value as AgentFileConflict[] : [];
}
/**
 * Warm-session freshness covers only the DECLARED INSTRUCTION set: the loaded
 * entry plus every top-level file of the agent directory (for a managed bundle:
 * AGENTS.md, RULES.md, DECISIONS.md, PREFERENCES.md, MODELS.md, LANDSCAPE.md).
 * Nothing in a managed bundle marks instruction versus note files (the adapter
 * config names only the entry; exportFiles lists every file), so this path rule
 * is the declaration. Nested paths (memory/**, archive/**, templates/**,
 * work/**) are notes: a sibling saving one refreshes an idle warm directory
 * instead of retiring its session. A new session still restores the whole
 * canonical folder, notes included.
 */
export function isDeclaredInstructionPath(name: string, entryFile: string): boolean {
  return name === entryFile || !name.includes("/");
}
export function declaredInstructionDigest(snapshot: DirectorySnapshot, entryFile: string): string {
  const entries = [...snapshot.entries].filter(([name, entry]) => entry.kind !== "dir" && isDeclaredInstructionPath(name, entryFile))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
/** Runs on the remote target. Places uploaded note files (already inside the
 * root's excluded .paperclip-runtime scratch, same filesystem) WITHOUT erasing:
 * each destination (file or removed path) is first renamed aside into that
 * scratch, the moved-aside bytes must equal the captured baseline ('absent'
 * for a new path), the new file is placed with link(2), which fails EEXIST if
 * anything recreated the path, and every moved-aside copy is re-hashed after
 * placement (a write through an fd held open lands there). A file compares by
 * content AND mode ('<sha256>:<octal mode>'), so a concurrent chmod is a change.
 * Any mismatch or EEXIST puts the agent's bytes back (the new note aside) and
 * fails: the original returns to its path when that path is free, otherwise
 * it is placed beside it as a visible <name>.aside-<epoch> in the agent's
 * folder (link(2), never replacing), so stopped capture collects it and any
 * later fd write. Anything still in the scratch is listed in aside/retained.json
 * BEFORE the throw, and the caller retains it like a successful delivery's
 * copies. Nothing moved aside is deleted: on success the present copies are listed in
 * aside/retained.json and the caller RETAINS them under
 * .paperclip-runtime/notes-aside/ until the next verified checkpoint
 * (notesAsideProgram). No quiescence gate: a live child or sibling tool keeps
 * the chat on the same thread; (b) alone never erases.
 * Every ancestor below the root must be a real directory, never a link. */
export const applyWarmNotesProgram = `const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");const plan=JSON.parse(process.argv[1]);
const at=(base,name)=>{if(typeof name!=="string"||!name||name.length>512||name.startsWith("/")||name.includes("\\\\")||name.includes("\\0")||name.split("/").some(p=>!p||p==="."||p===".."||p===".paperclip-runtime"))throw new Error("unsafe note path");return path.join(base,...name.split("/"));};
const real=target=>{let current=plan.root;for(const segment of path.relative(plan.root,path.dirname(target)).split(path.sep).filter(Boolean)){current=path.join(current,segment);const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw new Error("unsafe note parent");}};
if(!path.isAbsolute(plan.root)||!plan.source.startsWith(plan.root+"/.paperclip-runtime/")||!plan.aside.startsWith(plan.root+"/.paperclip-runtime/"))throw new Error("unsafe note plan");
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const tree=(p,rel,out)=>{const s=fs.lstatSync(p,{throwIfNoEntry:false});if(!s)return out;if(s.isSymbolicLink())out[rel]="link";else if(s.isDirectory()){out[rel]="dir";for(const n of fs.readdirSync(p))tree(path.join(p,n),rel?rel+"/"+n:n,out);}else out[rel]=s.isFile()?sha(p)+":"+(s.mode&0o777).toString(8):"other";return out;};
const same=(p,expect)=>{const got=tree(p,"",{});return JSON.stringify(Object.keys(got).sort().map(k=>[k,got[k]]))===JSON.stringify(Object.keys(expect).filter(k=>expect[k]!=="absent").sort().map(k=>[k,expect[k]]));};
const C=new Error("warm note changed during delivery");let n=0;const moved=[],kept=[],beside=[],epoch=Date.now();
fs.mkdirSync(plan.aside,{recursive:true,mode:0o700});
const aside=(t,expect,name)=>{const a=path.join(plan.aside,String(n++));const d=fs.lstatSync(path.dirname(t),{throwIfNoEntry:false});if(d&&d.dev!==fs.lstatSync(plan.aside).dev)throw new Error("note aside crosses filesystems");
let present=true;try{fs.renameSync(t,a);}catch(e){if(e.code!=="ENOENT")throw e;present=false;}const m={t,a,name,present,expect,placed:null};moved.push(m);
if(present?!same(a,expect):expect[""]!=="absent")throw C;return m;};
const visible=m=>{const s=fs.lstatSync(m.a);for(let i=0;i<10;i++){const v=m.t+".aside-"+epoch+(i?"-"+i:"");
if(s.isDirectory()){if(fs.lstatSync(v,{throwIfNoEntry:false}))continue;fs.renameSync(m.a,v);}else{try{fs.linkSync(m.a,v);}catch(e){if(e.code!=="EEXIST")throw e;continue;}fs.unlinkSync(m.a);}
beside.push(m.name+".aside-"+epoch+(i?"-"+i:""));return;}kept.push(m.a);};
const putBack=m=>{if(m.placed){const now=fs.lstatSync(m.t,{throwIfNoEntry:false});if(now&&now.isFile()&&sha(m.t)===m.placed){fs.renameSync(m.t,path.join(plan.aside,"new-"+String(n++)));}else if(now){if(m.present)visible(m);return;}}
if(!m.present)return;const s=fs.lstatSync(m.a);if(s.isDirectory()){if(fs.lstatSync(m.t,{throwIfNoEntry:false})){visible(m);return;}fs.renameSync(m.a,m.t);return;}
try{fs.linkSync(m.a,m.t);fs.unlinkSync(m.a);}catch(e){if(e.code!=="EEXIST")throw e;visible(m);}};
try{
for(const [name,expect] of plan.remove){const t=at(plan.root,name);real(t);aside(t,expect,name);}
for(const name of plan.dirs){const t=at(plan.root,name);fs.mkdirSync(t,{recursive:true,mode:0o700});real(path.join(t,"x"));}
for(const [name,mode,expect,hash] of plan.files){const t=at(plan.root,name),s=at(plan.source,name);fs.mkdirSync(path.dirname(t),{recursive:true,mode:0o700});real(t);
const m=aside(t,expect,name);fs.chmodSync(s,mode);if(sha(s)!==hash)throw new Error("staged note changed");fs.linkSync(s,t);m.placed=hash;fs.unlinkSync(s);}
for(const m of moved)if(m.present?!same(m.a,m.expect):fs.existsSync(m.a))throw C;
const retained=moved.filter(m=>m.present).map(m=>({a:path.basename(m.a),name:m.name,expect:m.expect}));
if(retained.length)fs.writeFileSync(path.join(plan.aside,"retained.json"),JSON.stringify(retained),{mode:0o600});
}catch(error){for(const m of moved.reverse()){try{putBack(m);}catch(e){kept.push(m.a);}}
const left=moved.filter(m=>m.present&&fs.lstatSync(m.a,{throwIfNoEntry:false})).map(m=>({a:path.basename(m.a),name:m.name,expect:m.expect}));
if(left.length)fs.writeFileSync(path.join(plan.aside,"retained.json"),JSON.stringify(left),{mode:0o600});
if(beside.length)process.stderr.write("agent bytes placed beside: "+JSON.stringify(beside)+"\\n");
if(kept.length)process.stderr.write("agent bytes kept aside: "+JSON.stringify(kept)+"\\n");throw error;}`;
/** Runs on the remote target after a GREEN post-check: moves the delivery's
 * aside directory (only when it lists retained copies) to
 * <root>/.paperclip-runtime/notes-aside/<epoch>-<id>, then removes the rest of
 * the upload scratch. A failure keeps the whole scratch, manifest included:
 * notesAsideProgram sweeps that unpromoted notes-<id>/aside too, and the
 * caller records it (notesAside) exactly like a promoted one. */
const retainWarmNotesAsideProgram = `const fs=require("node:fs"),path=require("node:path");const [aside,retain,staging]=process.argv.slice(1);
const retained=fs.existsSync(path.join(aside,"retained.json"));if(retained){fs.mkdirSync(path.dirname(retain),{recursive:true,mode:0o700});if(fs.existsSync(retain))throw new Error("notes aside exists");fs.renameSync(aside,retain);}
fs.rmSync(staging,{recursive:true,force:true});process.stdout.write(JSON.stringify({retained}));`;
/** Runs on the remote target at a verified checkpoint of a tree whose receipt
 * holds retained aside copies (receipt.notesAside). Mode "surface" (BEFORE the
 * capture): re-hash every retained copy against its delivery baseline; a
 * changed copy (an fd write that landed after the swap) is placed into the live
 * tree as <name>.aside-<epoch> with link(2) then unlink of the aside name
 * (nlink 1 for the capture; a dir by absent-only rename), so the same capture
 * collects it and any later write through that fd lands in the tree. Mode
 * "clean" (AFTER the checkpoint is recorded): an unchanged copy is removed; a
 * copy that changed since "surface" stays for the next checkpoint. Never drops a
 * changed copy. Prints {surfaced, kept, remaining}. An UNPROMOTED delivery
 * manifest (.paperclip-runtime/notes-<id>/aside/retained.json, left when the
 * promotion into notes-aside failed) is swept the same way and counts in
 * remaining: a hidden source is never read as 'no copies'. */
const notesAsideProgram = String.raw`const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");const [root,mode]=process.argv.slice(1);
const base=path.join(root,".paperclip-runtime","notes-aside"),out={surfaced:[],kept:[],remaining:0};
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const tree=(p,rel,o)=>{const s=fs.lstatSync(p,{throwIfNoEntry:false});if(!s)return o;if(s.isSymbolicLink())o[rel]="link";else if(s.isDirectory()){o[rel]="dir";for(const n of fs.readdirSync(p))tree(path.join(p,n),rel?rel+"/"+n:n,o);}else o[rel]=s.isFile()?sha(p)+":"+(s.mode&0o777).toString(8):"other";return o;};
const same=(p,expect)=>{const got=tree(p,"",{});return JSON.stringify(Object.keys(got).sort().map(k=>[k,got[k]]))===JSON.stringify(Object.keys(expect).filter(k=>expect[k]!=="absent").sort().map(k=>[k,expect[k]]));};
const safe=name=>typeof name==="string"&&name&&!name.startsWith("/")&&name.split("/").every(p=>p&&p!=="."&&p!==".."&&p!==".paperclip-runtime");
const realParent=t=>{let c=root;for(const seg of path.relative(root,path.dirname(t)).split(path.sep).filter(Boolean)){c=path.join(c,seg);const s=fs.lstatSync(c,{throwIfNoEntry:false});if(!s){fs.mkdirSync(c,{mode:0o700});continue;}if(!s.isDirectory()||s.isSymbolicLink())throw new Error("unsafe aside parent");}};
let dirs=[];try{dirs=fs.readdirSync(base).sort().map(d=>[d,path.join(base,d),null]);}catch(e){if(e.code!=="ENOENT")throw e;}
const rt=path.join(root,".paperclip-runtime");let scratch=[];try{scratch=fs.readdirSync(rt).filter(s=>/^notes-[0-9a-f-]{36}$/.test(s)&&fs.lstatSync(path.join(rt,s,"aside","retained.json"),{throwIfNoEntry:false})).sort();}catch(e){if(e.code!=="ENOENT")throw e;}
for(const s of scratch)dirs.push([s,path.join(rt,s,"aside"),path.join(rt,s)]);
for(const [d,dir,scratchDir] of dirs){const manifest=path.join(dir,"retained.json");let list;
try{list=JSON.parse(fs.readFileSync(manifest,"utf8"));if(!Array.isArray(list))throw 0;}catch{out.kept.push(d);out.remaining++;continue;}
for(const m of list){const a=path.join(dir,String(m.a));const s=fs.lstatSync(a,{throwIfNoEntry:false});if(!s||m.done)continue;
if(mode==="surface"){if(m.surfaced||!safe(m.name)||same(a,m.expect))continue;
for(let i=0;i<10&&!m.surfaced;i++){const rel=m.name+".aside-"+d+(i?"-"+i:""),t=path.join(root,...rel.split("/"));realParent(t);
if(s.isDirectory()){if(!fs.lstatSync(t,{throwIfNoEntry:false})){fs.renameSync(a,t);m.surfaced=rel;}}
else{try{fs.linkSync(a,t);}catch(e){if(e.code!=="EEXIST")throw e;continue;}fs.unlinkSync(a);m.surfaced=rel;}}
if(m.surfaced)out.surfaced.push(m.surfaced);else out.kept.push(d+"/"+m.a);}
else{if(!m.surfaced&&same(a,m.expect)){fs.rmSync(a,{recursive:true,force:true});m.done=true;}else out.kept.push(d+"/"+m.a);}}
if(mode==="surface"||list.some(m=>!m.done&&fs.lstatSync(path.join(dir,String(m.a)),{throwIfNoEntry:false}))){fs.writeFileSync(manifest+".tmp",JSON.stringify(list),{mode:0o600});fs.renameSync(manifest+".tmp",manifest);out.remaining++;}
else fs.rmSync(scratchDir??dir,{recursive:true,force:true});}
if(mode==="clean"&&!out.remaining)fs.rmSync(base,{recursive:true,force:true});
process.stdout.write(JSON.stringify(out));`;
function actor(row: Copy): AuthorizationActor {
  return { type: "agent", companyId: row.companyId, agentId: row.agentId, runId: row.runId, onBehalfOfUserId: row.responsibleUserId };
}
export function agentDirectoryWorkingCopyService(db: Db, get: (companyId: string, runId: string) => Promise<Copy | null>, patch: (row: Copy, values: Partial<typeof copies.$inferInsert>, condition?: SQL) => Promise<Copy>, environmentRuntime?: EnvironmentRuntimeService,
  options: { /** LATE-ABORT bound; default AGENT_FILE_LATE_ABORT_SETTLE_MS. */ lateAbortSettleMs?: number } = {}) {
  const store = agentFileStore(db);
  const lateAbortSettleMs = Number.isFinite(options.lateAbortSettleMs) && options.lateAbortSettleMs! > 0
    ? options.lateAbortSettleMs! : AGENT_FILE_LATE_ABORT_SETTLE_MS;
  /** LATE-ABORT: after the abort, the bound's "still saving" report or the
   * deadline owner's hold may have replaced the row this collection read.
   * Record the write's real outcome on the row as it is now, and confirm it. */
  async function recordLate(row: Copy, values: (current: Copy) => Partial<typeof copies.$inferInsert>, recorded: (next: Copy) => boolean, condition?: SQL): Promise<Copy> {
    let current = row;
    for (let attempt = 0; attempt < 5; attempt++) {
      current = await get(row.companyId, row.runId) ?? current;
      current = await patch(current, values(current), condition);
      if (recorded(current)) break;
    }
    return current;
  }
  /** A truthful answer, not a second concurrent row UPDATE. When the real
   * outcome is mid-write its transaction already owns the row; collection's
   * lock and lease pin continue protecting the source until that write ends. */
  function pendingReport(current: Copy): Copy {
    const stoppedAt = current.processStoppedAt ?? new Date();
    const previous = current.receipt?.savePending as { since?: string; failures?: number } | undefined;
    const since = typeof previous?.since === "string" ? new Date(previous.since) : stoppedAt;
    const receipt = { ...current.receipt, abortCameTooLate: true, savePending: { since: since.toISOString(), code: AGENT_FILES_SAVE_STILL_RUNNING,
      reason: "The stop came after the canonical write began; the write is still landing.", failures: previous?.failures ?? 0 } };
    return { ...current, state: "unavailable", processStoppedAt: stoppedAt, errorCode: AGENT_FILES_SAVE_STILL_RUNNING,
      errorMessage: agentFileHoldInstruction({ ...current, receipt }), nextAttemptAt: instructionCopyRetryAt(since), receipt };
  }
  /** LATE-ABORT: the report at the bound (see settleLateAbort). While the
   * write is still landing it is the durable "still saving" hold: the same
   * hold a failed stopped save writes (receipt.savePending, under the
   * destroy-claim lease row lock), so no destroy, expiry or deadline hold
   * touches the source meanwhile. A write that was already recorded as saved
   * (the collection is only cleaning up) is reported as that saved record,
   * never relabelled. Never written over an outcome being recorded. */
  async function holdStillSaving(row: Copy, write: AgentFileCanonicalWrite): Promise<Copy | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await get(row.companyId, row.runId);
      if (!current) break;
      const receiptUnchanged = sql`${copies.receipt} IS NOT DISTINCT FROM ${JSON.stringify(current.receipt)}::jsonb`;
      if (completed.has(current.state)) {
        if (current.receipt?.abortCameTooLate === true) return current;
        const marked = await patch(current, { receipt: { ...current.receipt, abortCameTooLate: true } }, receiptUnchanged);
        if (completed.has(marked.state) && marked.receipt?.abortCameTooLate === true) return marked;
        continue;
      }
      if (write.recorded) break;
      const { state, processStoppedAt, errorCode, errorMessage, nextAttemptAt, receipt } = pendingReport(current);
      const next = await patch(current, { state, processStoppedAt, errorCode, errorMessage, nextAttemptAt, receipt },
        sql`${receiptUnchanged} AND ${agentFileHoldWriteCondition}`);
      if (next.errorCode === AGENT_FILES_SAVE_STILL_RUNNING && agentFileSaveHeld(next)) return next;
    }
    return undefined;
  }
  /** LATE-ABORT: the outcome this collection already recorded (write.done),
   * marked `abortCameTooLate`, for an abort that arrives during its cleanup. */
  async function recordedOutcome(row: Copy): Promise<Copy> {
    let current = await get(row.companyId, row.runId) ?? row;
    for (let attempt = 0; attempt < 3 && current.receipt?.abortCameTooLate !== true; attempt++) {
      current = await patch(current, { receipt: { ...current.receipt, abortCameTooLate: true } },
        sql`${copies.receipt} IS NOT DISTINCT FROM ${JSON.stringify(current.receipt)}::jsonb`);
    }
    return current;
  }
  async function insertCopy(values: typeof copies.$inferInsert) {
    return db.transaction(async tx => {
      await notifyInstructionCollection(tx, { companyId: values.companyId, runId: values.runId });
      return tx.insert(copies).values(values).returning();
    });
  }
  const ownerFile = (row: Copy) => path.join(path.dirname(row.localRoot), "owner.json");
  const disposableRemoteCopy = (row: Copy) => process.env.PAPERCLIP_EPHEMERAL_SERVER === "true" && row.location.startsWith("remote:");
  function projectionRoot(row: Copy): string {
    const origin = String(row.receipt?.materializationRunId ?? row.receipt?.directoryRunId ?? row.runId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(origin)) throw conflict("Invalid agent directory owner");
    return path.join(path.dirname(resolveManagedInstructionsRoot({ id: row.agentId, companyId: row.companyId, name: "", adapterConfig: {} })), "file-sync", "runs", origin, "live");
  }
  async function owns(row: Copy) {
    // Remote ownership is durable. A marker on a discarded controller cannot
    // establish ownership of the retained sandbox on its replacement.
    if (disposableRemoteCopy(row)) return row.state !== "superseded" && !row.receipt?.retainedByRunId;
    if (row.receipt?.warm !== true) return true;
    return await fs.readFile(ownerFile(row), "utf8").then(s => JSON.parse(s).runId === row.runId).catch(error => error.code === "ENOENT" && row.processStoppedAt !== null);
  }
  async function canReuse(companyId: string, agentId: string, runId: string) {
    const row = await get(companyId, runId);
    if (!row || row.agentId !== agentId || row.state !== "warm_saved" || row.errorCode || !await owns(row)) return false;
    const entry = baseline(row).entries.get(row.entryFile);
    if (entry?.kind !== "file" || entry.hash !== row.receipt?.sessionEntryHash) return false;
    return store.locked(companyId, agentId, actor(row), false, async (_tx, _agent, root) => {
      const canonical = checkpointSnapshot(await cachedAgentFileManifest(root));
      if (directorySnapshotSha256(canonical) === row.baseHash) return true;
      // Notes-only drift is refreshed into an idle REMOTE warm tree at handoff,
      // where the tree itself is proven unchanged first. A LOCAL root never
      // takes delivery in place: it retires and restores fresh.
      return row.location !== "local" && declaredInstructionDigest(canonical, row.entryFile) === declaredInstructionDigest(baseline(row), row.entryFile);
    });
  }
  /** Copy canonical note changes (never declared instruction files) into an
   * idle warm tree that still equals its last checkpoint, under the caller's
   * canonical lock. Returns the rebased baseline. A remote tree keeps its
   * root, so AGENT_HOME in the runner's instruction text does not move. */
  async function refreshWarmNotes(row: Copy, canonicalRoot: string, canonical: DirectorySnapshot, executionTarget?: AdapterExecutionTarget | null) {
    const before = baseline(row);
    const names = [...new Set([...[...before.entries].map(([name]) => name), ...[...canonical.entries].map(([name]) => name)])]
      .filter(name => !isDeepStrictEqual(before.entries.get(name), canonical.entries.get(name)));
    if (names.some(name => isDeclaredInstructionPath(name, row.entryFile) && (before.entries.get(name)?.kind ?? canonical.entries.get(name)?.kind) !== "dir")) {
      throw new AgentDirectoryReuseInvalidatedError("Managed agent instructions changed before warm directory handoff");
    }
    if (row.location !== "local") return refreshRemoteWarmNotes(row, canonicalRoot, canonical, names, executionTarget);
    // A LOCAL root NEVER delivers in place: it has no aside/compare/no-replace
    // fence, so it takes the existing retirement + fresh restore instead.
    throw new AgentDirectoryReuseInvalidatedError("Local warm agent directory is never refreshed in place");
  }
  /** Remote (sandbox/SSH) variant. Only existing execution-target operations:
   * the warm checkpoint capture proves the idle remote tree equals its last
   * checkpoint (never-OK: any unsynced write keeps the old retirement, which
   * saves that write first), the managed-runtime asset upload stages the changed
   * notes inside the excluded .paperclip-runtime area, a bounded program renames
   * them into place, and a second capture proves the tree equals canonical. */
  async function refreshRemoteWarmNotes(row: Copy, canonicalRoot: string, canonical: DirectorySnapshot, names: string[], target?: AdapterExecutionTarget | null) {
    if (target?.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) {
      throw new AgentDirectoryReuseInvalidatedError("Remote warm agent directory collector is unavailable");
    }
    const before = baseline(row);
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const capture = async (previous: AgentFileManifest) => {
      const captured = await captureAgentFileCheckpoint({ runId: row.runId, localRoot: row.localRoot, executionRoot: row.executionRoot, previous, target });
      await captured.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent note refresh scratch cleanup deferred to session retirement"));
      return captured.manifest;
    };
    const observed = await capture(row.receipt?.checkpointManifest as AgentFileManifest | undefined ?? checkpointBaseline(before)).catch(() => null);
    if (!observed || directorySnapshotSha256(checkpointSnapshot(observed)) !== row.baseHash) {
      throw new AgentDirectoryReuseInvalidatedError("Warm agent directory changed after its checkpoint");
    }
    const id = randomUUID();
    const staging = path.join(path.dirname(row.localRoot), `notes-${id}`), files = path.join(staging, "files");
    const remoteStaging = path.posix.join(row.executionRoot, ".paperclip-runtime", `notes-${id}`);
    // (b) Each removed or replaced path carries its captured baseline: the
    // file hash and mode, 'dir' plus every baseline entry below it, or 'absent'.
    // Mode is compared too, so a concurrent chmod is a change, never accepted.
    type Expect = Record<string, string>;
    const fileExpect = (entry: { hash: string; mode: number }) => `${entry.hash}:${(entry.mode & 0o777).toString(8)}`;
    const expectOf = (name: string): Expect => {
      const entry = before.entries.get(name);
      if (!entry) return { "": "absent" };
      if (entry.kind === "file") return { "": fileExpect(entry) };
      const below: Expect = { "": entry.kind };
      for (const [other, value] of before.entries) if (other.startsWith(`${name}/`)) below[other.slice(name.length + 1)] = value.kind === "file" ? fileExpect(value) : value.kind;
      return below;
    };
    const plan = { root: row.executionRoot, source: "", aside: path.posix.join(remoteStaging, "aside"),
      remove: [] as Array<[string, Expect]>, dirs: [] as string[], files: [] as Array<[string, number, Expect, string]> };
    for (const name of [...names].sort()) {
      const previous = before.entries.get(name), next = canonical.entries.get(name);
      if (previous && previous.kind !== next?.kind) plan.remove.push([name, expectOf(name)]);
      if (next?.kind === "dir") plan.dirs.push(name);
      else if (next?.kind === "file") {
        await fs.mkdir(path.dirname(path.join(files, ...name.split("/"))), { recursive: true, mode: 0o700 });
        await fs.copyFile(path.join(canonicalRoot, ...name.split("/")), path.join(files, ...name.split("/")));
        plan.files.push([name, next.mode & 0o777, previous?.kind === "file" ? expectOf(name) : { "": "absent" }, next.hash]);
      }
    }
    // A removed parent holds every removed child; nested removes are already aside with it.
    plan.remove = plan.remove.filter(([name]) => !plan.remove.some(([other]) => name.startsWith(`${other}/`)));
    plan.remove.sort(([a], [b]) => b.length - a.length);
    await fs.mkdir(files, { recursive: true, mode: 0o700 });
    // (4) Retention: the moved-aside copies are NOT deleted. They move to
    // .paperclip-runtime/notes-aside/<epoch>-<id> and stay until the next
    // verified checkpoint (checkpoint() below) re-hashes them: an fd write
    // that landed after the swap is surfaced and collected, never dropped.
    // Returns "retained" when a manifest-listed aside directory was promoted,
    // "none" when there was nothing to retain, and "failed" when the promotion
    // did not run: the manifest then stays in the delivery scratch, where the
    // same sweep finds it. "failed" is never read as "none": the caller records
    // notesAside, so the next checkpoint surfaces and the stopped save holds.
    const retainAside = async (): Promise<"retained" | "none" | "failed"> => {
      const retainAt = path.posix.join(row.executionRoot, ".paperclip-runtime", "notes-aside", `${Date.now()}-${id.slice(0, 8)}`);
      const retained = await runAdapterExecutionTargetShellCommand(row.runId, target,
        `node -e ${quote(retainWarmNotesAsideProgram)} ${quote(plan.aside)} ${quote(retainAt)} ${quote(remoteStaging)}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 15 })
        .catch(error => ({ exitCode: 1, timedOut: false, stdout: "", stderr: String(error) }));
      if (retained.exitCode !== 0 || retained.timedOut) {
        logger.warn({ runId: row.runId, stderr: retained.stderr?.trim().slice(0, 500) }, "Warm note aside copies kept in the delivery scratch");
        return "failed";
      }
      try { return JSON.parse(retained.stdout || "{}").retained === true ? "retained" : "none"; } catch { return "failed"; }
    };
    let upload: PreparedAdapterExecutionTargetRuntime | undefined;
    try {
      upload = await prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: `agent-notes-${id}`, workspaceLocalDir: staging,
        workspaceRemoteDir: remoteStaging, syncWorkspace: false, assets: [{ key: "notes", localDir: files, followSymlinks: false }] });
      const source = upload.assetDirs.notes;
      if (!source || !source.startsWith(`${remoteStaging}/`)) throw new Error("Agent note upload landed outside its scratch area");
      const result = await runAdapterExecutionTargetShellCommand(row.runId, target,
        `node -e ${quote(applyWarmNotesProgram)} ${quote(JSON.stringify({ ...plan, source }))}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 60 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`Agent note refresh failed: ${result.stderr.trim()}`);
    } catch (error) {
      logger.warn({ err: error, runId: row.runId }, "Remote warm agent note refresh failed; retiring the warm session");
      // A refused placement lists every original it could not put back (at its
      // path or as a visible <name>.aside-<epoch>) in aside/retained.json BEFORE
      // it throws. Retain those for THIS owner's stopped collection, exactly
      // like a delivery's own aside copies: never left unmanifested in scratch.
      if (await retainAside() !== "none") {
        await patch(row, { receipt: { ...row.receipt, notesAside: true } })
          .catch(patchError => logger.warn({ err: patchError, runId: row.runId }, "Retained warm note aside copies not recorded; they stay on the box"));
      }
      throw new AgentDirectoryReuseInvalidatedError("Warm agent directory note refresh failed");
    } finally {
      await upload?.cleanupWorkspaceSnapshot?.().catch(() => undefined);
      await fs.rm(staging, { recursive: true, force: true });
    }
    const refreshed = new Set(names);
    const verified = await capture({ ...observed, entries: observed.entries.filter(([name]) => !refreshed.has(name)) }).catch(() => null);
    const anyAside = plan.remove.length > 0 || plan.files.some(([, , expect]) => expect[""] !== "absent");
    if (!verified || directorySnapshotSha256(checkpointSnapshot(verified)) !== directorySnapshotSha256(canonical)) {
      // Nothing is deleted before a green post-check. The aside copies are
      // retained for THIS owner's stopped collection (retirement), whose
      // checkpoint surfaces any copy that changed after the swap.
      if (anyAside) {
        await retainAside();
        await patch(row, { receipt: { ...row.receipt, notesAside: true } })
          .catch(error => logger.warn({ err: error, runId: row.runId }, "Retained warm note aside copies not recorded; they stay on the box"));
      }
      throw new AgentDirectoryReuseInvalidatedError("Warm agent directory note refresh could not be verified");
    }
    // What is on the box decides: a failed promotion still holds manifest-listed
    // copies (in the delivery scratch), so it is recorded like a promoted one.
    const kept = await retainAside();
    return { baseHash: directorySnapshotSha256(canonical), baseline: serializeDirectorySnapshot(canonical), checkpointManifest: verified,
      notesAside: kept !== "none" };
  }
  async function transport(row: Copy, target: AdapterExecutionTarget, recovering: boolean) {
    if (target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    if (target.transport === "ssh") {
      // Reuse SSH's plain directory transfer without its task-workspace suffix
      // or Git-history discovery. The registered root is the exact writable root.
      if (!recovering) await syncDirectoryToSsh({ spec: target.spec, localDir: row.localRoot, remoteDir: row.executionRoot, exclude: [".paperclip-runtime"] });
      return { target, workspaceRemoteDir: row.executionRoot, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: () => restoreWorkspaceFromSshExecution({ spec: target.spec, localDir: row.localRoot,
          remoteDir: row.executionRoot, baselineSnapshot: { ...baseline(row), exclude: [".paperclip-runtime"] }, restoreGitHistory: false }) };
    }
    return prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files",
      workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
      // Agent files are an independently observed native directory. Transfer
      // scratch belongs to the host runtime, including the fallback selected
      // while plugin capability discovery is cold after controller restart.
      runtimeRootDir: sandboxTransferRoot(row, target.remoteCwd),
      syncWorkspace: true, workspaceInboundMode: recovering ? "adopt_remote" : undefined,
      workspaceBaseline: baseline(row), workspaceGitSnapshot: null, workspaceRepositories: [], workspaceFileMode: "all",
      workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
  }
  async function observe(row: Copy, target?: AdapterExecutionTarget | null) {
    if (row.location === "local") {
      // The same bounded program validates aliases on its actual host.
      return observeLocalAgentDirectory(row.localRoot);
    }
    if (!target || target.kind !== "remote" || row.location !== `remote:${target.environmentId ?? ""}`) throw new Error("Agent directory environment changed");
    const origin = typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : row.runId;
    if (row.executionRoot !== path.posix.join(target.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, origin)) throw new Error("Agent directory root changed");
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const result = await runAdapterExecutionTargetShellCommand(row.runId, target,
      `node -e ${quote(agentDirectoryProbeProgram)} ${quote(row.executionRoot)}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 10 });
    if (result.exitCode !== 0 || result.timedOut || result.stdout.length > 1024) throw new Error("Agent directory observation unavailable");
    const value = JSON.parse(result.stdout);
    if (!value || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.identity !== "string") throw new Error("Invalid agent directory observation");
    return value as { digest: string; identity: string };
  }
  async function prepareCopy(input: { companyId: string; agentId: string; runId: string; target?: AdapterExecutionTarget | null; cwd: string; warm?: boolean; reuseRunId?: string; onWarmHandoff?: (copy: Copy) => void }, serialHeld = false): Promise<Copy | null> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agentInstructionsBundleMode(agent) !== "managed") return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const root = resolveManagedInstructionsRoot(agent);
    if (input.reuseRunId) {
      const prior = await get(input.companyId, input.reuseRunId);
      if (!prior || prior.agentId !== input.agentId) throw conflict("Managed warm directory owner changed");
      return serial(prior, async current => {
        if (current.state !== "warm_saved" || current.errorCode || !await owns(current) || current.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) throw conflict("Managed warm directory is not reusable");
        const receipt = { ...current.receipt, cleanup: input.target?.kind === "remote" ? { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } : undefined };
        // Insert before taking the agent-row lock: this foreign key needs an
        // independent transaction, and must survive post-handoff failures.
        const [successor] = await insertCopy({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!,
          entryFile: current.entryFile, baseHash: current.baseHash, localRoot: current.localRoot, executionRoot: current.executionRoot, location: current.location, state: "prepared", receipt });
        let handedOff = false;
        try { return await store.locked(input.companyId, input.agentId, bound, false, async (_tx, lockedAgent, canonical) => {
          // The reservation's earlier check is only a hint. Serialize this last
          // validation and ownership transfer with every canonical writer.
          if (current.entryFile !== deriveBundleState(lockedAgent).entryFile) {
            throw new AgentDirectoryReuseInvalidatedError("Managed agent files changed before warm directory handoff");
          }
          const canonicalSnapshot = checkpointSnapshot(await cachedAgentFileManifest(canonical));
          if (directorySnapshotSha256(canonicalSnapshot) !== current.baseHash) {
            // Only declared instruction files retire a warm session. A sibling's
            // note (memory/**, archive/**, ...) is copied into the idle tree.
            if (declaredInstructionDigest(canonicalSnapshot, current.entryFile) !== declaredInstructionDigest(baseline(current), current.entryFile)) {
              throw new AgentDirectoryReuseInvalidatedError("Managed agent files changed before warm directory handoff");
            }
            const refreshed = await refreshWarmNotes(current, canonical, canonicalSnapshot, input.target);
            Object.assign(successor!, await patch(successor!, { baseHash: refreshed.baseHash,
              receipt: { ...successor!.receipt, baseline: refreshed.baseline, checkpointManifest: refreshed.checkpointManifest,
                ...(refreshed.notesAside || current.receipt?.notesAside === true ? { notesAside: true } : {}) } }));
          }
          // The controller-owned marker fences old callbacks. Attach the new
          // collector immediately after it moves, before fallible bookkeeping.
          const temporary = `${ownerFile(current)}.next`;
          await fs.writeFile(temporary, JSON.stringify({ runId: input.runId }));
          await fs.rename(temporary, ownerFile(current));
          handedOff = true;
          input.onWarmHandoff?.(successor!);
          const runtime = transports.get(key(current));
          if (runtime) transports.set(key(successor!), runtime);
          transports.delete(key(current));
          await patch(current, { state: "superseded", nextAttemptAt: null, receipt: { schema: AGENT_FILES_CONTRACT, warm: true, successorRunId: input.runId } });
          return successor!;
        }); } catch (error) {
          // No process used this proposed owner. Remove it after the canonical
          // lock releases so the same run can restore a fresh directory.
          if (!handedOff) await db.delete(copies).where(and(eq(copies.companyId, input.companyId), eq(copies.runId, input.runId)));
          throw error;
        }
      }, "agent_directory_handoff");
    }
    let row = await get(input.companyId, input.runId);
    if (row?.receipt?.retainedByRunId) throw conflict("Agent directory ownership passed to another run");
    const origin = typeof row?.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : input.runId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(origin)) throw conflict("Invalid agent directory owner");
    const localRoot = path.join(path.dirname(root), "file-sync", "runs", origin, "live");
    // Local copies live outside the task cwd. Remote copies use the reserved,
    // excluded runtime area inside the provider's confined workspace. They are
    // synchronized independently; provider HOME is never reinterpreted.
    const executionRoot = input.target?.kind === "remote"
      ? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "agent-files", input.agentId, origin)
      : localRoot;
    const location = input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local";
    if (row && ((!disposableRemoteCopy(row) && row.localRoot !== localRoot) || row.executionRoot !== executionRoot || row.agentId !== input.agentId || row.location !== location)) throw conflict("Agent directory belongs to a different execution environment");
    if (row && !serialHeld) {
      // Restart preparation can replace a completed copy under the same run ID.
      // Join cleanup's lock before resetting its receipt or creating new bytes.
      // Interrupted admission may have registered the row before making this root.
      await fs.mkdir(path.resolve(localRoot, "../../.."), { recursive: true, mode: 0o700 });
      return serial(row, () => prepareCopy(input, true), "agent_directory_prepare");
    }
    if (row && !settled(row) && row.state !== "preparing") {
      if (input.target?.kind === "remote") {
        if (disposableRemoteCopy(row)) await restoreProjection(row, input.target);
        if (!transports.has(key(row))) transports.set(key(row), await transport(row, input.target, true));
      }
      return row;
    }
    // Register ownership before creating any bytes, so a crash during the copy
    // leaves a recoverable preparing receipt instead of an orphan directory.
    const preparing = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: "preparing",
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { schema: AGENT_FILES_CONTRACT, workspaceCwd: input.cwd, materializationRunId: origin,
        ...(row ? { pendingConflicts: pendingConflicts(row) } : {}), ...(input.warm ? { warm: true, directoryRunId: input.runId } : {}), ...(input.target?.kind === "remote"
        ? { cleanup: { leaseId: input.target.leaseId ?? null, remoteCwd: input.target.remoteCwd } } : {}) }, processStoppedAt: null, attempts: 0,
      nextAttemptAt: null, errorCode: null, errorMessage: null };
    if (row) row = await patch(row, preparing);
    else {
      await insertCopy({ runId: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: bound.onBehalfOfUserId!, ...preparing });
      row = (await get(input.companyId, input.runId))!;
    }
    const { snapshot, storageWarning } = await store.locked(input.companyId, input.agentId, bound, false, async (_tx, _agent, canonical) => {
      // Storage quotas govern saves, never admission to a future run. Restore
      // existing bytes so the agent can work normally and remove excess files.
      // Path/link validation remains mandatory even for an over-quota folder.
      const inspected = await inspectAgentDirectory(canonical, false);
      // A stopped lifecycle has already accounted for all its bytes. No live
      // or pending candidate ever enters this replacement path.
      await fs.rm(localRoot, { recursive: true, force: true });
      await fs.mkdir(path.dirname(localRoot), { recursive: true, mode: 0o700 });
      try {
        await fs.cp(canonical, localRoot, { recursive: true, preserveTimestamps: true });
        return inspected;
      } catch (error) {
        await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
        throw error;
      }
    }).catch(async error => {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    });
    const loadedEntry = snapshot.entries.get(deriveBundleState(agent).entryFile);
    const values = { entryFile: deriveBundleState(agent).entryFile, baseRevisionId: null, baseHash: directorySnapshotSha256(snapshot),
      localRoot, executionRoot, location, state: "preparing", candidateBase64: null, candidateHash: null,
      receipt: { ...preparing.receipt, baseline: serializeDirectorySnapshot(snapshot), storageWarning,
        ...(input.warm ? { sessionEntryHash: loadedEntry?.kind === "file" ? loadedEntry.hash : null } : {}) },
      processStoppedAt: null, attempts: 0, nextAttemptAt: null, errorCode: null, errorMessage: null };
    try {
      row = await patch(row, values);
      if (input.warm) await fs.writeFile(ownerFile(row), JSON.stringify({ runId: row.runId }));
    } catch (error) {
      await fs.rm(path.dirname(localRoot), { recursive: true, force: true });
      throw error;
    }
    try {
      if (input.target?.kind === "remote") {
        await excludeAgentRuntimeFromGit(input.runId, input.target, "Could not exclude agent files from task Git staging");
        const runtime = await transport(row, input.target, false);
        transports.set(key(row), runtime);
        if (input.target.transport === "sandbox") {
          if (runtime.runtimeRootDir !== sandboxTransferRoot(row, input.target.remoteCwd)) throw new Error("Agent directory transfer scratch path changed");
        }
      }
      const observed = await observe(row, input.target).catch(() => null);
      return await patch(row, { state: "prepared", receipt: { ...row.receipt,
        ...(observed?.digest === agentDirectoryBaselineDigest(snapshot) ? { materializationIdentity: observed.identity } : {}) } });
    } catch (error) {
      // Preparation failed before a provider could start using this copy.
      row = await patch(row, { state: "unavailable", processStoppedAt: new Date(), errorCode: "AGENT_FILES_PREPARE_FAILED",
        errorMessage: "Agent files could not be staged. The temporary copy was discarded.", nextAttemptAt: null });
      await release(row, input.target);
      throw error;
    }
  }

  async function restoreProjection(row: Copy, target: AdapterExecutionTarget) {
    const exists = await fs.lstat(row.localRoot).then(stat => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict("Agent directory projection is not a directory");
      return true;
    }, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) return;
    const lease = await ownedRemoteLease(row);
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    if (target.kind !== "remote" || !lease || target.leaseId !== lease.id || lease.status !== "active"
      || lease.releasedAt || hasRemoteTerminationReceipt(lease) || cleanup?.remoteCwd !== target.remoteCwd
      || row.location !== `remote:${target.environmentId}`) throw conflict("Agent directory recovery lease changed");
    // Reconstruct a private mirror without applying save quotas to admission.
    // An empty merge baseline downloads all remote bytes without uploading any;
    // the original save baseline remains unchanged in Postgres.
    await fs.mkdir(row.localRoot, { recursive: true, mode: 0o700 });
    let projection: PreparedAdapterExecutionTargetRuntime | undefined;
    try {
      projection = await prepareAdapterExecutionTargetRuntime({ target, runId: row.runId, adapterKey: "agent-files-recovery",
        workspaceLocalDir: row.localRoot, workspaceRemoteDir: row.executionRoot,
        runtimeRootDir: sandboxTransferRoot(row, target.remoteCwd), syncWorkspace: true,
        workspaceInboundMode: "adopt_remote", workspaceBaseline: { exclude: [".paperclip-runtime"], entries: new Map() },
        workspaceGitSnapshot: null, workspaceRepositories: [], workspaceFileMode: "all", workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
      await projection.restoreWorkspace();
      await inspectAgentDirectory(row.localRoot, false);
      if (row.receipt?.warm === true) await fs.writeFile(ownerFile(row), JSON.stringify({ runId: row.runId }));
    } catch (error) {
      await fs.rm(row.localRoot, { recursive: true, force: true });
      throw error;
    } finally { await projection?.cleanupWorkspaceSnapshot?.(); }
  }
  async function retrieve(row: Copy, target?: AdapterExecutionTarget | null, signal?: AbortSignal) {
    if (row.location !== "local") {
      let runtime = transports.get(key(row));
      if (!runtime) {
        if (!target) throw new Error("Agent directory transport is unavailable");
        signal?.throwIfAborted();
        runtime = await transport(row, target, true);
        transports.set(key(row), runtime);
      }
      signal?.throwIfAborted();
      await runtime.restoreWorkspace();
      signal?.throwIfAborted();
    }
    return inspectAgentDirectory(row.localRoot);
  }
  async function hasChanges(row: Copy, target?: AdapterExecutionTarget | null) {
    try {
      if (row.receipt?.retainedByRunId || row.receipt?.retirementRequired || typeof row.receipt?.materializationIdentity !== "string") return true;
      const observed = await observe(row, target);
      if (observed.identity !== row.receipt.materializationIdentity || observed.digest !== agentDirectoryBaselineDigest(baseline(row))) return true;
      const unchanged = await patch(row, { state: "unchanged_turn", nextAttemptAt: null });
      return unchanged.state !== "unchanged_turn" || Boolean(unchanged.receipt?.retainedByRunId) || Boolean(unchanged.processStoppedAt);
    } catch { return true; }
  }
  /** Rebind one physical materialization; earlier runs lose collection authority. */
  async function adopt(input: { companyId: string; agentId: string; runId: string; previousRunId: string; target?: AdapterExecutionTarget | null; cwd: string; allowRetirementHandoff?: boolean }) {
    let prior = await get(input.companyId, input.previousRunId);
    if (!prior || prior.agentId !== input.agentId || prior.state !== "unchanged_turn" || prior.receipt?.retainedByRunId || prior.processStoppedAt
      || prior.receipt?.workspaceCwd !== input.cwd || prior.location !== (input.target?.kind === "remote" ? `remote:${input.target.environmentId ?? ""}` : "local")) return null;
    const oldRuntime = transports.get(key(prior));
    const remote = input.target?.kind === "remote" ? input.target : null;
    const priorCleanup = prior.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const validLeases = (leases: Array<typeof environmentLeases.$inferSelect>) => {
      if (!remote) return true;
      const previous = leases.find(lease => lease.id === priorCleanup?.leaseId);
      const successor = leases.find(lease => lease.id === remote.leaseId);
      return Boolean(previous && successor && previous.id !== successor.id
        && previous.companyId === input.companyId && successor.companyId === input.companyId
        && previous.heartbeatRunId === input.previousRunId && successor.heartbeatRunId === input.runId
        && previous.environmentId === remote.environmentId && successor.environmentId === remote.environmentId
        && previous.provider && previous.provider === successor.provider
        && previous.providerLeaseId && previous.providerLeaseId === successor.providerLeaseId
        && successor.status === "active" && !successor.releasedAt
        && !hasRemoteTerminationReceipt(previous) && !hasRemoteTerminationReceipt(successor)
        && (remote.transport !== "sandbox" || remote.providerKey === successor.provider)
        && (successor.metadata?.remoteCwd === undefined || successor.metadata.remoteCwd === remote.remoteCwd));
    };
    const leaseIds = remote && priorCleanup?.leaseId && remote.leaseId ? [priorCleanup.leaseId, remote.leaseId] : [];
    if (remote && (!oldRuntime || oldRuntime.target.kind !== "remote" || oldRuntime.target.transport !== remote.transport
      || oldRuntime.target.leaseId !== priorCleanup?.leaseId || oldRuntime.target.remoteCwd !== remote.remoteCwd
      || priorCleanup?.remoteCwd !== remote.remoteCwd || leaseIds.length !== 2
      || !validLeases(await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.id, leaseIds)))))) return null;
    const bound = await resolveInstructionActor(db, { type: "agent", companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    const observedChange = await hasChanges(prior, input.target);
    if (observedChange && !input.allowRetirementHandoff) return null;
    prior = (await get(input.companyId, input.previousRunId))!;
    // adopt_remote constructs a collector on the successor target without
    // uploading the stale host mirror over the retained remote directory.
    const replacement = remote ? await transport({ ...prior, runId: input.runId }, remote, true) : undefined;
    const expectedPrior = prior;
    let adopted: Copy | null;
    try { adopted = await store.locked(input.companyId, input.agentId, bound, false, async (tx, _agent, canonical) => {
      if (remote && !validLeases(await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.id, leaseIds))).for("update"))) return null;
      const [lockedPrior] = await tx.select().from(copies).where(and(eq(copies.companyId, input.companyId),
        eq(copies.runId, expectedPrior.runId), eq(copies.agentId, input.agentId))).for("update");
      if (!lockedPrior || !isDeepStrictEqual(adoptionAuthority(lockedPrior), adoptionAuthority(expectedPrior))) {
        const fields = ["state", "receipt", "baseHash", "localRoot", "executionRoot", "location", "processStoppedAt", "responsibleUserId", "entryFile", "attempts", "candidateHash", "errorCode", "errorMessage", "baseRevisionId", "candidateBase64", "createdAt"] as const;
        const diagnostic = { stage: "locked_adoption_authority", predecessorPresent: Boolean(lockedPrior), observedAfterInitialRead: true,
          changedFields: lockedPrior ? fields.filter(field => !isDeepStrictEqual(lockedPrior[field], expectedPrior[field])) : [] };
        logger.warn({ companyId: input.companyId, agentId: input.agentId, runId: input.runId, previousRunId: input.previousRunId,
          adoptionConflict: diagnostic }, "Agent directory adoption conflict");
        throw conflict("Agent directory ownership changed", diagnostic);
      }
      prior = lockedPrior;
      const current = await inspectAgentDirectory(canonical);
      // A LOCAL root never takes note delivery in place (no aside/compare/
      // no-replace fence): any canonical change keeps the existing retirement.
      const canonicalChanged = agentDirectoryBaselineDigest(current.snapshot) !== agentDirectoryBaselineDigest(baseline(prior));
      if (canonicalChanged && !input.allowRetirementHandoff) return null;
      await notifyInstructionCollection(tx, { companyId: input.companyId, runId: prior.runId });
      await notifyInstructionCollection(tx, { companyId: input.companyId, runId: input.runId });
      const [claimed] = await tx.update(copies).set({ receipt: { ...prior.receipt, retainedByRunId: input.runId }, updatedAt: new Date() })
        .where(and(eq(copies.companyId, input.companyId), eq(copies.runId, prior.runId), eq(copies.agentId, input.agentId), eq(copies.state, "unchanged_turn"),
          eq(copies.updatedAt, prior.updatedAt), eq(copies.baseHash, prior.baseHash), eq(copies.localRoot, prior.localRoot),
          isNull(copies.processStoppedAt), sql`${copies.receipt}->>'retainedByRunId' IS NULL`)).returning();
      if (!claimed) {
        const [conditions] = await tx.select({ unchangedTurn: eq(copies.state, "unchanged_turn"),
          timestampMatches: eq(copies.updatedAt, prior.updatedAt), baselineMatches: eq(copies.baseHash, prior.baseHash),
          localRootMatches: eq(copies.localRoot, prior.localRoot), unstopped: isNull(copies.processStoppedAt),
          successorAbsent: sql<boolean>`${copies.receipt}->>'retainedByRunId' IS NULL`,
          receiptMatches: sql<boolean>`${copies.receipt} IS NOT DISTINCT FROM ${JSON.stringify(prior.receipt)}::jsonb`,
        }).from(copies).where(and(eq(copies.companyId, input.companyId), eq(copies.runId, prior.runId), eq(copies.agentId, input.agentId)));
        const diagnostic = { stage: "adoption_claim", observedAfterClaim: true, predecessorPresent: Boolean(conditions), conditions: conditions ?? null };
        logger.warn({ companyId: input.companyId, agentId: input.agentId, runId: input.runId, previousRunId: input.previousRunId,
          adoptionConflict: diagnostic }, "Agent directory adoption conflict");
        throw conflict("Agent directory ownership changed", diagnostic);
      }
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...values } = prior;
      const [next] = await tx.insert(copies).values({ ...values, runId: input.runId, responsibleUserId: bound.onBehalfOfUserId!, state: "prepared",
        receipt: { ...prior.receipt, materializationRunId: prior.receipt?.materializationRunId ?? prior.runId,
          ...(remote ? { cleanup: { leaseId: remote.leaseId, remoteCwd: remote.remoteCwd } } : {}),
          ...(observedChange || canonicalChanged ? { retirementRequired: true } : {}) }, updatedAt: new Date(),
      }).returning();
      return next;
    }); } catch (error) { await replacement?.cleanupWorkspaceSnapshot?.(); throw error; }
    // Do not move the live transport until the database ownership commit succeeds.
    if (adopted) {
      if (replacement && oldRuntime) {
        const cleanup = replacement.cleanupWorkspaceSnapshot;
        replacement.cleanupWorkspaceSnapshot = async () => {
          try { await cleanup?.(); } finally { await oldRuntime.cleanupWorkspaceSnapshot?.(); }
        };
        transports.delete(key(prior)); transports.set(key(adopted), replacement);
      }
    } else await replacement?.cleanupWorkspaceSnapshot?.();
    return adopted;
  }
  /** A checkpoint that changed no file writes nothing. It still rechecks the
   * run's save authority, so a revoked editor stops reusing a warm directory.
   * A low-trust run never had that authority and has nothing to save here:
   * recheck the read access that admitted its copy instead of failing a save
   * that does not exist. A changed tree still goes through store.apply and is
   * refused there with the named reason. */
  async function unchangedCheckpoint(row: Copy) {
    try { await store.saveUnchanged(row.companyId, row.agentId, actor(row)); }
    catch (error) {
      const reason = error instanceof HttpError && error.status === 403 ? (error.details as { reason?: unknown } | undefined)?.reason : null;
      if (reason !== "deny_low_trust_boundary") throw error;
      await store.locked(row.companyId, row.agentId, actor(row), false, async () => undefined);
    }
  }
  type Capture = Awaited<ReturnType<typeof captureAgentFileCheckpoint>>;
  type Precapture = { row: Copy; target: AdapterExecutionTarget; captured: Capture };
  async function precapture(row: Copy, target?: AdapterExecutionTarget | null): Promise<Precapture | undefined> {
    if (!disposableRemoteCopy(row) || row.receipt?.warm !== true || !await owns(row) || row.state === "superseded") return undefined;
    const resolved = target ?? transports.get(key(row))?.target;
    if (resolved?.kind !== "remote" || row.localRoot !== projectionRoot(row)) return undefined;
    try {
      const previous = row.receipt?.checkpointManifest as AgentFileManifest | undefined ?? checkpointBaseline(baseline(row));
      const captured = await captureAgentFileCheckpoint({ runId: row.runId, localRoot: row.localRoot, executionRoot: row.executionRoot, previous, target: resolved });
      return { row, target: resolved, captured };
    } catch (error) {
      logger.warn({ err: error, runId: row.runId }, "Agent file checkpoint capture before the directory lock failed; capturing under the lock");
      return undefined;
    }
  }
  /** Runs notesAsideProgram on the remote tree; returns how many retained aside
   * directories remain (null when it could not run: everything stays). */
  async function notesAside(row: Copy, target: Extract<AdapterExecutionTarget, { kind: "remote" }>, mode: "surface" | "clean"): Promise<number | null> {
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const result = await runAdapterExecutionTargetShellCommand(row.runId, target, `node -e ${quote(notesAsideProgram)} ${quote(row.executionRoot)} ${mode}`,
      { cwd: target.remoteCwd, env: {}, timeoutSec: 30 }).catch(error => ({ exitCode: 1, timedOut: false, stdout: "", stderr: String(error) }));
    if (result.exitCode !== 0 || result.timedOut) {
      logger.warn({ runId: row.runId, mode, stderr: result.stderr?.trim().slice(0, 500) }, "Retained warm note aside copies kept; sweep did not run");
      return null;
    }
    const out = JSON.parse(result.stdout || "{}") as { surfaced?: string[]; kept?: string[]; remaining?: number };
    if (out.surfaced?.length) logger.warn({ runId: row.runId, surfaced: out.surfaced }, "A retained warm note copy changed after delivery; surfaced into the agent folder for this checkpoint");
    if (out.kept?.length) logger.warn({ runId: row.runId, kept: out.kept }, "Retained warm note aside copies kept for the next checkpoint");
    return typeof out.remaining === "number" ? out.remaining : null;
  }
  /** Retries a failed sweep (a transient remote error) before giving up. */
  async function notesAsideRetried(row: Copy, target: Extract<AdapterExecutionTarget, { kind: "remote" }>, mode: "surface" | "clean"): Promise<number | null> {
    for (let attempt = 0; ; attempt++) {
      const result = await notesAside(row, target, mode);
      if (result !== null || attempt >= 2) return result;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  /** Fail CLOSED: retained copies that could not be surfaced (or are still
   * unsurfaced after the capture) block the stopped copy's release. It is the
   * SAME durable hold a failed save writes (holdUnsaved: receipt.savePending,
   * written under the destroy-claim lease row lock), so lease expiry, teardown
   * and destroy (agentFileSaveHeldOnLease / claimLeaseForDestroyUnlessHeld)
   * never destroy the sandbox holding the aside copies. The state stays
   * pending_collection; the recovery sweep retries; the operator gets the one
   * aside instruction (agentFileHoldInstruction). Only a later verified save
   * with the copies surfaced and cleaned ends the hold. */
  async function retainUnsurfaced(row: Copy, lateWrite?: AgentFileCanonicalWrite): Promise<Copy> {
    const asideRoot = path.posix.join(row.executionRoot, ".paperclip-runtime", "notes-aside");
    logger.error({ companyId: row.companyId, agentId: row.agentId, runId: row.runId, asideRoot },
      `Retained agent note copies could not be surfaced; the remote agent directory is kept and not released. To keep them, copy ${asideRoot} from the sandbox (${row.location}) into the agent's folder.`);
    return holdUnsaved(row, AGENT_FILES_ASIDE_UNSURFACED, "Retained note-delivery aside copies could not be surfaced",
      (row.receipt?.storageWarning as string | null | undefined) ?? null, undefined, "pending_collection", lateWrite);
  }
  async function checkpoint(row: Copy, target?: AdapterExecutionTarget | null, stopped = false, early?: Precapture, signal?: AbortSignal,
    write?: AgentFileCanonicalWrite): Promise<Copy> {
    // AF-ABORT: an aborted stopped collection starts no further remote command
    // and writes nothing (no save, no hold): the deadline owner writes the hold.
    // LATE-ABORT: once store.apply passed the canonical commit boundary the
    // abort is too late to cancel; the collection records the real outcome.
    const live = () => { if (!write?.boundary) signal?.throwIfAborted(); };
    const tooLate = () => write?.boundary === true && signal?.aborted === true;
    live();
    if (!await owns(row) || row.state === "superseded") return row;
    target ??= transports.get(key(row))?.target;
    const reusable = early && early.target === target && isDeepStrictEqual(adoptionAuthority(early.row), adoptionAuthority(row)) ? early.captured : undefined;
    if (row.location !== "local" && target?.kind !== "remote") {
      // A missing controller cache is not the remote directory. Retain the
      // pending save until its exact remote collector or destruction proof exists.
      if (agentFileSaveHeld(row)) return retryHeldSave(row);
      return patch(row, { ...(stopped ? { state: "pending_collection", processStoppedAt: row.processStoppedAt ?? new Date() } : {}),
        errorCode: "INSTRUCTION_REMOTE_COLLECTOR_UNAVAILABLE", errorMessage: "The remote agent directory is retained; its collector is unavailable. No save or discard is claimed.",
        nextAttemptAt: stopped ? new Date(Date.now() + 30_000) : null });
    }
    // (4) Retained note-delivery aside copies: surfaced BEFORE this capture so
    // a changed copy is collected by it; cleaned only after it is recorded.
    const aside = row.location !== "local" && target?.kind === "remote" && row.receipt?.notesAside === true ? target : null;
    // A failed surfacing fails CLOSED: no cleanup, and no stopped release.
    let unsurfaced = aside ? await notesAsideRetried(row, aside, "surface") === null : false;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let captured: Capture | undefined;
      try {
        live();
        const previous = row.receipt?.checkpointManifest as AgentFileManifest | undefined ?? checkpointBaseline(baseline(row));
        // Upstream's pre-lock capture is reused only when no aside surfacing ran
        // first: a surfaced note copy must be in the capture that saves it.
        captured = attempt === 0 && reusable && !aside ? reusable
          : await captureAgentFileCheckpoint({ runId: row.runId, localRoot: row.localRoot, executionRoot: row.executionRoot, previous, target, signal });
        live();
        const snapshot = checkpointSnapshot(captured.manifest);
        const nextHash = directorySnapshotSha256(snapshot);
        const changed = nextHash !== row.baseHash;
        // An unchanged run writes no agent file. Its save skips the row lock
        // when the durable head is already current for the local projection.
        live();
        const { storageWarning, conflicts } = changed
          ? await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: path.join(captured.directory, "files"), baseline: baseline(row), checkpoint: captured.manifest }, actor(row),
            { signal, onCommitBoundary: () => { if (write) write.boundary = true; } })
          : await unchangedCheckpoint(row).then(() => ({
            storageWarning: typeof row.receipt?.storageWarning === "string" ? row.receipt.storageWarning : null, conflicts: [],
          }));
        live();
        const manifest = captured.manifest, stats = captured.stats;
        const saved = (current: Copy): Partial<typeof copies.$inferInsert> => ({ state: stopped ? (changed ? "saved" : "unchanged") : "warm_saved", baseHash: nextHash,
          candidateHash: nextHash, errorCode: null, errorMessage: null, attempts: 0, nextAttemptAt: null,
          ...(stopped ? { processStoppedAt: new Date() } : {}),
          // A verified save ends any earlier failed save's hold. This warm
          // path and collectStopped's cold path both strip it.
          receipt: { ...withoutSaveHold(current.receipt), baseline: serializeDirectorySnapshot(snapshot), checkpointManifest: manifest,
            checkpointState: changed ? "saved" : "unchanged", checkpointStats: stats, storageWarning, conflicts,
            pendingConflicts: [...pendingConflicts(current), ...conflicts], ...(tooLate() ? { abortCameTooLate: true } : {}) } });
        if (tooLate()) {
          write!.recorded = true;
          row = await recordLate(row, saved, next => next.state === (changed ? "saved" : "unchanged") && next.candidateHash === nextHash);
        } else row = await patch(row, saved(row));
        if (write?.boundary) write.done = true;
        if (aside && !unsurfaced) {
          live();
          const remaining = await notesAsideRetried(row, aside, "clean");
          if (remaining === 0) row = await patch(row, { receipt: { ...row.receipt, notesAside: false } });
          // A copy left after clean changed since it was surfaced (or could not
          // be read): at the stopped boundary that is unsurfaced bytes.
          else unsurfaced = true;
        }
        if (stopped && unsurfaced) return retainUnsurfaced(row, tooLate() ? write : undefined);
        // A same-note conflict leaves the live tree as the run wrote it: the
        // sibling's version stays canonical and this run's bytes are already
        // saved as the named conflict copy. Nothing is written into a live tree
        // here. canReuse decides the next turn: a LOCAL root never takes the
        // sibling's notes in place (canonical != baseHash, so it retires and
        // restores fresh, conflict copy included); a REMOTE root takes them
        // only through refreshWarmNotes at the next idle handoff (notes only,
        // tree proven unchanged first); a declared-instruction change refuses
        // warm reuse and the stopped collection + fresh preparation restore it.
        return row;
      } catch (error) {
        live();
        failure = error;
        logger.warn({ err: error, runId: row.runId, attempt: attempt + 1, stopped }, "Agent file checkpoint failed");
        if (error instanceof HttpError && error.status < 500) break;
        // LATE-ABORT: no further attempt after the abort; the failure is recorded as it is.
        if (tooLate()) break;
        // That write did not land and no abort is pending: the next attempt
        // is before the commit boundary again, so an abort during its provider
        // calls ends the lock session at once, as for any aborted collection.
        if (write && !write.done) write.boundary = false;
      }
      finally {
        // An aborted collection leaves remote scratch to session retirement;
        // the pre-lock capture is cleaned by its owner (checkpointWarm).
        if (captured !== early?.captured && !signal?.aborted) await captured?.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent checkpoint scratch cleanup deferred to session retirement"));
      }
    }
    live();
    const rejection = failure instanceof HttpError && failure.status === 403 ? failure.message : null;
    if (!stopped) return patch(row, { errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE",
      errorMessage: rejection ? `Agent-file save rejected: ${rejection} Changes were not saved.` : "Incremental checkpoint could not be validated; collecting after provider stop.", nextAttemptAt: null });
    const storageLimit = failure instanceof AgentFileLimitError || String(failure).includes("LIMIT_EXCEEDED");
    // Fail closed: the stopped tree is the only copy of these changes. Hold it
    // (no release, no lease destruction) and retry the save durably.
    const held = await holdUnsaved(row, storageLimit ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED", failure,
      storageLimit ? agentStorageWarning(failure instanceof AgentFileLimitError ? failure.message : "Agent folder exceeds a storage limit") : null,
      undefined, "unavailable", tooLate() ? write : undefined);
    if (write?.boundary) write.done = true;
    return held;
  }
  /** Re-arms an existing hold (failed save OR unsurfaced aside copies) with the
   * shared instruction-copy backoff, keeping the hold's own operator text. */
  function retryHeldSave(row: Copy) {
    const since = (row.receipt?.savePending as { since?: string } | undefined)?.since;
    return patch(row, { errorMessage: agentFileHoldInstruction(row),
      nextAttemptAt: instructionCopyRetryAt(typeof since === "string" ? new Date(since) : row.processStoppedAt ?? row.createdAt) });
  }
  /** The one durable stopped-copy hold (receipt.savePending): a failed save
   * (state unavailable) and unsurfaced aside copies (state pending_collection,
   * code AGENT_FILES_ASIDE_UNSURFACED) both write it here. */
  function holdUnsaved(row: Copy, errorCode: string, failure: unknown, storageWarning: string | null, mirrorHash?: string,
    state: "unavailable" | "pending_collection" = "unavailable", lateWrite?: AgentFileCanonicalWrite) {
    const reason = failure instanceof HttpError || failure instanceof AgentFileLimitError || failure instanceof Error ? failure.message : String(failure);
    const held = (current: Copy): Partial<typeof copies.$inferInsert> => {
      const stoppedAt = current.processStoppedAt ?? new Date();
      const previous = current.receipt?.savePending as { since?: string; failures?: number } | undefined;
      const since = typeof previous?.since === "string" ? new Date(previous.since) : stoppedAt;
      const savePending = { since: since.toISOString(), code: errorCode, reason: reason.slice(0, 500),
        failures: (previous?.failures ?? 0) + 1, ...(mirrorHash ? { mirrorHash } : {}) };
      // LATE-ABORT: the marker belongs to the collection that writes this hold.
      const { abortCameTooLate: _earlier, ...kept } = current.receipt ?? {};
      return { state, processStoppedAt: stoppedAt, errorCode,
        errorMessage: agentFileHoldInstruction({ ...current, receipt: { ...current.receipt, savePending } }),
        nextAttemptAt: instructionCopyRetryAt(since),
        receipt: { ...kept, storageWarning, savePending, ...(lateWrite ? { abortCameTooLate: true } : {}) } };
    };
    // Same lease row lock as every destroy claim; refused once a destroy is claimed.
    if (!lateWrite) return patch(row, held(row), agentFileHoldWriteCondition);
    // LATE-ABORT: the write failed after the abort; record that on the row as it is now.
    lateWrite.recorded = true;
    return recordLate(row, held, next => (next.receipt?.savePending as { code?: unknown } | undefined)?.code === errorCode, agentFileHoldWriteCondition);
  }
  async function collectStopped(row: Copy, target?: AdapterExecutionTarget | null, signal?: AbortSignal, write?: AgentFileCanonicalWrite) {
    // AF-ABORT: re-checked before every remote command and every write.
    // LATE-ABORT: once store.apply passed the canonical commit boundary the
    // abort is too late to cancel. The collection then records the write's
    // real outcome and takes no further step: no retry, no second apply, no
    // release (the cleanup worker releases a saved copy from its receipt).
    const live = () => { if (!write?.boundary) signal?.throwIfAborted(); };
    const tooLate = () => write?.boundary === true && signal?.aborted === true;
    const marked = async (current: Copy) => tooLate() && isAgentDirectoryCopy(current) && current.receipt?.abortCameTooLate !== true
      ? patch(current, { receipt: { ...current.receipt, abortCameTooLate: true } }) : current;
    live();
    target = abortableExecutionTarget(target, signal);
    if (row.receipt?.retainedByRunId) return row;
    if (!await owns(row) || row.state === "superseded") return row;
    const held = agentFileSaveHeld(row);
    // A held remote save without its exact collector keeps the source until
    // that collector returns; only exact destruction proof settles it.
    if (held && row.location !== "local" && !transports.has(key(row)) && target?.kind !== "remote"
      && row.receipt?.warm === true) return recoverStoppedRemote(row);
    if (row.receipt?.warm === true && !settled(row)) {
      row = await checkpoint(row, target, true, undefined, signal, write);
      // Never release a stopped copy while retained aside copies are unsurfaced.
      if (row.errorCode === "AGENT_FILES_ASIDE_UNSURFACED") return row;
      live();
      if (tooLate()) return marked(row);
      await release(row, target);
      return marked((await get(row.companyId, row.runId))!);
    }
    if (settled(row)) { live(); await release(row); return (await get(row.companyId, row.runId))!; }
    // A held save whose exact tree was already retrieved into the controller
    // mirror retries from that verified mirror; no live collector is needed.
    const mirrorHash = held ? (row.receipt?.savePending as { mirrorHash?: unknown } | undefined)?.mirrorHash : undefined;
    const fromMirror = held && row.location !== "local" && typeof mirrorHash === "string" && !transports.has(key(row)) && target?.kind !== "remote";
    const remoteLease = row.location !== "local" && !fromMirror ? await ownedRemoteLease(row) : null;
    if (row.location !== "local" && !fromMirror && (!remoteLease
      || remoteLease.releasedAt || remoteLease.status !== "active" || hasRemoteTerminationReceipt(remoteLease))) {
      live();
      return recoverStoppedRemote(row);
    }
    live();
    row = await patch(row, { processStoppedAt: row.processStoppedAt ?? new Date() });
    // Adoption may win between the initial read and the stop CAS. The returned
    // current row is authoritative; a transferred alias cannot inspect or save.
    if (row.receipt?.retainedByRunId || !row.processStoppedAt) return row;
    // The stopped working copy is the only temporary tree. Retry transient I/O
    // at this boundary, then clean it up; there are no preserved run snapshots.
    let inspected: Awaited<ReturnType<typeof retrieve>> | undefined;
    for (;;) {
      live();
      row = await patch(row, { attempts: row.attempts + 1 });
      try {
        if (fromMirror && !inspected) {
          const mirrored = await inspectAgentDirectory(row.localRoot);
          if (directorySnapshotSha256(mirrored.snapshot) !== mirrorHash) throw new Error("Retained agent-file mirror changed; its source is kept for review");
          inspected = mirrored;
        }
        inspected ??= await retrieve(row, target, signal);
        live();
        const { snapshot } = inspected;
        const candidateHash = directorySnapshotSha256(snapshot);
        let storageWarning = inspected.storageWarning;
        let conflicts: AgentFileConflict[] = [];
        if (candidateHash === row.baseHash) {
          row = await patch(row, { state: "unchanged", errorCode: null, errorMessage: null, nextAttemptAt: null });
        } else {
          ({ storageWarning, conflicts } = await store.apply({ companyId: row.companyId, agentId: row.agentId, sourceDir: row.localRoot, baseline: baseline(row) }, actor(row),
            { signal, onCommitBoundary: () => { if (write) write.boundary = true; } }));
          if (tooLate()) {
            // One confirmed record of the saved write, on the row as it is now.
            write!.recorded = true;
            row = await recordLate(row, current => ({ state: "saved", candidateHash, errorCode: null, errorMessage: null, nextAttemptAt: null,
              receipt: { ...withoutSaveHold(current.receipt), storageWarning, conflicts, pendingConflicts: [...pendingConflicts(current), ...conflicts], abortCameTooLate: true } }),
              next => next.state === "saved" && next.candidateHash === candidateHash);
            write!.done = true;
            break;
          }
          row = await patch(row, { state: "saved", candidateHash, errorCode: null, errorMessage: null, nextAttemptAt: null });
        }
        row = await patch(row, { receipt: { ...withoutSaveHold(row.receipt), storageWarning, conflicts, pendingConflicts: [...pendingConflicts(row), ...conflicts] } });
        if (write?.boundary) write.done = true;
        break;
      } catch (error) {
        live();
        const retryable = !(error instanceof HttpError) || error.status >= 500;
        // LATE-ABORT: no further attempt after the abort; the failure is recorded as it is.
        if (retryable && row.attempts < 3 && !tooLate()) {
          // That write did not land and no abort is pending: back before the commit boundary.
          if (write && !write.done) write.boundary = false;
          continue;
        }
        // Fail closed: keep the stopped source, mirror, baseline, owner and
        // lease. The collection worker retries this save; nothing is discarded.
        row = await holdUnsaved(row, error instanceof AgentFileLimitError ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED", error,
          error instanceof AgentFileLimitError ? agentStorageWarning(error.message) : (row.receipt?.storageWarning as string | null | undefined) ?? null,
          inspected ? directorySnapshotSha256(inspected.snapshot) : (typeof mirrorHash === "string" ? mirrorHash : undefined),
          "unavailable", tooLate() ? write : undefined);
        if (write?.boundary) write.done = true;
        break;
      }
    }
    live();
    if (tooLate()) return marked(row);
    await release(row);
    return marked((await get(row.companyId, row.runId))!);
  }
  /**
   * A stopped collection pins its bound lease (same row lock as the destroy
   * claim) before it starts, so no destroy is claimed while it is in flight.
   * A destroy that already holds the claim refuses the collection: nothing is
   * read, saved or held here. The pin is dropped only once the collection
   * returned (saved, unchanged or held); a thrown collection keeps it (its
   * outcome is unknown) until this copy's next collection replaces it.
   */
  async function pinnedCollectStopped(row: Copy, target?: AdapterExecutionTarget | null, signal?: AbortSignal, write?: AgentFileCanonicalWrite) {
    signal?.throwIfAborted();
    const leaseId = (row.receipt?.cleanup as { leaseId?: unknown } | undefined)?.leaseId;
    if (typeof leaseId !== "string" || !leaseId) return collectStopped(row, target, signal, write);
    const copyKey = `${row.companyId}:${row.runId}:${row.agentId}`;
    const pin = await pinLeaseForCollection(db, leaseId, copyKey);
    if (pin === null) {
      logger.warn({ runId: row.runId, leaseId }, "Agent-file collection refused: a destroy holds the lease claim");
      return row;
    }
    // An aborted collection throws: its pin stays (fail closed) like any thrown collection.
    const collected = await collectStopped(row, target, signal, write);
    if (pin !== "unbound") await unpinLeaseForCollection(db, leaseId, copyKey, pin);
    return collected;
  }
  /** Called only by the instance-operator route: an explicit loss, never a save.
   * Serialize with collection and commit the receipt and attribution together
   * before giving cleanup permission to remove any bytes. */
  async function discardHeld(input: { companyId: string; runId: string; actorId: string; reason: string }) {
    const row = await get(input.companyId, input.runId);
    if (!row || !isAgentDirectoryCopy(row)) throw notFound("Agent-file hold not found");
    return serial(row, async current => {
      if (!agentFileSaveHeld(current) || !current.processStoppedAt || current.receipt?.retainedByRunId)
        throw conflict("Only this run's stopped held save can be discarded");
      const discardedAt = new Date().toISOString();
      const discard = { actorId: input.actorId, reason: input.reason, discardedAt };
      const committed = await db.transaction(async tx => {
        await notifyDirectoryCleanup(tx, { companyId: current.companyId, runId: current.runId });
        const leaseId = (current.receipt?.cleanup as { leaseId?: string } | undefined)?.leaseId;
        if (leaseId) await notifyEnvironmentCleanup(tx, { companyId: current.companyId, runId: current.runId, leaseId });
        const [updated] = await tx.update(copies).set({ state: "resolved", nextAttemptAt: new Date(),
          errorCode: "AGENT_FILES_SAVE_DISCARDED", errorMessage: "An operator discarded this unsaved agent-file copy. No save is claimed.",
          receipt: { ...withoutSaveHold(current.receipt), discard, cleanupPending: true }, updatedAt: new Date() })
          .where(and(eq(copies.companyId, current.companyId), eq(copies.runId, current.runId),
            eq(copies.state, current.state), sql`${copies.receipt} IS NOT DISTINCT FROM ${JSON.stringify(current.receipt)}::jsonb`)).returning();
        if (!updated) throw conflict("The held save changed before discard");
        const { publication } = await persistActivity(tx as unknown as Db, { companyId: current.companyId,
          actorType: "user", actorId: input.actorId, action: "agent_files.save_discarded", entityType: "agent", entityId: current.agentId,
          agentId: current.agentId, runId: current.runId, details: { ...discard, previousErrorCode: current.errorCode } });
        return { updated, publication };
      });
      publishActivity(committed.publication);
      // The discard is durable even if cleanup needs its existing recovery worker.
      await release(committed.updated).catch(error => logger.warn({ err: error, runId: current.runId }, "Discarded agent-file cleanup deferred"));
      return (await get(current.companyId, current.runId))!;
    }, "agent_directory_release");
  }
  function releaseIsNoop(row: Copy) {
    return row.state === "superseded" || !row.processStoppedAt ||
      settled(row) && row.receipt?.cleanupPending === false;
  }
  async function settleCompletedCleanupRetry(row: Copy) {
    if (settled(row) && row.processStoppedAt && !row.receipt?.retainedByRunId && row.receipt?.cleanupPending === false && row.nextAttemptAt) {
      return patch(row, { nextAttemptAt: null }, sql`${copies.receipt} = ${JSON.stringify(row.receipt)}::jsonb
        AND ${copies.processStoppedAt} IS NOT NULL`);
    }
    return row;
  }
  async function release(row: Copy, target?: AdapterExecutionTarget | null) {
    row = await settleCompletedCleanupRetry(row);
    // A held save keeps its collector, mirror, remote tree and baseline.
    if (agentFileSaveHeld(row)) return;
    if (releaseIsNoop(row) || !await owns(row)) return;
    const destroyedOnly = row.receipt?.cleanupDestroyedOnly === true;
    if (row.receipt?.retainedByRunId || row.state === "superseded" || !await owns(row) || !row.processStoppedAt) return;
    // Collection and environment teardown can both release the same copy.
    // A compact successful cleanup receipt is final, even after restart.
    if (settled(row) && row.processStoppedAt && row.receipt?.cleanupPending === false) return;
    const runtime = transports.get(key(row));
    transports.delete(key(row));
    let cleanupPending = false;
    await runtime?.cleanupWorkspaceSnapshot?.().catch(() => { cleanupPending = true; });
    const cleanupTarget = target ?? runtime?.target;
    const lease = row.location !== "local" ? await ownedRemoteLease(row) : null;
    const terminated = lease && hasRemoteTerminationReceipt(lease);
    const destroyed = destroyedOnly || terminated && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    const cleanupLeaseId = (row.receipt?.cleanup as { leaseId?: string } | undefined)?.leaseId;
    // Maintenance may run while the collector is still cached. A cached target
    // cannot override the current lease's stopped/destroyed/uncertain state.
    const remoteUnavailable = row.location !== "local" && !destroyed && (!lease || terminated
      || Boolean(lease && (lease.releasedAt || lease.status !== "active"))
      || Boolean(cleanupLeaseId && (!lease || cleanupTarget?.kind === "remote" && cleanupTarget.leaseId !== lease.id)));
    if (remoteUnavailable) cleanupPending = true;
    else if (!destroyed && row.processStoppedAt && settled(row) && cleanupTarget?.kind === "remote") {
      const expected = path.posix.join(cleanupTarget.remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId));
      if (row.executionRoot !== expected) throw new Error("Agent directory cleanup path changed");
      const paths = cleanupTarget.transport === "sandbox" ? [expected, sandboxTransferRoot(row, cleanupTarget.remoteCwd)] : [expected];
      const quoted = paths.map(p => `'${p.replaceAll("'", `'"'"'`)}'`).join(" ");
      const remoteCleanupFailed = await runAdapterExecutionTargetShellCommand(row.runId, cleanupTarget, `rm -rf -- ${quoted}`,
        { cwd: cleanupTarget.remoteCwd, env: {}, timeoutSec: 15 }).then(result => result.exitCode !== 0 || result.timedOut, () => true);
      cleanupPending ||= remoteCleanupFailed;
    } else if (!destroyed && row.processStoppedAt && settled(row) && row.location !== "local") {
      // Rebind only the current host-owned lease. Never acquire a replacement.
      cleanupPending ||= !await cleanupRemoteAfterRestart(row).catch(() => false);
    }
    if (settled(row) && row.processStoppedAt) {
      try { await fs.rm(path.dirname(row.localRoot), { recursive: true, force: true }); }
      catch {
        // Leave the baseline marker so restart recovery retries failed cleanup.
        await patch(row, { receipt: { ...row.receipt, cleanupPending: true } });
        return;
      }
      await patch(row, { receipt: { schema: AGENT_FILES_CONTRACT, state: row.state, appliedCandidateHash: row.candidateHash, storageWarning: row.receipt?.storageWarning ?? null, cleanupPending,
        ...(row.receipt?.discard ? { discard: row.receipt.discard } : {}),
        // LATE-ABORT: the final receipt keeps that this save outran its abort.
        ...(row.receipt?.abortCameTooLate === true ? { abortCameTooLate: true } : {}),
        materializationRunId: row.receipt?.materializationRunId ?? row.runId,
        // The final save receipt keeps any file kept from another writer.
        ...(Array.isArray(row.receipt?.conflicts) && row.receipt.conflicts.length ? { conflicts: row.receipt.conflicts } : {}),
        pendingConflicts: pendingConflicts(row),
        ...(row.receipt?.directoryRunId ? { directoryRunId: row.receipt.directoryRunId } : {}),
        ...(cleanupPending ? { cleanup: row.receipt?.cleanup, ...(destroyedOnly ? { cleanupDestroyedOnly: true } : {}) } : {}) },
        nextAttemptAt: cleanupPending ? new Date(Date.now() + 30_000) : null });
    }
  }
  async function destroyedRemoteCopy(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.heartbeatRunId, row.runId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId)
        : eq(environmentLeases.environmentId, row.location.slice("remote:".length)),
    ));
    if (leases.length !== 1) return false;
    const lease = await resolveRemoteTerminationLease(db, leases[0]!);
    if (lease.environmentId !== null && row.location !== `remote:${lease.environmentId}`) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    return typeof remoteCwd === "string" &&
      row.executionRoot === path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, String(row.receipt?.materializationRunId ?? row.receipt?.directoryRunId ?? row.runId)) &&
      hasRemoteTerminationReceipt(lease) && (lease.metadata?.remoteExecutionTermination as { state?: string }).state === "destroyed";
  }
  async function recoverUnavailable(row: Copy) {
    const eligible = (current: Copy) => isAgentDirectoryCopy(current) && current.location.startsWith("remote:") &&
      current.state === "unavailable" && !current.processStoppedAt;
    // Do not wait for a directory lock when no cleanup can be authorized.
    if (!eligible(row) || !await destroyedRemoteCopy(row)) return;
    await serial(row, async current => {
      if (!eligible(current) || !await destroyedRemoteCopy(current)) return;
      // The no-execute authority must survive a crash after this update. Every
      // later release, including one with a cached transport, honors it.
      const confirmed = await patch(current, { processStoppedAt: new Date(),
        receipt: { ...current.receipt, cleanupDestroyedOnly: true } });
      // A concurrent preparation can win the receipt CAS. Its bytes stay live.
      if (confirmed.state === "unavailable" && confirmed.processStoppedAt) await release(confirmed);
    }, "agent_directory_release");
  }
  async function ownedRemoteLease(row: Copy) {
    const cleanup = row.receipt?.cleanup as { leaseId?: string } | undefined;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, row.companyId), eq(environmentLeases.heartbeatRunId, row.runId),
      cleanup?.leaseId ? eq(environmentLeases.id, cleanup.leaseId) : eq(environmentLeases.environmentId, row.location.slice("remote:".length)),
    ));
    if (leases.length !== 1) return null;
    const lease = await resolveRemoteTerminationLease(db, leases[0]!);
    const destroyedWithoutEnvironment = lease.environmentId === null && hasRemoteTerminationReceipt(lease)
      && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    if (row.location !== `remote:${lease.environmentId}` && !destroyedWithoutEnvironment) return null;
    return lease;
  }
  async function recoverStoppedRemote(row: Copy) {
    const lease = await ownedRemoteLease(row);
    const destroyed = lease && hasRemoteTerminationReceipt(lease)
      && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";
    if (!destroyed) {
      if (agentFileSaveHeld(row)) return retryHeldSave(row);
      // execute (including bypassSession) may restart a stopped sandbox. Keep
      // the only remaining bytes; a stop receipt is not a destruction receipt.
      return patch(row, { state: "pending_collection", errorCode: lease ? "INSTRUCTION_STOPPED_REMOTE_COLLECTION_PENDING" : "INSTRUCTION_REMOTE_LEASE_UNVERIFIED",
        errorMessage: lease ? "The remote provider stopped with its agent directory retained. Safe stopped-file retrieval is unavailable; no save or discard is claimed."
          : "The current remote lease could not be verified. Its agent directory is preserved; no retrieval, save or discard is claimed.", nextAttemptAt: new Date(Date.now() + 30_000) });
    }
    // Exact destruction is proven: the remote bytes are already gone. A held
    // save without a verified mirror settles as a truthful loss receipt.
    row = await patch(row, { state: "unavailable", processStoppedAt: row.processStoppedAt ?? new Date(),
      errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", errorMessage: "The exact remote sandbox was destroyed before its agent directory was retrieved. No instruction save is claimed.", nextAttemptAt: null,
      ...(agentFileSaveHeld(row) ? { receipt: withoutSaveHold(row.receipt) } : {}) });
    await release(row);
    return (await get(row.companyId, row.runId))!;
  }
  async function cleanupRemoteAfterRestart(row: Copy): Promise<boolean> {
    const cleanup = row.receipt?.cleanup as { leaseId?: string; remoteCwd?: string } | undefined;
    const lease = await ownedRemoteLease(row);
    if (!lease) return false;
    const termination = lease.metadata?.remoteExecutionTermination as { state?: string } | undefined;
    if (hasRemoteTerminationReceipt(lease)) return termination?.state === "destroyed";
    // Never execute a cleanup command against a released/uncertain allocation.
    if (lease.releasedAt || lease.status !== "active") return false;
    if (!environmentRuntime || !lease.environmentId || row.location !== `remote:${lease.environmentId}`) return false;
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) return false;
    const remoteCwd = cleanup?.remoteCwd ?? lease.metadata?.remoteCwd;
    if (typeof remoteCwd !== "string" || row.executionRoot !== path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", row.agentId, typeof row.receipt?.materializationRunId === "string" ? row.receipt.materializationRunId : String(row.receipt?.directoryRunId ?? row.runId))) return false;
    const paths = environment.driver === "sandbox" ? [row.executionRoot, sandboxTransferRoot(row, remoteCwd)] : [row.executionRoot];
    const result = await environmentRuntime.execute({ environment: environment as Environment, lease: lease as EnvironmentLease, command: "rm", args: ["-rf", "--", ...paths],
      cwd: remoteCwd, env: {}, timeoutMs: 15_000, bypassSession: true });
    return result.exitCode === 0 && !result.timedOut;
  }
  async function serial<T>(row: Copy, fn: (current: Copy) => Promise<T>, operation: DirectoryMergeLockOperation, signal?: AbortSignal, late?: LateAbort<T>): Promise<T> {
    signal?.throwIfAborted();
    const run = async () => {
      const lockRoot = path.resolve(disposableRemoteCopy(row) ? projectionRoot(row) : row.localRoot, "../../..");
      if (disposableRemoteCopy(row)) await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
      return withDirectoryMergeLock(lockRoot, async () => {
        let current = await get(row.companyId, row.runId);
        if (!current) throw notFound("Agent directory copy not found");
        if (disposableRemoteCopy(current) && current.localRoot !== projectionRoot(current)) {
          current = await patch(current, { localRoot: projectionRoot(current) });
          if (current.localRoot !== projectionRoot(current)) throw conflict("Agent directory projection changed");
          transports.delete(key(current));
        }
        return fn(current);
      }, process.env, operation);
    };
    // LATE-ABORT: the directory merge lock is held by run() until it settles.
    if (!disposableRemoteCopy(row)) return late && signal ? settleLateAbort(run(), signal, late) : run();
    // Different controllers have different cache roots. Serialize their active
    // collection/cleanup operations in Postgres, without holding row locks over I/O.
    // Test instrumentation only (disarmed in production): restart chaos fails the Nth attempt with the lock's own conflict.
    crashPoint("agent_directory.operation_lock.before_acquire", { fail: () => new AgentDirectoryOperationBusyError() });
    // AF-ABORT (RFL row-22): a SESSION advisory lock on a dedicated one-connection
    // client, so no DB transaction is open while the operation does provider
    // I/O (the session is idle, never idle in transaction). The lock ends with
    // the session. withDedicatedDbConnection may keep a successful connection
    // for the next burst (upstream #21769), so the lock is released explicitly
    // on the same session when the operation settles (success, failure or
    // abort); a session that cannot prove the release is ended, never cached.
    // Same key space as before, so it conflicts with any transaction-level
    // lock on the same key.
    const lockKey = `agent-directory:${row.companyId}:${row.agentId}`;
    const held = withDedicatedDbConnection(db, async dedicated => {
      const [lock] = await dedicated.execute(sql`select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as acquired,
        (select setting::bigint from pg_settings where name = 'idle_session_timeout') as idle_timeout_ms,
        pg_backend_pid() as pid, (select backend_start::text from pg_stat_activity where pid = pg_backend_pid()) as backend_start`);
      if (lock?.acquired !== true) throw new AgentDirectoryOperationBusyError();
      try {
        const work = withWorkspaceLockKeepalive(dedicated, Number(lock.idle_timeout_ms ?? 0), run);
        if (!signal) return await work;
        // pl/cancel-finalize2 pattern (5e0eac367): the lock session is released
        // at the abort, not when a held provider call returns; the abandoned
        // work re-checks the signal and writes nothing.
        // LATE-ABORT: except while the canonical write, past its commit
        // boundary, is landing or being recorded. Then this session keeps the
        // lock (no other writer may take it meanwhile). Once the outcome is on
        // the row the session ends at an abort again, so no lock is ever kept
        // across the cleanup's provider calls.
        return await endLockSessionOnAbort(db, { pid: Number(lock.pid), backendStart: String(lock.backend_start) }, work, signal,
          () => late?.write.boundary === true && !late.write.done);
      } finally {
        await releaseOperationLock(dedicated, lockKey);
      }
    });
    // The lock session above ends only when its work settled; the caller gets
    // the bounded report (settleLateAbort).
    return late && signal ? settleLateAbort(held, signal, late) : held;
  }
  async function claimConflictNotice(input: { companyId: string; agentId: string; runId: string; previousRunId?: string | null }): Promise<string | null> {
    // A restarted preparation repeats this run's sealed notice, not another
    // run's inherited context. The pending queue is consumed atomically with it.
    const readSealed = async () => {
      const [run] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.id, input.runId)));
      const notice = run?.context?.agentFileConflictNotice as { runId?: string; text?: string } | undefined;
      return notice?.runId === input.runId && typeof notice.text === "string" ? notice.text : null;
    };
    const sealed = await readSealed();
    if (sealed) return sealed;
    const successor = await get(input.companyId, input.runId);
    const prior = input.previousRunId ? await get(input.companyId, input.previousRunId) : null;
    // Warm handoff/adoption moves the queue with its owner. Never consume a
    // transferred alias as well as its successor's copy of the same receipt.
    const source = successor && pendingConflicts(successor).length ? successor
      : prior && prior.state !== "superseded" && !prior.receipt?.retainedByRunId ? prior : null;
    if (!source || source.agentId !== input.agentId || !isAgentDirectoryCopy(source) || !pendingConflicts(source).length) return null;
    return serial(source, async current => {
      const alreadySealed = await readSealed();
      if (alreadySealed) return alreadySealed;
      const pending = pendingConflicts(current);
      if (!pending.length) return null;
      const text = [...new Map(pending.map(item => [item.path, item])).values()].map(item => item.currentKept === false
        ? `Note: ${JSON.stringify(item.path)} was also saved by another run; that version was not kept after this run's file/folder replacement. No recovery copy is claimed.`
        : `Note: ${JSON.stringify(item.path)} was also saved by another run; that version was kept. ${item.conflictCopy
          ? `Your earlier edit is saved as ${JSON.stringify(item.conflictCopy)}.`
          : "Your earlier deletion was not applied."}`).join("\n");
      await db.transaction(async tx => {
        const [run] = await tx.update(heartbeatRuns).set({ contextSnapshot:
          sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ agentFileConflictNotice: { runId: input.runId, text } })}::jsonb`,
        }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.id, input.runId))).returning({ id: heartbeatRuns.id });
        if (!run) throw notFound("Conflict notice run not found");
        await tx.update(copies).set({ receipt: { ...current.receipt, pendingConflicts: [] }, updatedAt: new Date() })
          .where(and(eq(copies.companyId, input.companyId), eq(copies.runId, current.runId)));
      });
      return text;
    }, "agent_directory_prepare");
  }
  return { prepare: (input: Parameters<typeof prepareCopy>[0]) => prepareCopy(input), hasChanges, adopt, canReuse, recoverUnavailable, claimConflictNotice, discardHeld,
    /** Exact-allocation destruction proof (the only loss that ends a hold without a save). */
    destroyedRemote: (row: Copy) => destroyedRemoteCopy(row),
    recoverStoppedRemote: (row: Copy) => serial(row, current => current.receipt?.retainedByRunId ? Promise.resolve(current) : recoverStoppedRemote(current), "agent_directory_collect"),
    checkpointWarm: (row: Copy, target?: AdapterExecutionTarget | null) => trackAgentFileCheckpoint((async () => {
      const early = await precapture(row, target);
      try {
        return await serial(row, current => current.receipt?.warm === true ? checkpoint(current, target, false, early) : Promise.resolve(current), "agent_directory_checkpoint");
      } finally {
        await early?.captured.cleanup().catch(error => logger.warn({ err: error, runId: row.runId }, "Agent checkpoint scratch cleanup deferred to session retirement"));
      }
    })()),
    collectStopped: (row: Copy, target?: AdapterExecutionTarget | null, signal?: AbortSignal) => {
      const write: AgentFileCanonicalWrite = { boundary: false, recorded: false, done: false };
      return trackAgentFileCheckpoint(serial(row, current => pinnedCollectStopped(current, target, signal, write), "agent_directory_collect", signal,
        signal ? { write, settleMs: lateAbortSettleMs, stillSaving: () => holdStillSaving(row, write), pending: () => pendingReport(row), outcome: () => recordedOutcome(row) } : undefined));
    },
    release: async (row: Copy) => {
      let current = await get(row.companyId, row.runId);
      if (!current) return;
      current = await settleCompletedCleanupRetry(current);
      // This check changes no receipt or bytes. A concurrent stop merely leaves
      // cleanup to its owner or the recovery sweep; it grants no new authority.
      if (releaseIsNoop(current) || agentFileSaveHeld(current)) return;
      await serial(current, release, "agent_directory_release");
    },
  };
}
