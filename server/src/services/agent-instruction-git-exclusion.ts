import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { GitExecutionError, gitExecutionAttempt, retryGitExecution, type GitExecutionAttempt } from "@paperclipai/adapter-utils/git-execution-retry";
import { logger } from "../middleware/logger.js";
import { instructionGitExcludeFailureReason, instructionGitExcludeProgram } from "./agent-instruction-files.js";
import { RemoteWorkspaceOperationTimeoutError, RemoteWorkspacePreparationTimeoutError } from "./remote-workspace-transport.js";

const AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED = "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED";
const GIT_EXCLUSION_TIMEOUT_SEC = 15;

export class AgentInstructionGitExclusionError extends GitExecutionError {
  override readonly name = "AgentInstructionGitExclusionError";
  readonly reason = AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED;
}

/** The same safe exclusion failure when its last attempt timed out. It keeps
 * upstream's typed preparation timeout, so run completion still records
 * `remote_workspace_prepare_timeout`, and carries only safe attempt records:
 * never provider stderr, an RPC error, or its cause. */
export class AgentInstructionGitExclusionTimeoutError extends RemoteWorkspacePreparationTimeoutError implements GitExecutionAttempt {
  override readonly name = "AgentInstructionGitExclusionError";
  readonly reason = AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stderrClass: GitExecutionAttempt["stderrClass"];

  constructor(message: string, readonly runId: string, readonly attempts: readonly GitExecutionAttempt[]) {
    super(new RemoteWorkspaceOperationTimeoutError("prepare", GIT_EXCLUSION_TIMEOUT_SEC * 1000), message);
    const last = attempts[attempts.length - 1]!;
    this.timedOut = last.timedOut;
    this.exitCode = last.exitCode;
    this.signal = last.signal;
    this.durationMs = last.durationMs;
    this.stderrClass = last.stderrClass;
  }
}

/** The exclusion program is idempotent. A transient exec failure or rejected
 * RPC gets one retry after one second; an unsafe path never does, even when it
 * also timed out. Each command keeps its 15-second timeout: the worst case is
 * about 31 s plus RPC overhead, not a hard wall-clock bound.
 *
 * Upstream's `instructionGitExcludeFailureReason` still names the reason in
 * the message, and a final timeout is still a typed preparation timeout. The
 * thrown error is always built here from safe fields only.
 *
 * Every remote prepare entry point must use this function (upstream's
 * `excludeRuntimeFromRemoteGit` name is an alias of it). */
export async function excludeAgentRuntimeFromGit(
  runId: string,
  target: Exclude<AdapterExecutionTarget, { kind: "local" }>,
  failure: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `node -e ${quote(instructionGitExcludeProgram)} ${quote(target.remoteCwd)}`;
  let reason = "unknown";
  await retryGitExecution({
    execute: async () => {
      // A rejected RPC is classified as transport; its text is never read.
      reason = "transport";
      const result = await runAdapterExecutionTargetShellCommand(runId, target, command,
        { cwd: target.remoteCwd, env: {}, timeoutSec: GIT_EXCLUSION_TIMEOUT_SEC });
      // Unsafe-path precedence: an unsafe verdict is named as unsafe even
      // when the command also timed out.
      const unsafe = gitExecutionAttempt(result, 0).stderrClass === "unsafe";
      reason = instructionGitExcludeFailureReason(unsafe ? { ...result, timedOut: false } : result);
      return result;
    },
    error: attempts => {
      const message = `${failure} (reason=${reason})`;
      const last = attempts[attempts.length - 1]!;
      return last.timedOut && last.stderrClass !== "unsafe"
        ? new AgentInstructionGitExclusionTimeoutError(message, runId, attempts)
        : new AgentInstructionGitExclusionError(message, runId, attempts);
    },
    warn: (details, warning) => logger.warn({ ...details, exclusionReason: reason }, warning),
    warningMessage: "Agent instruction Git exclusion failed",
  });
}
