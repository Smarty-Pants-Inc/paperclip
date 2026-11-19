import { z } from "zod";
import { unprocessable } from "../errors.js";

// Approval records need payload validation, not the company-provisioning graph.
/** Said plainly on the card: approval is irreversible on hq. */
export const CREATE_COMPANY_IRREVERSIBLE_NOTICE =
  "Approving creates this new organization right away. A new organization can't be deleted on hq.";

/** The exact creation the person approves (#21271). */
export const createCompanyApprovalPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  ownerUserId: z.string().min(1),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).strict();

const reviseCompanyApprovalPayloadSchema = createCompanyApprovalPayloadSchema
  .pick({ name: true, description: true, budgetMonthlyCents: true }).partial().strict();

/** A revision changes the proposed organization, never the owner or effect ids. */
export function reviseCompanyCreationPayload(current: Record<string, unknown>, payload: unknown) {
  const parsed = reviseCompanyApprovalPayloadSchema.safeParse(payload);
  if (!parsed.success) throw unprocessable("An organization revision may change only name, description and budget.",
    { issues: parsed.error.issues });
  const fields = createCompanyApprovalPayloadSchema.parse({
    name: current.name, description: current.description ?? null, ownerUserId: current.ownerUserId,
    budgetMonthlyCents: current.budgetMonthlyCents ?? 0, ...parsed.data,
  });
  return { ...current, ...companyCreationCardPayload(fields) };
}

export function companyCreationCardPayload(fields: z.infer<typeof createCompanyApprovalPayloadSchema>) {
  return {
    ...fields,
    description: fields.description ?? null,
    budgetMonthlyCents: fields.budgetMonthlyCents ?? 0,
    title: fields.name,
    summary: `Create the new organization "${fields.name}" owned by this person. ${CREATE_COMPANY_IRREVERSIBLE_NOTICE}`,
    irreversibleNotice: CREATE_COMPANY_IRREVERSIBLE_NOTICE,
    normalizedName: normalizeCompanyName(fields.name),
  };
}

export function normalizeCompanyName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

