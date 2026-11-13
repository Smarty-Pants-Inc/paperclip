import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const emptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;

export interface RetainedPiSourceEvidence {
  owner: { phase: string; leaseOwner: string | null; resultId: string | null; recoveryState: string | null };
  runStatus: string;
  terminationReceipt: boolean;
  leaseHandoff: boolean;
  identity: Record<string, string>;
  providerSessionId: string;
  runnerState: unknown;
  providerState: unknown;
  processesAbsent: boolean;
}

/** A failed business turn is not a committed result. Only a separately stopped,
 * authoritative idle Pi checkpoint may cross this read-only admission boundary.
 * This never settles/replays a turn or retires process-scoped authority. */
export function isQuiescentRetainedPiSource(input: RetainedPiSourceEvidence): boolean {
  const runner = record(input.runnerState), provider = record(input.providerState);
  const pendingTools = record(provider.toolBridge).pending;
  return input.owner.phase === "terminal_failure" && input.owner.leaseOwner === null
    && input.owner.resultId === null && input.owner.recoveryState === null
    && ["cancelled", "failed", "interrupted", "timed_out"].includes(input.runStatus)
    && input.terminationReceipt === true && input.leaseHandoff === true && input.processesAbsent === true
    && ["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"]
      .every(key => typeof input.identity[key] === "string" && input.identity[key].length > 0 && runner[key] === input.identity[key])
    && runner.schema === "paperclip.runner.durable.state.v1" && runner.lifecycle === "suspended"
    && emptyArray(runner.outbox) && runner.pendingTerminalDelivery === null
    && runner.pendingProviderCleanup == null && runner.warmTransition == null && runner.recoverableFailure == null
    && provider.schema === "paperclip.runner.codex-provider-state.v1"
    && record(provider.config).provider === "pi_rpc" && record(provider.config).driver === "pi_rpc"
    && provider.lifecycle === "session_open" && provider.completedTurnAuthoritative === true
    && typeof input.providerSessionId === "string" && input.providerSessionId.length > 0
    && provider.providerSessionId === input.providerSessionId && provider.threadId === input.providerSessionId
    && provider.activeProviderTurnId === null && provider.startupAttempt === null
    && provider.ambiguousTurnStartPending === false && provider.receiptLimitInterruptPending !== true
    && emptyArray(provider.pendingEvents) && emptyArray(provider.queuedEvents)
    && pendingTools !== null && typeof pendingTools === "object" && !Array.isArray(pendingTools)
    && Object.keys(pendingTools).length === 0;
}

/** Read-only consumption of runnerd's existing process-lineage journal contract:
 * writer markers bind exact births; a provider journal is removed ONLY after
 * runnerd proves its entire lineage gone (process_lineage/journal.rs::retire).
 * Any remaining journal, live/reused PID, unsafe/missing file or unreadable proc
 * keeps the refusal. No signal, journal deletion or synthetic stop receipt. */
export const READ_STOPPED_REMOTE_PI_SOURCE = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [directory, expectedRunnerId] = process.argv.slice(1);
const reads = new Map();
function read(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw Error("unsafe source");
  const bytes = fs.readFileSync(file, "utf8"); reads.set(file, bytes); return bytes;
}
function absent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("invalid birth");
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const end = stat.lastIndexOf(") ");
    if (end < 0 || !stat.startsWith(pid + " (")) throw Error("invalid proc");
    if (stat.slice(end + 2).split(/\s+/)[0] !== "Z") throw Error("live or reused PID");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
try {
  if (process.platform !== "linux") throw Error("unsupported process proof");
  const marker = read(path.join(directory, "runner-process.identity"), 4096).trim().split("\n");
  const [nonce, rawPid, startedAt, runnerId, fingerprint] = marker;
  const birth = /^linux:([a-f0-9-]+):([0-9]+)$/.exec(fingerprint || "");
  if (marker.length !== 5 || !nonce || !Number.isFinite(Date.parse(startedAt)) || runnerId !== expectedRunnerId || !birth)
    throw Error("invalid runner marker");
  // A different boot is not a license to trust a transplanted lineage marker.
  if (fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== birth[1]) throw Error("boot changed");
  const pid = Number(rawPid); absent(pid);
  const lineage = path.join(directory, "process-lineage");
  const stat = fs.lstatSync(lineage);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("unsafe lineage");
  const names = fs.readdirSync(lineage).sort();
  if (!names.includes("writer-" + pid + ".json") || names.some(name => !/^writer-[1-9][0-9]*\.json$/.test(name)))
    throw Error("unretired or unknown lineage");
  for (const name of names) {
    const value = JSON.parse(read(path.join(lineage, name), 4096));
    const writer = value.writer;
    if (value.schema !== "paperclip.runner.process-lineage-writer.v1" || !writer
      || name !== "writer-" + writer.pid + ".json" || !Number.isSafeInteger(writer.started) || writer.started <= 0
      || (writer.pid === pid && String(writer.started) !== birth[2])) throw Error("invalid lineage birth");
    absent(writer.pid);
  }
  const runnerState = JSON.parse(read(path.join(directory, "runner-state.json"), 8 * 1024 * 1024));
  const providerState = JSON.parse(read(path.join(directory, "codex-provider-state.json"), 8 * 1024 * 1024));
  // Freeze the measured generation across the complete observation.
  for (const [file, bytes] of reads) if (read(file, 8 * 1024 * 1024) !== bytes) throw Error("source changed");
  if (JSON.stringify(fs.readdirSync(lineage).sort()) !== JSON.stringify(names)) throw Error("lineage changed");
  absent(pid);
  process.stdout.write(JSON.stringify({ runnerState, providerState, processesAbsent: true }));
} catch { process.exitCode = 1; }
`;

export async function readStoppedRemotePiSource(input: {
  runner: CommandManagedRuntimeRunner; remoteCwd: string; normalizedSessionId: string; runnerInstanceId: string;
}): Promise<{ runnerState: unknown; providerState: unknown; processesAbsent: boolean } | null> {
  const stateDirectory = posix.join(input.remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions",
    createHash("sha256").update(input.normalizedSessionId).digest("hex"), "runner");
  const result = await input.runner.execute({ command: "node", args: ["-e", READ_STOPPED_REMOTE_PI_SOURCE,
    stateDirectory, input.runnerInstanceId], bypassSession: true, timeoutMs: 10_000 });
  if (result.exitCode !== 0 || result.timedOut) return null;
  try {
    const value = record(JSON.parse(result.stdout));
    return { runnerState: value.runnerState, providerState: value.providerState, processesAbsent: value.processesAbsent === true };
  } catch { return null; }
}
