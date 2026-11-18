import { z } from "zod";

/** How an agent's reasoning shows in chat: folded into the turn, or inline. */
export const REASONING_DISPLAYS = ["fold", "inline"] as const;
export type ReasoningDisplay = (typeof REASONING_DISPLAYS)[number];

export function isReasoningDisplay(value: unknown): value is ReasoningDisplay {
  return value === "fold" || value === "inline";
}

/** Instance-personal presentation preference. Never changes company capabilities. */
export interface WorkspacePreference {
  userId: string;
  coordinatorWorkspaceEnabled: boolean;
  /** IANA time zone reported by the person's browser, or null when unknown. */
  timeZone: string | null;
  /**
   * The person's reasoning display per agent id, set on the agent's page.
   * An agent without an entry uses its adapter's declared default. This is
   * the person's view only: it is never part of the agent's configuration.
   */
  agentReasoningDisplay: Record<string, ReasoningDisplay>;
  updatedAt: string | null;
}

export const WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH = 64;

/** True when the runtime recognizes the value as an IANA time zone name. */
export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const updateWorkspacePreferenceSchema = z.object({
  coordinatorWorkspaceEnabled: z.boolean().optional(),
  timeZone: z.string().trim().min(1).max(WORKSPACE_PREFERENCE_TIME_ZONE_MAX_LENGTH)
    .refine(isValidIanaTimeZone, { message: "Use an IANA time zone such as America/Chicago" })
    .optional(),
  /** Set (or clear, with null) this person's reasoning display for one agent. */
  agentReasoningDisplay: z.object({
    agentId: z.string().uuid(),
    display: z.enum(REASONING_DISPLAYS).nullable(),
  }).strict().optional(),
}).strict().refine(
  value => value.coordinatorWorkspaceEnabled !== undefined || value.timeZone !== undefined
    || value.agentReasoningDisplay !== undefined,
  { message: "Provide coordinatorWorkspaceEnabled, timeZone or agentReasoningDisplay" },
);

export type UpdateWorkspacePreference = z.infer<typeof updateWorkspacePreferenceSchema>;
