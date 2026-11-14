import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { toolMcpGateways, toolPolicies, toolProfileBindings, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { isAgentInSubtree, type AuthorizationActor } from "../authorization.js";
import { assertAgentConnectionInstallAccess } from "../connection-management.js";
import type { ToolAccessMutationDb } from "./types.js";

/** Finish's additive agent path uses the existing connection-intent profile
 * shape (connection-agent-access.ts), never another consumer's app profile.
 * The caller holds the company reporting-tree and connection writer locks. */
export async function saveGalleryAgentAccess(tx: ToolAccessMutationDb, input: {
  companyId: string;
  connectionId: string;
  applicationId: string;
  actor: AuthorizationActor;
  agentIds: string[];
  catalogEntryIds: string[];
  askFirstCatalogEntryIds: string[];
}) {
  const { companyId, connectionId, applicationId, actor } = input;
  const client = tx as unknown as Db;
  for (const agentId of new Set(input.agentIds)) {
    // A retained outside recipient is a no-op, not permission to give it new
    // actions. Actual binding/install additions are checked separately by finish.
    if (actor.type === "agent" && agentId !== actor.agentId
      && !await isAgentInSubtree(client, companyId, actor.agentId!, agentId)) continue;
    await assertAgentConnectionInstallAccess(client, actor, companyId, [agentId]);
    if (actor.type === "agent") {
      await assertAgentConnectionInstallAccess(client, {
        type: "board", source: "session", userId: actor.onBehalfOfUserId, ignoreInstanceAdmin: true,
      }, companyId, [agentId]);
    }
    const profileKey = `connection-intent:${connectionId}:${agentId}`;
    const [profile] = await tx.insert(toolProfiles).values({
      companyId, profileKey, name: profileKey, defaultAction: "deny",
      metadata: { source: "connection_intent", connectionId, agentId },
    }).onConflictDoNothing({ target: [toolProfiles.companyId, toolProfiles.profileKey] }).returning();
    const saved = profile ?? (await tx.select().from(toolProfiles).where(and(
      eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey),
    )).for("no key update"))[0]!;
    const bindings = await tx.select().from(toolProfileBindings).where(and(
      eq(toolProfileBindings.companyId, companyId), eq(toolProfileBindings.profileId, saved.id),
    ));
    const gateways = await tx.select({ id: toolMcpGateways.id }).from(toolMcpGateways).where(and(
      eq(toolMcpGateways.companyId, companyId), eq(toolMcpGateways.profileId, saved.id),
    ));
    // Even an agent-specific profile may have been shared explicitly later.
    // Its key alone is not proof that mutating it affects only this agent.
    if (gateways.length || saved.status !== "active" || saved.defaultAction !== "deny"
      || saved.metadata.source !== "connection_intent" || saved.metadata.connectionId !== connectionId || saved.metadata.agentId !== agentId
      || bindings.some(binding => binding.targetType !== "agent" || binding.targetId !== agentId)) {
      throw forbidden("The saved agent access profile requires a shared-profile editor");
    }
    const entries = await tx.select().from(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.profileId, saved.id),
    ));
    // Do not replace explicit exclusions, even in a recipient-specific profile.
    if (entries.some(entry => entry.effect === "exclude")) {
      throw forbidden("The saved agent access exclusions require a profile editor");
    }
    const additions = input.catalogEntryIds.filter(id => !entries.some(entry => entry.catalogEntryId === id && entry.effect === "include"));
    if (additions.length) await tx.insert(toolProfileEntries).values(additions.map(catalogEntryId => ({
      companyId, profileId: saved.id, selectorType: "catalog_entry" as const, effect: "include" as const,
      applicationId, connectionId, catalogEntryId,
    })));
    await tx.insert(toolProfileBindings).values({
      companyId, profileId: saved.id, targetType: "agent", targetId: agentId, priority: 100,
      createdByAgentId: actor.type === "agent" ? actor.agentId : null,
      createdByUserId: actor.type === "agent" ? actor.onBehalfOfUserId : actor.userId,
      metadata: { source: "connection_intent", connectionId },
    }).onConflictDoNothing();
    for (const catalogEntryId of input.askFirstCatalogEntryIds) {
      const name = `connection-intent:${agentId}:${catalogEntryId}`;
      const [policy] = await tx.select().from(toolPolicies).where(and(
        eq(toolPolicies.companyId, companyId), eq(toolPolicies.name, name),
      )).for("no key update");
      if (policy) {
        // A name collision is not authority to repurpose another saved policy.
        if (policy.policyType !== "require_approval"
          || !isDeepStrictEqual(policy.selectors, { connectionId, catalogEntryId })
          || !isDeepStrictEqual(policy.conditions, { actor: { agentId } })
          || policy.config?.source !== "connection_intent" || policy.config?.connectionId !== connectionId || policy.config?.agentId !== agentId) {
          throw forbidden("The saved approval policy requires a policy editor");
        }
        if (!policy.enabled) await tx.update(toolPolicies).set({ enabled: true, updatedAt: new Date() }).where(eq(toolPolicies.id, policy.id));
      } else await tx.insert(toolPolicies).values({
        companyId, name, policyType: "require_approval", priority: 0,
        selectors: { connectionId, catalogEntryId }, conditions: { actor: { agentId } },
        config: { source: "connection_intent", connectionId, agentId },
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "agent" ? actor.onBehalfOfUserId : actor.userId,
      });
    }
  }
}
