import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { agents, budgetPolicies, budgetReservations, costEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { budgetService, computeObservedSpend } from "../../services/budgets.js";
import { reserveRunBudget } from "../../services/budget-reservations.js";

export async function assertBudgetAdmissionAtLimits(db: Db, companyId: string, agentId: string, unpricedEventCount: 0 | 1) {
  await db.insert(costEvents).values({ companyId, agentId, provider: "prior", model: "prior",
    billingType: "metered_api", costStatus: "reported", costCents: 99, occurredAt: new Date() });
  const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
    metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "1",
    unpricedUsagePolicy: "block", notifyEnabled: false }).returning();
  expect(await computeObservedSpend(db, policy)).toMatchObject({ ledgerCents: "99.0000000", unpricedEventCount });
  expect((await budgetService(db).getInvocationBlock(companyId, agentId)) === null).toBe(unpricedEventCount === 0);
  const nextRunId = randomUUID();
  await db.update(agents).set({ status: "idle", lifecycleState: "ready" }).where(eq(agents.id, agentId));
  await db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, invocationSource: "timer", status: "queued" });
  if (unpricedEventCount === 0) {
    expect(await reserveRunBudget(db, companyId, nextRunId, null)).toMatchObject({ state: "held", amountCents: "1.0000000" });
  } else {
    await expect(reserveRunBudget(db, companyId, nextRunId, null)).rejects.toThrow();
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, nextRunId))).toHaveLength(0);
  }
  await db.insert(costEvents).values({ companyId, agentId, provider: "prior", model: "increment",
    billingType: "metered_api", costStatus: "reported", costCents: 2, occurredAt: new Date() });
  expect((await computeObservedSpend(db, policy)).ledgerCents).toBe("101.0000000");
  expect(await budgetService(db).getInvocationBlock(companyId, agentId)).not.toBeNull();
  const aboveLimitRunId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: aboveLimitRunId, companyId, agentId, status: "queued" });
  await expect(reserveRunBudget(db, companyId, aboveLimitRunId, null)).rejects.toThrow();
  expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, aboveLimitRunId))).toHaveLength(0);
}
