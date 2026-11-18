import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { settleUnansweredPersonMessagesForTask } from "../services/recovery/unanswered-person-message.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

// Keep (never-OK rule: no false "wasn't answered" line stays on a thread whose message WAS answered). P9-60, second
// half (RETIRE_ON_ANY_STATUS): a live unanswered-message notice whose message the one function now says is answered
// retires even when the task is DONE. The recovery worker's page query loaded only todo / in_progress / in_review
// (and blocked) tasks (work.ts register()), so on a finished task the notice stayed for good. This row runs the
// real worker, coordinator and SQL: the done task is loaded and flagged, the real sweep step retires the notice; a
// done task whose notice is still owed, and a done task with no notice, are not loaded.
describeIssueRecovery("unanswered person message: an answered notice retires on a DONE task (real recovery worker)", () => {
  const state = issueRecoveryFixture();
  const { fixture, quiet } = state;
  it("task chat, the answer arrives, the task goes done -> the notice retires; a still-owed notice on a done task stays", async () => {
    const f = await fixture();
    const db = state.db;
    const [answeredTask, owedTask, quietDone] = await db.insert(issues).values([
      { companyId: f.companyId, title: "Task chat, answered then done", status: "in_progress", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Task chat, never answered, done", status: "in_progress", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Done, nothing asked", status: "done", assigneeAgentId: f.agentId },
    ]).returning({ id: issues.id });
    const t = Date.now() - 10 * 60_000;
    const ask = async (issueId: string) => {
      const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId, body: "Is the release out?",
        authorType: "user", authorUserId: "recovery-user", createdAt: new Date(t) }).returning({ id: issueComments.id });
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", runtimeMode: "native",
        nativeIssueId: issueId, errorCode: "adapter_failed", error: "adapter_failed: the model call failed",
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message!.id },
        createdAt: new Date(t + 1000), finishedAt: new Date(t + 2000) });
      expect(await settleUnansweredPersonMessagesForTask(db, { companyId: f.companyId, issueId })).toEqual({ noticed: 1, pending: 0 });
      return message!.id;
    };
    const liveNotices = (issueId: string) => db.select({ id: issueComments.id, deletedAt: issueComments.deletedAt }).from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"),
        sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    const answered = await ask(answeredTask!.id); await ask(owedTask!.id);
    // The answer arrives: a run whose own input names the message succeeds and publishes its reply. Then both tasks go done.
    const [reply] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: answeredTask!.id, contextSnapshot: { issueId: answeredTask!.id, wakeCommentId: answered },
      createdAt: new Date(t + 60_000), finishedAt: new Date(t + 61_000) }).returning({ id: heartbeatRuns.id });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: answeredTask!.id, body: "Yes, it is out.",
      authorType: "agent", authorAgentId: f.agentId, createdByRunId: reply!.id, createdAt: new Date(t + 61_000) });
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(sql`${issues.id} in (${answeredTask!.id}, ${owedTask!.id})`);
    expect((await liveNotices(answeredTask!.id)).map(n => n.deletedAt), "before the worker pass the notice is still live").toEqual([null]);

    const visited = new Map<string, boolean | undefined>();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    state.coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => state.errors.push(error) });
    const register = state.coordinator.register.bind(state.coordinator);
    state.coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); state.passes.add(pass);
      void pass.then(() => state.passes.delete(pass), () => state.passes.delete(pass));
      return pass;
    } });
    state.worker = registerIssueRecoveryWork(db, state.coordinator, {
      // The real unanswered-message step, as heartbeat.reconcileStrandedAssignedIssues runs it for a flagged task.
      stranded: async scope => {
        visited.set(scope.issueId, scope.unanswered);
        if (scope.unanswered) await settleUnansweredPersonMessagesForTask(db, { companyId: scope.companyId, issueId: scope.issueId });
      },
      orphanBlockers: async () => {}, recoveryActions: async () => {},
      dependencies: async () => ({ enqueueFailed: 0 }), locks: async () => {},
      watchdogs: async () => ({ incomplete: 0 }), schedulingSuppressed: async () => false,
    }, () => true);
    await state.worker.ready;
    for (let step = 0; step < 120; step++) {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.allSettled([...state.passes]); await immediate();
      if (state.coordinator.nextWakeAt() === null && idleWorkSnapshot().active === 0) break;
    }
    expect(visited.get(answeredTask!.id), "the done task with an answered live notice is loaded and flagged").toBe(true);
    const retired = await liveNotices(answeredTask!.id);
    expect(retired, "no second notice").toHaveLength(1);
    expect(retired[0]!.deletedAt, "the answered message's notice retired on the DONE task").not.toBeNull();
    expect(visited.has(owedTask!.id), "a done task whose notice is still owed is not loaded").toBe(false);
    expect((await liveNotices(owedTask!.id)).map(n => n.deletedAt), "and its notice stays").toEqual([null]);
    expect(visited.has(quietDone!.id), "a done task with no notice is not loaded").toBe(false);
    await quiet();
  });
});
