import { setImmediate as immediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { issueComments, issues } from "@paperclipai/db";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

// B' (Smarty fork, TEMPORARY), merge-down 3c15acd3: the stranded-assignments
// queue also visits a BLOCKED task while its person's last message is
// unanswered (work.ts register(..., alsoBlockedWhen)). #21517 added a different
// 4th parameter (`eligible`) to the same register(); dropping ours in a merge
// leaves only a query-budget guard red. This row is the behaviour: the real
// worker, coordinator and SQL load the blocked task, flagged for the
// unanswered-message step; a blocked task with no person message is not loaded.
describeIssueRecovery("unanswered person message: blocked-task discovery by the real recovery worker", () => {
  const state = issueRecoveryFixture();
  const { fixture, quiet } = state;
  it("visits a BLOCKED task whose person's last message is unanswered, flagged; leaves a quiet blocked task alone", async () => {
    const f = await fixture();
    const [asked, quietBlocked, open] = await state.db.insert(issues).values([
      { companyId: f.companyId, title: "Blocked, the person asked", status: "blocked", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Blocked, nothing asked", status: "blocked", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Open work", status: "todo", assigneeAgentId: f.agentId },
    ]).returning({ id: issues.id });
    await state.db.insert(issueComments).values({ companyId: f.companyId, issueId: asked!.id, body: "Why is this blocked?",
      authorType: "user", authorUserId: "recovery-user" });
    const visited = new Map<string, boolean | undefined>();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    state.coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, onError: error => state.errors.push(error) });
    const register = state.coordinator.register.bind(state.coordinator);
    state.coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = task.run(signal); state.passes.add(pass);
      void pass.then(() => state.passes.delete(pass), () => state.passes.delete(pass));
      return pass;
    } });
    state.worker = registerIssueRecoveryWork(state.db, state.coordinator, {
      stranded: async scope => { visited.set(scope.issueId, scope.unanswered); },
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
    expect(visited.has(asked!.id), "the blocked task with an unanswered person message is visited").toBe(true);
    expect(visited.get(asked!.id), "and flagged for the unanswered-message step").toBe(true);
    expect(visited.has(quietBlocked!.id), "a blocked task with no person message is not visited").toBe(false);
    expect(visited.get(open!.id), "open work is visited as before, not flagged").toBe(false);
    await quiet();
  });
});
