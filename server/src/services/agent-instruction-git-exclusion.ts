import { runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { GitExecutionError, retryGitExecution } from "@paperclipai/adapter-utils/git-execution-retry";
import { logger } from "../middleware/logger.js";
import { instructionGitExcludeProgram } from "./agent-instruction-files.js";

export class AgentInstructionGitExclusionError extends GitExecutionError {
  override readonly name = "AgentInstructionGitExclusionError";
  readonly reason = "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED";
}

/** The exclusion program is idempotent. A transient exec failure gets one retry;
 * an unsafe path never does. Each command keeps its 15-second timeout: the
 * worst case is about 31 s plus RPC overhead, not a hard wall-clock bound. */
export async function excludeAgentRuntimeFromGit(
  runId: string,
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>,
  message: string,
): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `node -e ${quote(instructionGitExcludeProgram)} ${quote(target.remoteCwd)}`;
  await retryGitExecution({
    execute: () => runAdapterExecutionTargetShellCommand(runId, target, command,
      { cwd: target.remoteCwd, env: {}, timeoutSec: 15 }),
    error: attempts => new AgentInstructionGitExclusionError(message, runId, attempts),
    warn: (details, warning) => logger.warn(details, warning),
    warningMessage: "Agent instruction Git exclusion failed",
  });
}
