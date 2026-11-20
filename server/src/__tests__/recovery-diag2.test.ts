import { afterEach, expect, it, vi } from "vitest";
import { issueComments, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { registerScopedDeadlineWork } from "../services/scoped-deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type Task = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
function capture() {
  const tasks = new Map<string, Task>();
  const coordinator = { register(queue: string, task: Task) {
    tasks.set(queue, task);
    return { ready: Promise.resolve(), wake() {}, async stop() { task.onStop?.(); } };
  } } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
  return { coordinator, tasks, signal: new AbortController().signal };
}
it("records a real recovery check's kind/issue/ms/SQL/query count and pending deadline without eager SQL or parameter values", async () => {
  const f = capture(), info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  let executions = 0, clock = 0;
  const failure = new Error("private SQL failure");
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const makeClient = (): any => ({
    unsafe: (_sql: string, _params?: unknown[]) => {
      const query: any = {
        values() { return this; },
        then(resolve: any, reject: any) {
          executions++; clock += _sql.includes("private") ? 9 : 7;
          return (_sql === "select fail" ? Promise.reject(failure) : Promise.resolve([{ ok: true }])).then(resolve, reject);
        },
      };
      return query;
    },
    begin: async (callback: (tx: any) => Promise<unknown>) => callback(makeClient()),
  });
  const client = makeClient();
  const db = { $client: client,
    select: () => ({ from: (table: unknown) => ({ where: () => ({ orderBy: () => ({ limit: async () =>
      table === issueComments ? [{ issueId: "issue-a" }] : [{ id: "issue-a", companyId: "company-a" }],
    }) }) }) }), selectDistinct: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  } as unknown as Db;
  const deadline = Date.now() + 10_000;
  const worker = registerIssueRecoveryWork(db, f.coordinator, {
    stranded: async scope => {
      const lazy = client.unsafe("select 'private--literal', $tag$private dollar$tag$, 987 /* private comment */ from issues where id = $1", ["private parameter"]);
      expect(executions).toBe(0);
      await lazy.values();
      await client.begin(async (tx: any) => { await tx.unsafe("select id from issues"); });
      await expect(client.unsafe("select fail")).rejects.toBe(failure);
      scope.onDeferredDeadline(deadline);
      return { unansweredMessagesNoticed: 1 };
    }, orphanBlockers: async () => {}, recoveryActions: async () => {}, dependencies: async () => ({ enqueueFailed: 0 }),
    locks: async () => {}, watchdogs: async () => ({ incomplete: 0 }), schedulingSuppressed: async () => false,
  }, () => true);
  await f.tasks.get(DELIVERY_QUEUES.strandedAssignments)!.run(f.signal);
  const fields = info.mock.calls.map(([fields]) => fields as any);
  expect(fields.find(row => row.phase === "check")).toMatchObject({ queue: "stranded-assignments", kind: "issue",
    id: "issue-a", issueId: "issue-a", companyId: "company-a", ms: 23, sqlMs: 23, queries: 3, outcome: "note", pendingDeadline: deadline });
  expect(fields.find(row => row.phase === "pass-completed")).toMatchObject({ newlyDueCount: 1,
    dueReasons: { freshDirtyScope: 1, pendingDeadline: 0, rearmedAfterCheck: 0, scopeRescan: 0 }, dirtyHintsByKind: { "*": 1 } });
  expect(fields.find(row => row.phase === "check").slowestQuery).toBe("select ?, ?, ? ? from issues where id = $?");
  expect(JSON.stringify(fields)).not.toContain("private");
  expect(executions).toBe(3);
  await worker.stop();
});

it("attributes pending deadlines, post-check rearming, paged scans and dirty hint kinds without changing check order", async () => {
  vi.useFakeTimers(); vi.setSystemTime(20_000_000);
  const info = vi.spyOn(logger, "info").mockImplementation(() => undefined), f = capture();
  const checked: string[] = [];
  let page = 0;
  const worker = registerScopedDeadlineWork(f.coordinator, {
    queue: DELIVERY_QUEUES.strandedAssignments, minimumPassIntervalMs: 1,
    decodeScope: (hint: string) => hint === "*" ? undefined : JSON.parse(hint), matches: () => true,
    load: async () => ({ rows: [{ id: page++ === 0 ? "a" : "b", companyId: "c", dueAt: Date.now() }], complete: page !== 1 }),
    check: async entry => { checked.push(entry.id); return entry.id === "b" && checked.length === 2 ? { ...entry, dueAt: Date.now() + 100 } : null; },
  }, () => true);
  const task = f.tasks.get(DELIVERY_QUEUES.strandedAssignments)!;
  await task.run(f.signal); await vi.advanceTimersByTimeAsync(1); await task.run(f.signal);
  await vi.advanceTimersByTimeAsync(100); await task.run(f.signal);
  worker.invalidate(JSON.stringify({ companyId: "c", issueId: "b" }));
  await vi.advanceTimersByTimeAsync(1); await task.run(f.signal);
  const passes = info.mock.calls.map(([fields]) => fields as any).filter(row => row.phase === "pass-completed");
  // Continued pagination must retain existing dispatch order and exact deadlines.
  expect(checked).toEqual(["a", "b", "b", "b"]);
  expect(passes[1].dueReasons.scopeRescan).toBe(1);
  expect(passes[2].dueReasons.pendingDeadline).toBe(1);
  expect(passes[3]).toMatchObject({ dueReasons: { rearmedAfterCheck: 1 }, dirtyHintsByKind: { issue: 1 } });
  expect(task.nextRunAt?.()).toBeNull();
  await worker.stop();
});

it("caps all diagnostic lines at 200 per minute, with no per-check throttle below that cap", async () => {
  vi.useFakeTimers(); vi.setSystemTime(30_000_000);
  const info = vi.spyOn(logger, "info").mockImplementation(() => undefined), f = capture();
  const worker = registerScopedDeadlineWork(f.coordinator, {
    queue: DELIVERY_QUEUES.strandedAssignments, batchSize: 250,
    decodeScope: () => undefined, matches: () => true,
    load: async () => Array.from({ length: 250 }, (_, i) => ({ id: String(i), companyId: "c", dueAt: 0 })),
    check: async () => null,
  }, () => true);
  await f.tasks.get(DELIVERY_QUEUES.strandedAssignments)!.run(f.signal);
  expect(info).toHaveBeenCalledTimes(200);
  expect(info.mock.calls.every(([fields]) => (fields as any).phase === "check")).toBe(true);
  expect(worker.reconciliationSnapshot().reconciled).toBe(true);
  await worker.stop();
});
