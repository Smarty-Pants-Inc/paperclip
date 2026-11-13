import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeRunHistoricalSpan, NativeRunTrace } from "./native-run-trace.js";

const active = new AsyncLocalStorage<NativeControllerStepTiming>();
type Wait = { step: string; startedAtMs: number; endedAtMs?: number; outcome: "ok" | "failed" };

/** Observe existing waits only. No run-log write is awaited on the startup path. */
export function createNativeControllerStepTiming(trace: NativeRunTrace) {
  const waits: Wait[] = [];
  let finished = false;
  const pending: NativeRunHistoricalSpan[] = [];
  const finish = () => {
    finished = true;
    waits.length = 0;
    for (const span of pending.splice(0)) void trace.record(span, { deferRunLog: true }).catch(() => {});
  };
  const measure = <T>(step: string, work: () => T | PromiseLike<T>): Promise<T> => {
    if (finished || waits.length >= 2048) return Promise.resolve(work());
    const wait: Wait = { step, startedAtMs: Date.now(), outcome: "ok" };
    waits.push(wait);
    try {
      return Promise.resolve(work()).then(value => {
        wait.endedAtMs = Date.now();
        return value;
      }, error => {
        wait.endedAtMs = Date.now();
        wait.outcome = "failed";
        throw error;
      });
    } catch (error) {
      wait.endedAtMs = Date.now();
      wait.outcome = "failed";
      throw error;
    }
  };
  const flush = (phase: "resume" | "submit", startedAtMs: number, endedAtMs: number) => {
    if (finished) return;
    endedAtMs = Math.max(startedAtMs, endedAtMs);
    // Runner milestones are emitted before controller observation. Clip to the
    // same bounds as the wrapper, including a wait still active at that milestone.
    // Prefer the latest-starting (inner) wait; outer RPC remainders retain their
    // name. Thus nested DB/observer waits never double-count the wrapper's time.
    const points = [...new Set([startedAtMs, endedAtMs, ...waits.flatMap(wait => [
      Math.max(startedAtMs, Math.min(endedAtMs, wait.startedAtMs)),
      Math.max(startedAtMs, Math.min(endedAtMs, wait.endedAtMs ?? endedAtMs)),
    ])])].sort((a, b) => a - b);
    const spans: NativeRunHistoricalSpan[] = [];
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1]!, end = points[i]!;
      if (end <= start) continue;
      const wait = waits.findLast(wait => wait.startedAtMs <= start && (wait.endedAtMs ?? endedAtMs) >= end);
      if (!wait) continue; // Unobserved time is not evidence of an ingress/DB wait.
      const name = `native.controller.${phase}.${wait.step}`;
      const previous = spans.at(-1);
      if (previous?.name === name && previous.endedAtMs === start && previous.outcome === wait.outcome) previous.endedAtMs = end;
      else spans.push({ name, parentName: phase === "resume" ? "runner.session.resume" : "runner.turn.submitted_to_started",
        startedAtMs: start, endedAtMs: end, outcome: wait.outcome });
    }
    // Sub-millisecond waits still need a named receipt at Date.now precision.
    for (const wait of waits) {
      const name = `native.controller.${phase}.${wait.step}`;
      if (wait.startedAtMs >= startedAtMs && wait.startedAtMs <= endedAtMs && !spans.some(span => span.name === name)) {
        spans.push({ name, parentName: phase === "resume" ? "runner.session.resume" : "runner.turn.submitted_to_started",
          startedAtMs: wait.startedAtMs, endedAtMs: wait.startedAtMs, outcome: wait.outcome });
      }
    }
    // Do not even enqueue new writes until turn.started (or trace finish).
    // Deferred persistence still consumes the same DB pool as startup.
    pending.push(...spans);
    if (phase === "submit") finish();
  };
  return { measure, flush, finish };
}

export type NativeControllerStepTiming = ReturnType<typeof createNativeControllerStepTiming>;

export function runWithNativeControllerSteps<T>(timing: NativeControllerStepTiming, work: () => T): T {
  return active.run(timing, work);
}

/** The current attempt, not the attempt that originally created a retained transport. */
export function measureNativeControllerStep<T>(step: string, work: () => T | PromiseLike<T>): Promise<T> {
  return active.getStore()?.measure(step, work) ?? Promise.resolve(work());
}
