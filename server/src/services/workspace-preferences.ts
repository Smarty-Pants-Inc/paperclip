import { eq, sql } from "drizzle-orm";
import { userWorkspacePreferences, type Db } from "@paperclipai/db";
import { isReasoningDisplay, type ReasoningDisplay, type UpdateWorkspacePreference, type WorkspacePreference } from "@paperclipai/shared";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/** Only well-formed entries leave the service, whatever the stored JSON holds. */
function agentReasoningDisplayMap(value: unknown): Record<string, ReasoningDisplay> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, display]) => isReasoningDisplay(display)));
}

export function workspacePreferenceService(db: Db) {
  async function get(userId: string): Promise<WorkspacePreference> {
    const row = await db.query.userWorkspacePreferences.findFirst({
      where: eq(userWorkspacePreferences.userId, userId),
    });
    return {
      userId,
      coordinatorWorkspaceEnabled: !(row?.classicWorkspaceEnabled ?? false),
      timeZone: row?.timeZone ?? null,
      agentReasoningDisplay: agentReasoningDisplayMap(row?.agentReasoningDisplay),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
  return {
    get,
    /** Updates only the fields the caller supplied. */
    async set(companyId: string, userId: string, update: UpdateWorkspacePreference): Promise<WorkspacePreference> {
      const changes = {
        ...(update.coordinatorWorkspaceEnabled === undefined ? {} : {
          coordinatorWorkspaceEnabled: update.coordinatorWorkspaceEnabled,
          classicWorkspaceEnabled: !update.coordinatorWorkspaceEnabled,
        }),
        ...(update.timeZone === undefined ? {} : { timeZone: update.timeZone }),
      };
      // One agent's entry changes per save; a concurrent save for another
      // agent is merged by the database, not overwritten by a stale map.
      const reasoning = update.agentReasoningDisplay;
      const insertReasoning = reasoning?.display ? { agentReasoningDisplay: { [reasoning.agentId]: reasoning.display } } : {};
      const updateReasoning = reasoning === undefined ? {} : {
        agentReasoningDisplay: reasoning.display
          ? sql`${userWorkspacePreferences.agentReasoningDisplay} || jsonb_build_object(${reasoning.agentId}::text, ${reasoning.display}::text)`
          : sql`${userWorkspacePreferences.agentReasoningDisplay} - ${reasoning.agentId}::text`,
      };
      const result = await db.transaction(async tx => {
        const txDb = tx as unknown as Db;
        await tx.insert(userWorkspacePreferences).values({ userId, ...changes, ...insertReasoning })
          .onConflictDoUpdate({
            target: userWorkspacePreferences.userId,
            set: { ...changes, ...updateReasoning, updatedAt: new Date() },
          });
        const { publication } = await persistActivity(txDb, {
          companyId, actorType: "user", actorId: userId,
          action: "workspace_preferences.updated", entityType: "user_preference", entityId: userId,
        });
        return { preference: await workspacePreferenceService(txDb).get(userId), publication };
      });
      // Persistence and its audit are already committed. A live-event failure
      // must not report that the saved personal preference was rolled back.
      try { publishActivity(result.publication); }
      catch (error) { logger.warn({ err: error }, "Could not publish workspace preference update"); }
      return result.preference;
    },
  };
}
