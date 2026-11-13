export type TraceAppendResult = "written" | "retry" | "not_applicable";

const MAX_PENDING = 4_096;
const MAX_RETRIES = 4_096;
const RETRIES_PER_PASS = 128;

type Pending<T> = { tracePath: string; value: T; retries: number };

export class RunnerdTraceRehydrationQueue<T> {
  readonly #pending = new Map<string, Pending<T>>();

  get length() { return this.#pending.size; }

  has(tracePath: string, frameKey: string): boolean {
    return this.#pending.has(JSON.stringify([tracePath, frameKey]));
  }

  enqueue(tracePath: string, frameKey: string, value: T): boolean {
    const key = JSON.stringify([tracePath, frameKey]);
    if (this.#pending.has(key)) return true;
    if (this.#pending.size >= MAX_PENDING) return false;
    this.#pending.set(key, { tracePath, value, retries: 0 });
    return true;
  }

  flush(append: (tracePath: string, value: T) => TraceAppendResult, final = false): number {
    const count = Math.min(this.#pending.size, final ? MAX_PENDING : RETRIES_PER_PASS);
    let expired = 0;
    for (let i = 0; i < count; i++) {
      const [key, pending] = this.#pending.entries().next().value!;
      this.#pending.delete(key);
      if (append(pending.tracePath, pending.value) !== "retry") continue;
      pending.retries += 1;
      if (pending.retries >= MAX_RETRIES) expired += 1;
      else this.#pending.set(key, pending);
    }
    return expired;
  }

  clear(): void { this.#pending.clear(); }
}
