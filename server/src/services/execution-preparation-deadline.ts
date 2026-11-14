import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../middleware/logger.js";

// A claim is not a running provider. Bound claim-to-dispatch separately from
// adapter/runtime timeouts and the five-minute process-loss recovery threshold.
export const RUN_PREPARATION_DEADLINE_MS = 45_000;
export const SETUP_PREPARATION_STALLED_CODE = "setup_preparation_stalled";

export class RunPreparationStalledError extends Error {
  readonly code = SETUP_PREPARATION_STALLED_CODE;
  constructor(readonly phase: string, readonly elapsedMs: number) {
    super(`Task setup took too long before dispatch (${phase}). No provider work started.`);
    this.name = "RunPreparationStalledError";
  }
  get resultJson() {
    return { preparation: { phase: this.phase, elapsedMs: this.elapsedMs, deadlineMs: RUN_PREPARATION_DEADLINE_MS } };
  }
}

type PreparationObserver = { runId: string; enter: (phase: string) => () => void };
const preparationScope = new AsyncLocalStorage<PreparationObserver>();

/** Timing owners report their real steps, including nested workspace waits. */
export function enterRunPreparationPhase(runId: string, phase: string): () => void {
  const observer = preparationScope.getStore();
  return observer?.runId === runId ? observer.enter(phase) : () => {};
}

/**
 * The deadline aborts preparation and asks the existing completion owner to
 * settle the run. It does NOT race a resource-acquiring operation and pretend
 * that operation stopped. Its execution promise stays tracked until it really
 * settles, and normal teardown still owns its resources. Late phase results
 * are fenced before another phase or dispatch can begin.
 */
export function createRunPreparationDeadline(input: {
  runId: string;
  controller: AbortController;
  enabled: boolean;
  onExpired: (error: RunPreparationStalledError) => Promise<void>;
}) {
  const startedAt = Date.now();
  const active = new Map<object, string>();
  let stopped = false;
  let error: RunPreparationStalledError | undefined;
  let settlement: Promise<void> | undefined;
  const expire = () => {
    if (!input.enabled || stopped || error) return;
    // Stop, shutdown and ownership loss retain their existing settlement owner.
    if (input.controller.signal.aborted) { stopped = true; return; }
    error = new RunPreparationStalledError([...active.values()].at(-1) ?? "claim", Math.max(0, Date.now() - startedAt));
    input.controller.abort(error);
    settlement = Promise.resolve().then(() => input.onExpired(error!)).catch(err => {
      logger.error({ err, runId: input.runId, errorCode: SETUP_PREPARATION_STALLED_CODE, phase: error!.phase },
        "failed to settle stalled run preparation");
    });
  };
  const timer = input.enabled ? setTimeout(expire, RUN_PREPARATION_DEADLINE_MS) : undefined;
  timer?.unref?.();
  const assertActive = () => {
    if (input.enabled && !stopped && !error && Date.now() - startedAt >= RUN_PREPARATION_DEADLINE_MS) expire();
    if (error) throw error;
    if (input.enabled && !stopped) input.controller.signal.throwIfAborted();
  };
  const observer: PreparationObserver = {
    runId: input.runId,
    enter(phase) {
      if (stopped) return () => {};
      assertActive();
      const token = {};
      active.set(token, phase);
      logger.info({ runId: input.runId, phase, elapsedMs: Math.max(0, Date.now() - startedAt) }, "heartbeat preparation phase");
      // Return acquired resources to their caller before fencing the next step;
      // throwing here could discard a cleanup handle that work just returned.
      return () => { active.delete(token); };
    },
  };
  return {
    run: <T>(work: () => Promise<T>) => preparationScope.run(observer, work),
    get error() { return error; },
    /** Call only inside the committed dispatch gate, immediately before entry. */
    dispatchStarted() { assertActive(); input.controller.signal.throwIfAborted(); stopped = true; clearTimeout(timer); active.clear(); },
    async stop() { stopped = true; clearTimeout(timer); active.clear(); await settlement; },
    async settle() { await settlement; },
  };
}
