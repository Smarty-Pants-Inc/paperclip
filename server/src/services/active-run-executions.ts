/** The server's in-process set of live run executions: heartbeat.ts executeRun
 * adds the run when its execution starts and removes it in that execution's
 * finally. The queue's in-memory admission gate (heartbeat/queue.ts
 * predecessor_settling_in_process) reads it, so it is also the one signal that
 * says whether a stopped executor is still alive here (adopt-stopu-twoclock5). */
export const activeRunExecutions = new Set<string>();
