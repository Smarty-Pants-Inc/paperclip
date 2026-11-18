import { z } from "zod";

export interface PrimaryAgentPreference {
  companyId: string;
  userId: string;
  primaryAgentId: string | null;
  initialized: boolean;
}

/** Company-visible primary assignments for active human members. */
export interface MemberPrimaryAgent {
  userId: string;
  agentId: string;
}

export const updatePrimaryAgentSchema = z.object({
  primaryAgentId: z.string().uuid(),
}).strict();

export type UpdatePrimaryAgent = z.infer<typeof updatePrimaryAgentSchema>;
