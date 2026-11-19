import type { Db } from "@paperclipai/db";
import type { CreateCompany } from "@paperclipai/shared";
import { accessService } from "./access.js";
import { logActivity as defaultLogActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { companyService } from "./companies.js";

type CompanyServices = {
  svc: Pick<ReturnType<typeof companyService>, "create">;
  access: Pick<ReturnType<typeof accessService>, "ensureMembership" | "ensureRoleDefaultGrants">;
  budgets: Pick<ReturnType<typeof budgetService>, "upsertPolicy">;
  logActivity?: typeof defaultLogActivity;
};

/**
 * The one company-creation effect: the company, its owner's membership and
 * owner role grants, the audit entry and an optional initial budget. POST
 * /api/companies and an approved create_company card (#21271) both call it.
 * Every step after the insert is idempotent, so an effect that resumes with
 * the same reserved `id` completes the same company instead of a second one.
 */
export async function provisionCompany(db: Db, services: CompanyServices, input: {
  company: CreateCompany & { id?: string };
  ownerPrincipalId: string;
  actorUserId: string | null;
  activityDetails?: Record<string, unknown>;
}) {
  const { svc, access, budgets } = services;
  const company = await svc.create({
    ...input.company,
    defaultResponsibleUserId: input.company.defaultResponsibleUserId ?? input.ownerPrincipalId,
  });
  await finishCompanyProvisioning(db, services, { ...input, company });
  return company;
}

export async function finishCompanyProvisioning(db: Db, services: Omit<CompanyServices, "svc">, input: {
  company: { id: string; name: string; budgetMonthlyCents: number };
  ownerPrincipalId: string;
  actorUserId: string | null;
  activityDetails?: Record<string, unknown>;
}) {
  const { access, budgets } = services;
  const logActivity = services.logActivity ?? defaultLogActivity;
  const { company, ownerPrincipalId } = input;
  await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
  await access.ensureRoleDefaultGrants(company.id, ownerPrincipalId, "owner", input.actorUserId);
  await logActivity(db, {
    companyId: company.id,
    actorType: "user",
    actorId: input.actorUserId ?? "board",
    action: "company.created",
    entityType: "company",
    entityId: company.id,
    details: { name: company.name, ...input.activityDetails },
  });
  if (company.budgetMonthlyCents > 0) {
    await budgets.upsertPolicy(
      company.id,
      {
        scopeType: "company",
        scopeId: company.id,
        amount: company.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      input.actorUserId ?? "board",
    );
  }
}
