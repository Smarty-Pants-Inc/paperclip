import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { approvals, companies, companyMemberships, userCompanyPreferences, type Db } from "@paperclipai/db";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { resolvableApprovalStatuses } from "../lib/approval-records.js";
import { writeApprovalChange } from "./approval-work-notifications.js";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";
import { accessService } from "./access.js";
import { budgetService } from "./budgets.js";
import { companyService } from "./companies.js";
import { isCloudManagedInstance } from "./cloud-instance.js";
import { finishCompanyProvisioning } from "./company-provisioning.js";
import { logActivity } from "./activity-log.js";

import { companyCreationCardPayload, createCompanyApprovalPayloadSchema, normalizeCompanyName } from "./company-creation-approval-payload.js";
export { CREATE_COMPANY_IRREVERSIBLE_NOTICE, createCompanyApprovalPayloadSchema, normalizeCompanyName,
  reviseCompanyCreationPayload } from "./company-creation-approval-payload.js";

type AgentActor = { type: string; agentId?: string | null; companyId?: string | null };
type ApproverActor = { type: string; userId?: string | null; source?: string | null; isInstanceAdmin?: boolean };

/**
 * One create_company card per logical request. Only the owner user's selected
 * primary agent in this company may ask, and only for that user.
 */
export async function requestCompanyCreation(db: Db, input: {
  companyId: string; actor: AgentActor; payload: unknown;
}) {
  const { companyId, actor } = input;
  if (actor.type !== "agent" || !actor.agentId || actor.companyId !== companyId)
    throw forbidden("Only a person's selected primary agent can ask to create an organization for them.");
  const parsed = createCompanyApprovalPayloadSchema.safeParse(input.payload);
  if (!parsed.success) throw unprocessable("A create organization request needs the exact name, description, owner user and optional budget.",
    { issues: parsed.error.issues });
  const fields = parsed.data;
  const agentId = actor.agentId;
  const [primary] = await db.select({ agentId: userCompanyPreferences.primaryAgentId }).from(userCompanyPreferences)
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, userCompanyPreferences.companyId),
      eq(companyMemberships.principalId, userCompanyPreferences.userId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active")))
    .where(and(eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.userId, fields.ownerUserId)));
  if (primary?.agentId !== agentId)
    throw forbidden("Only the owner's selected primary agent can ask to create an organization for them.");
  const normalizedName = normalizeCompanyName(fields.name);
  const payload = companyCreationCardPayload(fields);
  return writeApprovalChange(db, companyId, async tx => {
    // Same requester and name: serialize, then join the open card.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`create_company:${companyId}:${agentId}:${normalizedName}`}))`);
    const [open] = await tx.select().from(approvals).where(and(eq(approvals.companyId, companyId),
      eq(approvals.type, "create_company"), eq(approvals.requestedByAgentId, agentId),
      inArray(approvals.status, resolvableApprovalStatuses),
      sql`${approvals.payload}->>'normalizedName' = ${normalizedName}`)).limit(1);
    if (open) return { approval: open, created: false };
    const [approval] = await tx.insert(approvals).values({
      companyId, type: "create_company", requestedByAgentId: agentId, requestedByUserId: null,
      status: "pending", payload, decisionNote: null, decidedByUserId: null, decidedAt: null, updatedAt: new Date(),
    }).returning();
    return { approval: approval!, created: true };
  });
}

/** The same gates as POST /api/companies, checked for the approver. */
export function assertCanApproveCompanyCreation(actor: ApproverActor) {
  if (isCloudManagedInstance())
    throw forbidden("Company creation is managed by Paperclip Cloud", { code: "cloud_managed" });
  if (!(actor.source === "local_implicit" || actor.isInstanceAdmin)) throw forbidden("Instance admin required");
}

/**
 * Approve a create_company card and run its effect once. The server-minted id,
 * company, membership and decision commit together. A replay returns the saved
 * result; a crash cannot leave an unproven company for a later card to adopt.
 */
