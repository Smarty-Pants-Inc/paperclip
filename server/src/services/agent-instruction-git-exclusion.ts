import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { logger } from "../middleware/logger.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";

type StderrClass = "eexist" | "unsafe" | "enoent" | "other";
interface ExclusionAttempt {
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stderrClass: StderrClass;
}

// Never retain provider stderr: it can contain credentials or private paths.
function classifyStderr(stderr: string): StderrClass {
  if (/\bunsafe\b/i.test(stderr)) return "unsafe";
  if (/\bEEXIST\b/i.test(stderr)) return "eexist";
  if (/\bENOENT\b/i.test(stderr)) return "enoent";
  return "other";
}

export class AgentInstructionGitExclusionError extends Error implements ExclusionAttempt {
  override readonly name = "AgentInstructionGitExclusionError";
  readonly reason = "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED";
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stderrClass: StderrClass;

  constructor(message: string, readonly runId: string, readonly attempts: readonly ExclusionAttempt[]) {
    super(message);
    const last = attempts[attempts.length - 1]!;
    this.timedOut = last.timedOut;
    this.exitCode = last.exitCode;
    this.signal = last.signal;
    this.durationMs = last.durationMs;
    this.stderrClass = last.stderrClass;
  }
}

/** The exclusion program is idempotent. A transient exec stall gets one retry;
 * an unsafe path never does. Keep each exec's existing 15-second bound. */
export async function excludeAgentRuntimeFromGit(
  runId: string,
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>,
  message: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `node -e ${quote(instructionGitExcludeProgram)} ${quote(target.remoteCwd)}`;
  const attempts: ExclusionAttempt[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    const result = await runAdapterExecutionTargetShellCommand(runId, target, command,
      { cwd: target.remoteCwd, env: {}, timeoutSec: 15 });
    if (result.exitCode === 0 && !result.timedOut) return;
    const diagnostic: ExclusionAttempt = {
      timedOut: result.timedOut, exitCode: result.exitCode, signal: result.signal,
      durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0
        ? result.durationMs : Math.round(performance.now() - started),
      stderrClass: classifyStderr(result.stderr),
    };
    attempts.push(diagnostic);
    const error = new AgentInstructionGitExclusionError(message, runId, [...attempts]);
    const willRetry = attempt === 0 && diagnostic.stderrClass !== "unsafe";
    logger.warn({ runId, reason: error.reason, ...diagnostic, attempts: error.attempts, willRetry }, "Agent instruction Git exclusion failed");
    if (!willRetry) throw error;
    // This is a single retry for an active failed operation, not an idle poll.
    await delay(1_000);
  }
}
