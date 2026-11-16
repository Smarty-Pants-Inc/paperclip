import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

export interface GitExecutionAttempt {
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stderrClass: "eexist" | "unsafe" | "enoent" | "other" | "transport";
}

type GitExecutionResult = Omit<GitExecutionAttempt, "durationMs" | "stderrClass"> & {
  durationMs?: number | null;
  stderr: string;
};

// Never retain provider stderr: it can contain credentials or private paths.
function classifyStderr(stderr: string): GitExecutionAttempt["stderrClass"] {
  if (/\bunsafe\b/i.test(stderr)) return "unsafe";
  if (/\bEEXIST\b/i.test(stderr)) return "eexist";
  if (/\bENOENT\b/i.test(stderr)) return "enoent";
  return "other";
}

export function gitExecutionAttempt(result: GitExecutionResult, started: number): GitExecutionAttempt {
  return {
    timedOut: result.timedOut, exitCode: result.exitCode, signal: result.signal,
    durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? result.durationMs : Math.round(performance.now() - started),
    stderrClass: classifyStderr(result.stderr),
  };
}

/** Safe diagnostics only; never attach the rejected RPC error as a cause. */
export class GitExecutionError extends Error implements GitExecutionAttempt {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stderrClass: GitExecutionAttempt["stderrClass"];

  constructor(message: string, readonly runId: string, readonly attempts: readonly GitExecutionAttempt[]) {
    super(message);
    const last = attempts[attempts.length - 1]!;
    this.timedOut = last.timedOut;
    this.exitCode = last.exitCode;
    this.signal = last.signal;
    this.durationMs = last.durationMs;
    this.stderrClass = last.stderrClass;
  }
}

export interface GitExecutionWarning extends GitExecutionAttempt {
  runId: string;
  reason: string;
  attempts: readonly GitExecutionAttempt[];
  willRetry: boolean;
}

/** Only for idempotent Git preparation commands. Keep each caller's timeout;
 * one retry adds a one-second backoff, never an idle polling loop. */
export async function retryGitExecution<T extends GitExecutionResult>(input: {
  execute: () => Promise<T>;
  error: (attempts: readonly GitExecutionAttempt[]) => GitExecutionError & { readonly reason: string };
  warn: (details: GitExecutionWarning, message: string) => void;
  warningMessage: string;
}): Promise<T> {
  const attempts: GitExecutionAttempt[] = [];
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let diagnostic: GitExecutionAttempt;
    try {
      const result = await input.execute();
      if (result.exitCode === 0 && !result.timedOut) return result;
      diagnostic = gitExecutionAttempt(result, started);
    } catch {
      // An RPC rejection is not an unsafe-path verdict. Discard provider text
      // and causes before entering the same attempt, warning, and retry path.
      diagnostic = {
        timedOut: false, exitCode: null, signal: null,
        durationMs: Math.round(performance.now() - started), stderrClass: "transport",
      };
    }
    attempts.push(diagnostic);
    const error = input.error([...attempts]);
    const willRetry = attempt === 0 && diagnostic.stderrClass !== "unsafe";
    input.warn({ runId: error.runId, reason: error.reason, ...diagnostic, attempts: error.attempts, willRetry }, input.warningMessage);
    if (!willRetry) throw error;
    await delay(1_000);
  }
}
