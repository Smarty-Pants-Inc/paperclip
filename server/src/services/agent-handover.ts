import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { activityLog, agents, approvals, budgetIncidents, chatConversations, issues, routines, type Db } from "@paperclipai/db";
import type { AgentHandoverBlockedItem, AgentHandoverMarker } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { issueService } from "./issues.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { AGENT_HANDOVER_PENDING_CODE, HANDOVER_TASK_STATUSES, isOnReportingChain, isRetiredOrRetiring,
  nearestActiveManager, pendingAgentHandover } from "./agent-handover-items.js";

export { AGENT_HANDOVER_PENDING_CODE, assertAgentRetirementHandoverAllowed } from "./agent-handover-items.js";

/**
 * Hand-over recovery for retired agents (#20389).
 *
 * The terminal lifecycle step commits the terminated state together with ONE
 * durable marker (`lifecycleOperation.handover`, shown on the agent as the named
 * pending code `agent_handover_pending`) and wakes this worker when it commits.
 * The worker then moves each item in its OWN transaction:
 * - an open task: lock the task, then the agents (checkout's order), re-read,
 *   re-check the target, reassign through the ordinary issue update, one audit row;
 * - a live report: under the company lock that serializes reporting-tree edits,
 *   lock the report, re-read, re-check the target, change only reportsTo, one audit row;
 * - an active routine: paused with one audit row (who does that work is a person's call);
 * - an open budget incident or pending override approval: closed with one audit row.
 * The target is re-checked per item: the nearest manager up the chain that is not
 * retired or retiring. With none (or a loop), the item stays put under the marker.
 * Publication happens after each item's commit. The marker clears only when no
 * open task and no live report remain. Re-running changes nothing.
 */

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "agent_handover" };
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
/** Pre-fix retirements are repaired only when this is explicitly enabled (after a dry list went to org). */
export const AGENT_HANDOVER_REPAIR_ENV = "PAPERCLIP_AGENT_HANDOVER_REPAIR_PRE_FIX";

type Outcome = { kind: "moved" | "gone" } | { kind: "blocked"; reason: string; retry: boolean };
export type AgentHandoverResult = { tasks: string[]; reports: string[]; blocked: AgentHandoverBlockedItem[]; cleared: boolean };
export type AgentHandoverDryList = { agents: number; tasks: number; reports: number; agentIds: string[]; taskIds: string[]; reportIds: string[] };

