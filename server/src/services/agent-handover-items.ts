import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { assertCanManageSubordinateAgent } from "./agent-subtree-management.js";

/** The named pending code a retired agent shows until its work and reports are handed over. */
export const AGENT_HANDOVER_PENDING_CODE = "agent_handover_pending" as const;
/** A retirement that would leave live reports with no one in charge, or past the caller's authority. */
export const AGENT_HAS_LIVE_REPORTS_CODE = "agent_has_live_reports" as const;

/** Unfinished task statuses that hand over to the next manager. Terminal history never moves. */
export const HANDOVER_TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
/** A report that is itself retiring or retired is not live; its own retirement settles it. */
const NOT_LIVE_STATES = ["terminating", "cleaning_up", "terminated", "rejected"] as const;

type AgentRow = Pick<typeof agents.$inferSelect, "id" | "reportsTo" | "status" | "lifecycleState">;

export function isRetiredOrRetiring(agent: Pick<AgentRow, "status" | "lifecycleState">) {
  return agent.status === "terminated" || (NOT_LIVE_STATES as readonly string[]).includes(agent.lifecycleState)
    || agent.lifecycleState === "pending_approval";
}

export const liveReportCondition = (agentId: string) => and(
  eq(agents.reportsTo, agentId),
  sql`${agents.status} <> 'terminated'`,
  notInArray(agents.lifecycleState, [...NOT_LIVE_STATES]),
);

export const openTaskCondition = (companyId: string, agentId: string) => and(
  eq(issues.companyId, companyId),
  eq(issues.assigneeAgentId, agentId),
  inArray(issues.status, [...HANDOVER_TASK_STATUSES]),
);

/** Ids only: what is still on a retired agent. */
export async function pendingAgentHandover(db: Db, companyId: string, agentId: string) {
  const [tasks, reports] = await Promise.all([
    db.select({ id: issues.id }).from(issues).where(openTaskCondition(companyId, agentId)).orderBy(asc(issues.id)),
    db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), liveReportCondition(agentId)))
      .orderBy(asc(agents.id)),
  ]);
  return { taskIds: tasks.map(row => row.id), reportIds: reports.map(row => row.id) };
}

/**
 * Walk up from the retired agent's own manager to the nearest manager that is
 * not retired, retiring or awaiting approval. Null when none exists (a retired
 * root, or a chain of retired managers) or the chain loops. Never the agent itself.
 */
export function nearestActiveManager(roster: readonly AgentRow[], retiredAgentId: string): string | null {
  const byId = new Map(roster.map(row => [row.id, row]));
  const seen = new Set<string>([retiredAgentId]);
  for (let at = byId.get(retiredAgentId)?.reportsTo ?? null; at; at = byId.get(at)?.reportsTo ?? null) {
    if (seen.has(at)) return null;
    seen.add(at);
    const manager = byId.get(at);
    if (!manager) return null;
    if (!isRetiredOrRetiring(manager)) return manager.id;
  }
  return null;
}

/** True when `ancestorId` is on `agentId`'s reporting chain (or is it). */
export function isOnReportingChain(roster: readonly AgentRow[], agentId: string, ancestorId: string) {
  const byId = new Map(roster.map(row => [row.id, row]));
  const seen = new Set<string>();
  for (let at: string | null = agentId; at; at = byId.get(at)?.reportsTo ?? null) {
    if (at === ancestorId) return true;
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
}

type Actor = Parameters<typeof assertCanManageSubordinateAgent>[1];

/**
 * Request-time refusals for a termination, checked under the company lock
 * before any write. A root with live reports would leave them with no one in
 * charge; a caller who could not change those reports' manager through the
 * normal route must not have the recovery worker do it for them.
 */
export async function assertAgentRetirementHandoverAllowed(tx: Db, actor: Actor, target: { id: string; companyId: string }) {
  const [agent] = await tx.select().from(agents).where(and(eq(agents.id, target.id), eq(agents.companyId, target.companyId)));
  if (!agent || isRetiredOrRetiring(agent)) return;
  const reports = await tx.select({ id: agents.id, companyId: agents.companyId }).from(agents)
    .where(and(eq(agents.companyId, target.companyId), liveReportCondition(agent.id))).orderBy(asc(agents.id));
  if (!reports.length) return;
  const reportAgentIds = reports.map(report => report.id);
  const [manager] = agent.reportsTo
    ? await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent.reportsTo), eq(agents.companyId, target.companyId)))
    : [];
  if (!manager) {
    throw conflict(`Agent has live reports and no manager to hand them to: ${reportAgentIds.join(", ")}. Give them a new manager first.`, {
      code: AGENT_HAS_LIVE_REPORTS_CODE, reason: "root_agent", reportAgentIds,
    });
  }
  if (actor.type !== "agent") return;
  const denied: string[] = [];
  for (const report of reports) {
    try { await assertCanManageSubordinateAgent(tx, actor, report); }
    catch { denied.push(report.id); }
  }
  if (denied.length) {
    throw conflict(`Agent has live reports outside the caller's authority: ${denied.join(", ")}.`, {
      code: AGENT_HAS_LIVE_REPORTS_CODE, reason: "caller_lacks_authority_over_reports", reportAgentIds: denied,
    });
  }
}
