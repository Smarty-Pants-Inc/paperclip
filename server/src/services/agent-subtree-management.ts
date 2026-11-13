import { agents, budgetPolicies, type Db } from "@paperclipai/db";
import { addCents, compareCents, type PermissionKey } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { authorizationService, authorizationDeniedDetails, isAgentInSubtree } from "./authorization.js";
import { computeObservedSpend } from "./budget-exposure.js";
import { lockAccountingCompany } from "./accounting-transaction.js";

type Actor = Parameters<ReturnType<typeof authorizationService>["decide"]>[0]["actor"];
type Target = { id: string; companyId: string };

/** Same direct, target-scoped configure decision as resume; no suggestion/consent fallback. */
export async function assertCanManageSubordinateAgent(db: Db, actor: Actor, target: Target) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || actor.companyId !== target.companyId || actor.agentId === target.id
    || !await isAgentInSubtree(db, target.companyId, actor.agentId, target.id)) {
    throw forbidden("Agents may manage only other agents inside their current reporting subtree");
  }
  const decision = await authorizationService(db).decide({
    actor, action: "agent_config:update",
    resource: { type: "agent", companyId: target.companyId, agentId: target.id },
    scope: { targetAgentId: target.id, requiresChangeGrant: true },
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
}

/** Recheck lifecycle authority inside the company-locked writer transaction.
 * Unlike administrative grants/budgets, legacy unscoped configure stays valid. */
export async function assertAgentLifecycleAuthority(db: Db, actor: Actor, target: Target) {
  if (actor.type !== "agent") return;
  if (actor.agentId === target.id) throw forbidden("Agents cannot manage their own lifecycle.");
  const decision = await authorizationService(db).decide({
    actor, action: "agent_config:update",
    resource: { type: "agent", companyId: target.companyId, agentId: target.id },
    scope: { targetAgentId: target.id, requiresChangeGrant: true },
  });
  if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
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
  const [lead] = await db.select().from(agents).where(and(
    eq(agents.id, actor.agentId!), eq(agents.companyId, target.companyId),
  ));
  if (!lead) throw forbidden("Agent not found");
  const [policy] = await db.select().from(budgetPolicies).where(and(
    eq(budgetPolicies.companyId, target.companyId), eq(budgetPolicies.scopeType, "agent"),
    eq(budgetPolicies.scopeId, lead.id), eq(budgetPolicies.metric, "billed_cents"),
    eq(budgetPolicies.windowKind, "calendar_month_utc"),
  ));
  const limit = policy ? (policy.isActive ? policy.amount : 0) : lead.budgetMonthlyCents;
  const observed = await computeObservedSpend(db, { companyId: target.companyId, scopeType: "agent",
    scopeId: lead.id, metric: "billed_cents", windowKind: "calendar_month_utc" });
  // Zero disables enforcement, so it is not a zero-dollar delegated allowance.
  // Use the budget engine's exact ledger/live/reservation exposure, not the cached agent spend.
  if (!Number.isSafeInteger(amount) || amount <= 0 || compareCents(addCents(amount, observed.ledgerCents, observed.effectiveHeldCents), limit) > 0) {
    throw forbidden("A subordinate budget must be positive and no greater than the caller's remaining budget");
  }
}
