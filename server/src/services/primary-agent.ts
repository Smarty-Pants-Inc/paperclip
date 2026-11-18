import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, userCompanyPreferences, type Db } from "@paperclipai/db";
import type { MemberPrimaryAgent, PrimaryAgentPreference } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { resourceMembershipService } from "./resource-memberships.js";

const preferenceWhere = (companyId: string, userId: string) => and(
  eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.userId, userId),
);

/** Call inside the transaction that creates the human's agent. The unique key
 * arbitrates concurrent first creations; an explicit or cleared choice wins.
 * Pass the root transaction's post-commit `publications` so the entry reaches
 * live subscribers once, after commit; without them it is persisted only. */
export async function initializePrimaryAgent(db: Db, companyId: string, userId: string, agentId: string,
  publications?: ActivityPublication[]) {
  const [row] = await db.insert(userCompanyPreferences).values({
    companyId, userId, primaryAgentId: agentId, primaryAgentInitialized: true,
  }).onConflictDoUpdate({
    target: [userCompanyPreferences.companyId, userCompanyPreferences.userId],
    set: { primaryAgentId: agentId, primaryAgentInitialized: true, updatedAt: new Date() },
    setWhere: eq(userCompanyPreferences.primaryAgentInitialized, false),
  }).returning();
  if (row) {
    const { publication } = await persistActivity(db, {
      companyId, actorType: "user", actorId: userId, action: "primary_agent.initialized",
      entityType: "user_preference", entityId: userId,
    });
    publications?.push(publication);
  }
}

/** Keep initialization sticky when the primary leaves or is terminated.
 * `publications`: the root transaction's post-commit buffer (see above). */
export async function clearPrimaryAgent(db: Db, companyId: string, agentId: string, userId?: string,
  publications?: ActivityPublication[]) {
  const rows = await db.update(userCompanyPreferences).set({
    primaryAgentId: null, updatedAt: new Date(),
  }).where(and(
    eq(userCompanyPreferences.companyId, companyId), eq(userCompanyPreferences.primaryAgentId, agentId),
    userId ? eq(userCompanyPreferences.userId, userId) : undefined,
  )).returning();
  for (const row of rows) {
    const { publication } = await persistActivity(db, {
      companyId, actorType: "system", actorId: "primary-agent-lifecycle", action: "primary_agent.cleared",
      entityType: "user_preference", entityId: row.userId,
    });
    publications?.push(publication);
  }
}

export function primaryAgentService(db: Db) {
  async function get(companyId: string, userId: string): Promise<PrimaryAgentPreference> {
    const row = await db.query.userCompanyPreferences.findFirst({ where: preferenceWhere(companyId, userId) });
    return { companyId, userId, primaryAgentId: row?.primaryAgentId ?? null, initialized: row?.primaryAgentInitialized ?? false };
  }
  return {
    get,
    async list(companyId: string): Promise<MemberPrimaryAgent[]> {
      return db.select({ userId: userCompanyPreferences.userId, agentId: agents.id })
        .from(userCompanyPreferences)
        .innerJoin(companyMemberships, and(
          eq(companyMemberships.companyId, userCompanyPreferences.companyId),
          eq(companyMemberships.principalId, userCompanyPreferences.userId),
          eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"),
        ))
        .innerJoin(agents, and(eq(agents.companyId, companyId), eq(agents.id, userCompanyPreferences.primaryAgentId)))
        .where(eq(userCompanyPreferences.companyId, companyId))
        .orderBy(userCompanyPreferences.userId);
    },
    async set(companyId: string, userId: string, agentId: string, actor: Express.Request["actor"]) {
      const result = await db.transaction(async tx => {
        const txDb = tx as unknown as Db;
        // Same lock order as leave/termination: agent, then preference. A racing
        // lifecycle change cannot leave a newly crowned unavailable agent.
        const [agent] = await tx.select().from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
        if (!agent) throw notFound("Agent not found");
        if (agent.status === "terminated" || agent.status === "pending_approval") {
          throw unprocessable("Choose an active, approved agent as your primary.");
        }
        await resourceMembershipService(txDb).updateAgent({ companyId, userId, agentId, state: "joined", actor });
        // Serialize personal changes even when they target different agents.
        await tx.insert(userCompanyPreferences).values({ companyId, userId }).onConflictDoNothing();
        await tx.select().from(userCompanyPreferences).where(preferenceWhere(companyId, userId)).for("update");
        await tx.insert(userCompanyPreferences).values({
          companyId, userId, primaryAgentId: agentId, primaryAgentInitialized: true,
        }).onConflictDoUpdate({
          target: [userCompanyPreferences.companyId, userCompanyPreferences.userId],
          set: { primaryAgentId: agentId, primaryAgentInitialized: true, updatedAt: new Date() },
        });
        const { publication } = await persistActivity(txDb, {
          companyId, actorType: "user", actorId: userId, action: "primary_agent.updated",
          // Activity and its live events are company-visible. Audit the change
          // without disclosing the user's private agent selection.
          entityType: "user_preference", entityId: userId,
        });
        return { preference: await primaryAgentService(txDb).get(companyId, userId), publication };
      });
      publishActivity(result.publication);
      return result.preference;
    },
  };
}
