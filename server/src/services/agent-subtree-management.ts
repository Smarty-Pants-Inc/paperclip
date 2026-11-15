import { agents, projects, type Db } from "@paperclipai/db";
import { type BudgetScopeType, type PermissionKey } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { authorizationService, authorizationDeniedDetails, isAgentInSubtree } from "./authorization.js";
import { lockAccountingCompany } from "./accounting-transaction.js";

type Actor = Parameters<ReturnType<typeof authorizationService>["decide"]>[0]["actor"];
type Target = { id: string; companyId: string };

/** Same direct, target-scoped configure decision as resume; no suggestion/consent fallback.
 * Reporting position and role are caller-editable, not principal authority. */
export async function assertCanManageSubordinateAgent(
  db: Db, actor: Actor, target: Target,
) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || actor.companyId !== target.companyId || actor.agentId === target.id) {
    throw forbidden("Agents may manage only other agents inside their current reporting subtree");
  }
  if (!await isAgentInSubtree(db, target.companyId, actor.agentId, target.id)) {
    throw forbidden("Agents may manage only other agents inside their current reporting subtree");
  }
  const decision = await authorizationService(db).decide({
    actor, action: "agent_config:update",
    resource: { type: "agent", companyId: target.companyId, agentId: target.id },
    scope: { targetAgentId: target.id, requiresChangeGrant: true },
  });
  if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
}

/** Recheck the strict reporting-subtree boundary inside the company-locked writer.
 * A configure grant, even unscoped or naming the target, never widens that tree. */
export async function assertAgentLifecycleAuthority(
  db: Db, actor: Actor, target: Target, command?: "pause" | "resume" | "terminate",
) {
  if (actor.type !== "agent") return;
  if (actor.agentId === target.id) throw forbidden("Agents cannot manage their own lifecycle.");
  await assertCanManageSubordinateAgent(db, actor, target);
  if (command === "terminate") {
    const [current] = await db.select({ status: agents.status }).from(agents).where(and(
      eq(agents.id, target.id), eq(agents.companyId, target.companyId),
    ));
    // Check the saved state, not the route's pre-lock snapshot. Every termination
    // entry point must preserve the same board-only pending-hire boundary.
    if (current?.status === "pending_approval") {
      throw forbidden("Only a board user can reject a pending hire; agent approval deciders are not supported.");
    }
  }
}

/** Internal managed-work writers join the same company mutex as reportsTo.
 * An accepted wake/Stop intent is the linearization point; async execution may
 * finish after a later reparent without granting a new management request. */
export async function lockAgentLifecycleAuthority(db: Db, actor: Actor | undefined, target: Target) {
  if (actor?.type !== "agent") return;
  await lockAccountingCompany(db, target.companyId);
  await assertAgentLifecycleAuthority(db, actor, target);
}

