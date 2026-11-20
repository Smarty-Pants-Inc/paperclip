import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const HOUR = 60 * 60_000;

/**
 * Paul's boot: an idle agent in ERROR with old blocked tasks that never ran
 * (no hold, no named unblocker, not imported). The real boot path
 * (recovery/work.ts -> heartbeat registerIssueStateRecoveryWork -> assigned-work
 * sweep) must report them and leave them alone: no wake, no run, still blocked.
 */
describeIssueRecovery("assigned-work invariant at boot: never-run blocked tasks", () => {
  const state = issueRecoveryFixture();
  const { start, fixture, quiet } = state;

  async function seedNeverRunBlocked(companyId: string, agentId: string, count: number,
    values: Partial<typeof issues.$inferInsert> = {}) {
    const ids: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const [row] = await state.db.insert(issues).values({ companyId, title: `Old blocked ${index}`, status: "blocked",
        assigneeAgentId: agentId, issueNumber: index, identifier: `NR${companyId.slice(0, 4)}-${index}`,
        blockedTransitionAt: new Date(Date.now() - 2 * HOUR), updatedAt: new Date(Date.now() - 2 * HOUR),
        createdAt: new Date(Date.now() - 3 * HOUR), ...values }).returning();
      ids.push(row.id);
    }
    return ids;
  }

  it("an ERROR idle agent's three never-run blocked tasks: 0 wakes, 0 runs, still blocked, reported as declared blocks", async () => {
    const f = await fixture();
    await state.db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const ids = await seedNeverRunBlocked(f.companyId, f.agentId, 3);

    await start();
    // quiet() waits for the boot passes to settle, then advances 20 minutes
    // and requires no SQL at all: nothing was left to start later unasked.
    await quiet();

    const wakes = await state.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const runs = await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const rows = await state.db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(sql`${issues.id} = any(${sql.param(ids)}::uuid[])`);
    expect({ wakes: wakes.length, runs: runs.length }).toEqual({ wakes: 0, runs: 0 });
    expect(rows.map(row => row.status)).toEqual(["blocked", "blocked", "blocked"]);

    const report = await state.heartbeat.reportAssignedWorkInvariant(f.companyId);
    expect(report.ok).toMatchObject({ "waiting:assignee_declared_block": 3 });
    expect(report.violationCount).toBe(0);
    for (const issueId of ids) {
      expect(await state.heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId }))
        .toMatchObject({ outcome: "ok", verdict: { kind: "ok", clause: "waiting", reason: "assignee_declared_block" } });
    }
    expect(await state.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 120_000);

  it("an imported never-run blocked task is left alone at boot, as before", async () => {
    const f = await fixture();
    const [issueId] = await seedNeverRunBlocked(f.companyId, f.agentId, 1, { originKind: "company_import" });
    await start(); await quiet();
    expect(await state.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(0);
    const [row] = await state.db.select().from(issues).where(eq(issues.id, issueId));
    expect(row.status).toBe("blocked");
    expect(await state.heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "assignee_declared_block" } });
  }, 120_000);
});