export async function approveCompanyCreation(db: Db, input: {
  approvalId: string; actor: ApproverActor; decisionNote?: string | null;
}) {
  assertCanApproveCompanyCreation(input.actor);
  // One effect at a time per card. Use this transaction for every effect write,
  // not just the lock: existence alone is never proof that this card created it.
  return db.transaction(async lock => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtext(${`create_company_effect:${input.approvalId}`}))`);
    return runCompanyCreationEffect(lock as unknown as Db, input);
  });
}

async function runCompanyCreationEffect(db: Db, input: {
  approvalId: string; actor: ApproverActor; decisionNote?: string | null;
}) {
  const decidedByUserId = input.actor.userId ?? "board";
  const [current] = await db.select().from(approvals).where(eq(approvals.id, input.approvalId));
  if (!current || current.type !== "create_company") throw unprocessable("Not a create organization request");
  // Reserve the company id on the card (or reuse a reservation from an earlier attempt).
  const reserved = await writeApprovalChange(db, current.companyId, async tx => {
    const [card] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for("update");
    if (!card) throw unprocessable("Not a create organization request");
    // The owner on the card is the requester's stated intent, not authority to
    // give another person an organization. Only that person may approve it.
    if (!input.actor.userId || card.payload.ownerUserId !== input.actor.userId)
      throw conflict(`Only ${String(card.payload.ownerUserId)} can approve creating their organization`);
    const saved = typeof card.payload.createdCompanyId === "string" ? card.payload.createdCompanyId : null;
    if (card.status === "approved" && saved) return { card, companyId: saved, done: true };
    if (!resolvableApprovalStatuses.includes(card.status))
      throw unprocessable("Only pending or revision requested approvals can be approved");
    const companyId = typeof card.payload.reservedCompanyId === "string" ? card.payload.reservedCompanyId : randomUUID();
    if (card.payload.reservedCompanyId !== companyId) {
      await tx.update(approvals).set({ payload: { ...card.payload, reservedCompanyId: companyId }, updatedAt: new Date() })
        .where(eq(approvals.id, card.id));
    }
    return { card, companyId, done: false };
  }, { approvalId: input.approvalId });
  if (reserved.done) return { approval: reserved.card, companyId: reserved.companyId, applied: false };
  const fields = createCompanyApprovalPayloadSchema.parse({
    name: reserved.card.payload.name, description: reserved.card.payload.description ?? null,
    ownerUserId: reserved.card.payload.ownerUserId, budgetMonthlyCents: reserved.card.payload.budgetMonthlyCents ?? 0,
  });
  const svc = companyService(db);
  const [existing] = await db.select().from(companies).where(eq(companies.id, reserved.companyId));
  // An old or corrupt pending card must not adopt an existing organization.
  // Only the atomically saved approved result above proves a prior effect.
  if (existing) throw conflict("This organization reservation already exists and was not created by this approval.");
  const ownerUserId = input.actor.userId!;
  const company = await svc.create({ id: reserved.companyId, name: fields.name,
    description: fields.description ?? null, budgetMonthlyCents: fields.budgetMonthlyCents ?? 0,
    defaultResponsibleUserId: ownerUserId });
  await finishCompanyProvisioning(db, { access: accessService(db), budgets: budgetService(db), logActivity }, {
    company, ownerPrincipalId: ownerUserId, actorUserId: ownerUserId,
    activityDetails: { approvalId: reserved.card.id, requestedByAgentId: reserved.card.requestedByAgentId },
  });
  // Record the result and the decision together, once.
  const now = new Date();
  const decided = await writeApprovalChange(db, reserved.card.companyId, async tx => {
    await notifyToolReviewChange(tx, reserved.card.companyId);
    const [card] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId)).for("update");
    if (card!.status === "approved") return { approval: card!, applied: false };
    if (!resolvableApprovalStatuses.includes(card!.status))
      throw unprocessable("Only pending or revision requested approvals can be approved");
    const [updated] = await tx.update(approvals).set({ status: "approved", decidedByUserId,
      decisionNote: input.decisionNote ?? null, decidedAt: now, updatedAt: now,
      payload: { ...card!.payload, createdCompanyId: company.id } }).where(eq(approvals.id, card!.id)).returning();
    return { approval: updated!, applied: true };
  }, { approvalId: input.approvalId });
  return { ...decided, companyId: company.id };
}