/** Delegation is bounded by both the caller's explicit grant and its current subtree. */
export async function subordinatePermissionScope(
  db: Db, actor: Actor, target: Target, permissionKey: PermissionKey,
  scope: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  await assertCanManageSubordinateAgent(db, actor, target);
  if (actor.type !== "agent" || !actor.agentId) throw forbidden("Agent authority required");
  const delegated = scope === undefined ? { subtreeRootAgentId: target.id } : scope;
  if (!delegated) throw forbidden("Agents cannot delegate an unscoped permission");
  const authorization = authorizationService(db);
  const effective = await authorization.decide({ actor, action: permissionKey,
    resource: { type: "agent", companyId: target.companyId, agentId: target.id },
    scope: { targetAgentId: target.id } });
  if (!effective.allowed) throw forbidden(effective.explanation);
  const grant = await authorization.decidePrincipalGrant({ companyId: target.companyId,
    principalType: "agent", principalId: actor.agentId, permissionKey, action: permissionKey,
    scope: { targetAgentId: target.id } });
  if (!grant.allowed) throw forbidden(`Cannot delegate a permission the caller does not hold: ${permissionKey}`);
  const source = grant.grant?.scope;
  // Fail closed on compound/unknown source constraints. Such grants need a board editor,
  // not a guess about set containment that might silently drop a constraint.
  const sourceSubtrees = source && Object.keys(source).length > 0
    ? onlySubtreeRoots(source) : null;
  if (source && Object.keys(source).length > 0 && !sourceSubtrees) {
    // Exact finite agent sets can be narrowed too, but cannot authorize entire subtrees.
    if (Object.keys(delegated).some(key => key !== "agentIds")) throw forbidden("Cannot widen the caller's permission scope");
  }
  const subtrees = typeof delegated.subtreeRootAgentId === "string" ? [delegated.subtreeRootAgentId] : [];
  const exact = Array.isArray(delegated.agentIds) ? delegated.agentIds as string[] : [];
  for (const value of (Array.isArray(delegated.allow) ? delegated.allow : []) as string[]) {
    const [kind, id] = value.split(":");
    (kind === "subtree" ? subtrees : exact).push(id!);
  }
  if (subtrees.length + exact.length === 0) throw forbidden("A bounded agent permission scope is required");
  for (const id of [...subtrees, ...exact]) {
    if (id === actor.agentId || !await isAgentInSubtree(db, target.companyId, actor.agentId, id)) {
      throw forbidden("Cannot delegate permission outside the caller's subtree");
    }
    if (sourceSubtrees) {
      let contained = false;
      for (const root of sourceSubtrees) if (await isAgentInSubtree(db, target.companyId, root, id)) contained = true;
      if (!contained) throw forbidden("Cannot widen the caller's permission scope");
    }
    const decision = await authorization.decidePrincipalGrant({ companyId: target.companyId,
      principalType: "agent", principalId: actor.agentId, permissionKey, action: permissionKey,
      scope: { targetAgentId: id } });
    if (!decision.allowed) throw forbidden("Cannot widen the caller's permission scope");
  }
  return delegated;
}

function onlySubtreeRoots(scope: Record<string, unknown>): string[] | null {
  if (Object.keys(scope).length === 1 && typeof scope.subtreeRootAgentId === "string") return [scope.subtreeRootAgentId];
  if (Object.keys(scope).length === 1 && Array.isArray(scope.allow)
    && scope.allow.length > 0 && scope.allow.every(value => typeof value === "string" && value.startsWith("subtree:"))) {
    return (scope.allow as string[]).map(value => value.slice("subtree:".length));
  }
  return null;
}

export async function assertSubordinateBudgetChange(db: Db, actor: Actor, target: Target, amount: number) {
  if (actor.type !== "agent") return;
  await assertCanManageSubordinateAgent(db, actor, target);
  // Setting a report's policy is not spending against the hirer's allowance.
  // Zero means unlimited for this scope; company enforcement remains the cap.
  if (!Number.isSafeInteger(amount) || amount < 0) throw forbidden("A subordinate budget must be a nonnegative integer");
}

/** Called inside the existing company-locked budget writer, shared with
 * reportsTo mutations. Role/title do not confer primary authority. */
export async function assertAgentBudgetPolicyChange(
  db: Db, actor: Actor, companyId: string,
  scope: { scopeType: BudgetScopeType; scopeId: string; amount?: number },
) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || actor.companyId !== companyId) throw forbidden("Budget scope must belong to the caller's company");
  if (scope.scopeType === "agent") {
    await assertCanManageSubordinateAgent(db, actor, { id: scope.scopeId, companyId });
    if (scope.amount !== undefined) await assertSubordinateBudgetChange(db, actor, { id: scope.scopeId, companyId }, scope.amount);
    return;
  }
  const [caller] = await db.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
  if (!caller) throw forbidden("Agent not found");
  if (scope.scopeType === "company") {
    if (scope.scopeId !== companyId || caller.reportsTo !== null) throw forbidden("Only a primary agent (reportsTo null) may change the company budget");
    return;
  }
  const [project] = await db.select().from(projects).where(and(eq(projects.id, scope.scopeId), eq(projects.companyId, companyId))).for("update");
  if (!project?.leadAgentId) throw forbidden("Agents may change only the budgets of projects they lead");
  if (project.leadAgentId !== actor.agentId) {
    await assertCanManageSubordinateAgent(db, actor, { id: project.leadAgentId, companyId });
  }
}