function retryDelay(attempts: number) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** The innermost cause names what failed (a query wrapper's message only repeats the SQL). */
function shortReason(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (let cause = (error as { cause?: unknown } | null)?.cause, depth = 0; cause && typeof cause === "object" && depth < 6;
    cause = (cause as { cause?: unknown }).cause, depth++) {
    const inner = (cause as { message?: unknown }).message;
    if (typeof inner === "string" && inner) message = inner;
  }
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

function publishAll(publications: ActivityPublication[]) {
  for (const publication of publications) publishActivity(publication);
}

const retiredAgentCondition = and(eq(agents.status, "terminated"), eq(agents.lifecycleState, "terminated"));
const markedCondition = sql`${agents.lifecycleOperation} ? 'handover'`;
const unmarkedWithWorkCondition = and(
  retiredAgentCondition,
  sql`not (coalesce(${agents.lifecycleOperation}, '{}'::jsonb) ? 'handover')`,
  sql`(exists (select 1 from ${issues} i where i.company_id = ${agents.companyId} and i.assignee_agent_id = ${agents.id}
      and i.status in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked'))
    or exists (select 1 from ${agents} r where r.reports_to = ${agents.id} and r.status <> 'terminated'
      and r.lifecycle_state not in ('terminating', 'cleaning_up', 'terminated', 'rejected')))`,
);

export function agentHandoverService(db: Db, options: { now?: () => Date; repairUnmarked?: boolean } = {}) {
  const now = () => options.now?.() ?? new Date();

  async function roster(tx: Db, companyId: string) {
    return tx.select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status, lifecycleState: agents.lifecycleState })
      .from(agents).where(eq(agents.companyId, companyId));
  }

  /** One open task, in its own transaction, in checkout's lock order: the task, then the agents. */
  async function moveTask(companyId: string, retiredAgentId: string, issueId: string): Promise<Outcome> {
    const publications: ActivityPublication[] = [];
    const outcome = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
      if (!issue || issue.assigneeAgentId !== retiredAgentId || !(HANDOVER_TASK_STATUSES as readonly string[]).includes(issue.status)) {
        return { kind: "gone" } as const;
      }
      // A conversation- or channel-bound task keeps its fixed identity; a person re-homes it.
      const [conversation] = await tx.select({ id: chatConversations.id }).from(chatConversations)
        .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issue.id))).limit(1);
      if (issue.conversationAgentId || conversation) return { kind: "blocked", reason: "conversation_bound", retry: false } as const;
      const target = nearestActiveManager(await roster(tx, companyId), retiredAgentId);
      if (!target) return { kind: "blocked", reason: "no_active_manager", retry: false } as const;
      // Agents after the task, in id order, as checkout locks them. Re-check the target under its lock.
      const locked = await tx.select({ id: agents.id, status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
        .where(inArray(agents.id, [retiredAgentId, target].sort())).orderBy(asc(agents.id)).for("share");
      const manager = locked.find(row => row.id === target);
      if (!manager || isRetiredOrRetiring(manager)) return { kind: "blocked", reason: "target_changed", retry: true } as const;
      await issueService(tx).update(issue.id, {
        companyGuard: companyId, assigneeAgentId: target, assigneeUserId: null,
        ...(issue.status === "in_progress" ? { status: "todo" } : {}),
      }, tx, publications, []);
      await logActivity(tx, { companyId, ...SYSTEM_ACTOR,
        action: "issue.reassigned", entityType: "issue", entityId: issue.id,
        details: { reason: "agent_terminated", previousAssigneeAgentId: retiredAgentId, assigneeAgentId: target } }, publications);
      return { kind: "moved" } as const;
    });
    publishAll(publications);
    return outcome;
  }

  /** One live report, in its own transaction, under the reporting-tree lock. Only reportsTo changes. */
  async function moveReport(companyId: string, retiredAgentId: string, reportId: string): Promise<Outcome> {
    return withAccountingTransaction(db, companyId, async (tx, publications) => {
      const [report] = await tx.select().from(agents).where(and(eq(agents.id, reportId), eq(agents.companyId, companyId))).for("update");
      if (!report || report.reportsTo !== retiredAgentId || isRetiredOrRetiring(report) && report.lifecycleState !== "pending_approval") {
        return { kind: "gone" } as const;
      }
      const rows = await roster(tx, companyId);
      const target = nearestActiveManager(rows, retiredAgentId);
      if (!target) return { kind: "blocked", reason: "no_active_manager", retry: false } as const;
      // Never a cycle: the new manager may not be the report itself or anyone below it.
      if (target === report.id || isOnReportingChain(rows, target, report.id)) return { kind: "blocked", reason: "cycle", retry: false } as const;
      await tx.update(agents).set({ reportsTo: target, updatedAt: new Date() }).where(eq(agents.id, report.id));
      await logActivity(tx, { companyId, ...SYSTEM_ACTOR,
        action: "agent.reports_to_changed", entityType: "agent", entityId: report.id,
        details: { reason: "agent_terminated", retiredAgentId, previousManagerAgentId: retiredAgentId, managerAgentId: target } }, publications);
      return { kind: "moved" } as const;
    });
  }

  /** Who does a retired agent's routine is a person's call: pause it, never re-home it. */
  async function pauseRoutines(companyId: string, retiredAgentId: string) {
    const active = await db.select({ id: routines.id }).from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, retiredAgentId), eq(routines.status, "active")))
      .orderBy(asc(routines.id));
    for (const { id } of active) {
      await withAccountingTransaction(db, companyId, async (tx, publications) => {
        const [routine] = await tx.select().from(routines).where(eq(routines.id, id)).for("update");
        if (!routine || routine.assigneeAgentId !== retiredAgentId || routine.status !== "active") return;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.routineSchedules);
        await tx.update(routines).set({ status: "paused", updatedAt: new Date() }).where(eq(routines.id, routine.id));
        await logActivity(tx, { companyId, ...SYSTEM_ACTOR, action: "routine.paused", entityType: "routine", entityId: routine.id,
          details: { reason: "agent_terminated", retiredAgentId, previousStatus: "active" } }, publications);
      });
    }
  }

  /** An open budget incident or pending override approval for the retired agent is closed, with one audit row. */
  async function closeBudgetIncidents(companyId: string, retiredAgentId: string) {
    const open = await db.select({ id: budgetIncidents.id }).from(budgetIncidents).where(and(eq(budgetIncidents.companyId, companyId),
      eq(budgetIncidents.scopeType, "agent"), eq(budgetIncidents.scopeId, retiredAgentId), eq(budgetIncidents.status, "open")))
      .orderBy(asc(budgetIncidents.id));
    for (const { id } of open) {
      await withAccountingTransaction(db, companyId, async (tx, publications) => {
        const [incident] = await tx.select().from(budgetIncidents).where(eq(budgetIncidents.id, id)).for("update");
        if (!incident || incident.status !== "open") return;
        const at = new Date();
        await tx.update(budgetIncidents).set({ status: "dismissed", resolvedAt: at, updatedAt: at }).where(eq(budgetIncidents.id, incident.id));
        let approvalClosed = false;
        if (incident.approvalId) {
          const closed = await tx.update(approvals).set({ status: "rejected", decisionNote: "The agent was retired.", decidedAt: at, updatedAt: at })
            .where(and(eq(approvals.id, incident.approvalId), eq(approvals.status, "pending"))).returning({ id: approvals.id });
          approvalClosed = closed.length > 0;
        }
        await logActivity(tx, { companyId, ...SYSTEM_ACTOR, action: "budget.incident_resolved", entityType: "budget_incident",
          entityId: incident.id, details: { action: "dismiss", reason: "agent_terminated", scopeType: "agent", scopeId: retiredAgentId,
            approvalId: incident.approvalId, approvalClosed } }, publications);
      });
    }
  }

  /**
   * Under the company lock and the retired agent's row: tell each new manager once,
   * then clear the marker if nothing remains, or record what is stuck and why.
   */
  async function settle(companyId: string, retiredAgentId: string, blocked: AgentHandoverBlockedItem[]) {
    return withAccountingTransaction(db, companyId, async (tx, publications) => {
      const [agent] = await tx.select().from(agents).where(eq(agents.id, retiredAgentId)).for("update");
      if (!agent) return true;
      const remaining = await pendingAgentHandover(tx, companyId, retiredAgentId);
      if (!remaining.reportIds.length) {
        const moved = await tx.select({ entityId: activityLog.entityId, details: activityLog.details }).from(activityLog)
          .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.reports_to_changed"),
            sql`${activityLog.details}->>'retiredAgentId' = ${retiredAgentId}`)).orderBy(asc(activityLog.entityId));
        const byManager = new Map<string, string[]>();
        for (const row of moved) {
          const managerId = (row.details as { managerAgentId?: string } | null)?.managerAgentId;
          if (managerId) byManager.set(managerId, [...byManager.get(managerId) ?? [], row.entityId]);
        }
        for (const [managerId, reportAgentIds] of byManager) {
          const [told] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, companyId),
            eq(activityLog.action, "agent.reports_received"), eq(activityLog.entityId, managerId),
            sql`${activityLog.details}->>'retiredAgentId' = ${retiredAgentId}`)).limit(1);
          if (told) continue;
          await logActivity(tx, { companyId, ...SYSTEM_ACTOR, agentId: managerId, action: "agent.reports_received",
            entityType: "agent", entityId: managerId,
            details: { reason: "agent_terminated", retiredAgentId, reportAgentIds: [...new Set(reportAgentIds)].sort() } }, publications);
        }
      }
      const marked = agent.lifecycleOperation?.handover;
      if (!remaining.taskIds.length && !remaining.reportIds.length) {
        if (marked) {
          await tx.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'handover'` }).where(eq(agents.id, agent.id));
          await logActivity(tx, { companyId, ...SYSTEM_ACTOR, action: "agent.handover_completed", entityType: "agent", entityId: agent.id,
            details: { since: marked.since } }, publications);
        }
        return true;
      }
      const still = new Set([...remaining.taskIds, ...remaining.reportIds]);
      const next: AgentHandoverMarker = { code: AGENT_HANDOVER_PENDING_CODE, since: marked?.since ?? now().toISOString(),
        ...(blocked.some(item => still.has(item.id)) ? { blocked: blocked.filter(item => still.has(item.id)) } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(marked)) {
        await tx.update(agents).set({ lifecycleOperation: sql`coalesce(${agents.lifecycleOperation}, '{}'::jsonb)
          || jsonb_build_object('handover', ${JSON.stringify(next)}::jsonb)` }).where(eq(agents.id, agent.id));
      }
      return false;
    });
  }

  async function processAgent(agentId: string, signal?: AbortSignal): Promise<AgentHandoverResult> {
    const result: AgentHandoverResult = { tasks: [], reports: [], blocked: [], cleared: false };
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    // Stop and cleanup must be proven first: only a terminated row hands over.
    if (!agent || agent.status !== "terminated" || agent.lifecycleState !== "terminated") return result;
    const marked = agent.lifecycleOperation?.handover;
    if (!marked && !options.repairUnmarked) return result;
    const previous = new Map((marked?.blocked ?? []).map(item => [item.id, item]));
    const at = now();
    const run = async (kind: "task" | "report", id: string, move: () => Promise<Outcome>) => {
      const before = previous.get(id);
      if (before?.retryAt && Date.parse(before.retryAt) > at.getTime()) { result.blocked.push(before); return; }
      let outcome: Outcome;
      try { outcome = await move(); }
      catch (error) {
        logger.warn({ err: error, agentId, itemId: id, kind }, "Agent hand-over item failed; it stays assigned and is retried with backoff");
        outcome = { kind: "blocked", reason: shortReason(error), retry: true };
      }
      if (outcome.kind === "moved") (kind === "task" ? result.tasks : result.reports).push(id);
      if (outcome.kind !== "blocked") return;
      const attempts = (before?.attempts ?? 0) + 1;
      result.blocked.push({ kind, id, reason: outcome.reason, attempts,
        ...(outcome.retry ? { retryAt: new Date(at.getTime() + retryDelay(attempts)).toISOString() } : {}) });
    };
    const pending = await pendingAgentHandover(db, agent.companyId, agentId);
    for (const id of pending.taskIds) {
      if (signal?.aborted) break;
      await run("task", id, () => moveTask(agent.companyId, agentId, id));
    }
    for (const id of pending.reportIds) {
      if (signal?.aborted) break;
      await run("report", id, () => moveReport(agent.companyId, agentId, id));
    }
    if (!signal?.aborted) {
      await pauseRoutines(agent.companyId, agentId);
      await closeBudgetIncidents(agent.companyId, agentId);
    }
    result.cleared = await settle(agent.companyId, agentId, result.blocked);
    return result;
  }

  /** Counts and ids only, for org to review before any pre-fix repair runs. */
  async function dryList(scope: { companyId?: string } = {}): Promise<AgentHandoverDryList> {
    const rows = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents)
      .where(and(unmarkedWithWorkCondition, scope.companyId ? eq(agents.companyId, scope.companyId) : undefined)).orderBy(asc(agents.id));
    const taskIds: string[] = [], reportIds: string[] = [];
    for (const row of rows) {
      const pending = await pendingAgentHandover(db, row.companyId, row.id);
      taskIds.push(...pending.taskIds); reportIds.push(...pending.reportIds);
    }
    return { agents: rows.length, tasks: taskIds.length, reports: reportIds.length,
      agentIds: rows.map(row => row.id), taskIds: taskIds.sort(), reportIds: reportIds.sort() };
  }

  /** The reconcile scan: every marked retirement, and pre-fix ones only when repair is enabled. */
  async function processPending(signal?: AbortSignal, hints?: ReadonlySet<string>) {
    let processed = 0, nextRunAt: number | null = null;
    const ids = new Set<string>();
    if (hints && !hints.has("*")) for (const hint of hints) ids.add(hint);
    else {
      let after: string | undefined;
      for (;;) {
        const page = await db.select({ id: agents.id }).from(agents).where(and(retiredAgentCondition,
          options.repairUnmarked ? sql`(${markedCondition} or ${unmarkedWithWorkCondition})` : markedCondition,
          after ? gt(agents.id, after) : undefined)).orderBy(asc(agents.id)).limit(100);
        for (const row of page) ids.add(row.id);
        if (page.length < 100) break;
        after = page.at(-1)!.id;
      }
    }
    for (const id of ids) {
      if (signal?.aborted) break;
      const result = await processAgent(id, signal);
      processed++;
      for (const item of result.blocked) {
        const due = item.retryAt ? Date.parse(item.retryAt) : null;
        if (due !== null && (nextRunAt === null || due < nextRunAt)) nextRunAt = due;
      }
    }
    return { processed, nextRunAt };
  }

  return { processAgent, processPending, dryList };
}

/**
 * The commit-bound delivery worker (as muse maintenance is): woken by the terminal
 * step's commit, and on start a reconcile scan of every marked retirement. Pre-fix
 * retirements are only listed (counts and ids) unless repair is explicitly enabled.
 */
export function startAgentHandoverRecovery(db: Db,
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  options: { repairUnmarked?: boolean } = {}) {
  const repairUnmarked = options.repairUnmarked ?? process.env[AGENT_HANDOVER_REPAIR_ENV] === "true";
  const service = agentHandoverService(db, { repairUnmarked });
  const requested = new Set<string>(["*"]);
  let nextDeadline: number | null = null;
  let listed = false;
  const worker = coordinator.register(DELIVERY_QUEUES.agentHandover, {
    retryMs: 5_000,
    onSettled: hints => { for (const hint of hints ?? ["*"]) requested.add(hint); },
    async run(signal) {
      if (nextDeadline !== null && nextDeadline <= Date.now()) requested.add("*");
      const hints = new Set(requested);
      requested.clear();
      try {
        if (!listed && !repairUnmarked) {
          const dry = await service.dryList();
          listed = true;
          if (dry.agents) logger.info({ event: "agent_handover.pre_fix_dry_list", ...dry,
            enableWith: `${AGENT_HANDOVER_REPAIR_ENV}=true` }, "Retired agents with unhanded work from before the hand-over fix (not repaired)");
        }
        const { nextRunAt } = await service.processPending(signal, hints.has("*") ? undefined : hints);
        if (hints.has("*")) nextDeadline = nextRunAt;
        else if (nextRunAt !== null && (nextDeadline === null || nextRunAt < nextDeadline)) nextDeadline = nextRunAt;
      } catch (error) {
        for (const hint of hints) requested.add(hint);
        throw error;
      }
    },
    hasPending: async () => requested.size > 0,
    nextRunAt: () => nextDeadline,
  });
  return worker;
}
