import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { toolCatalogEntries, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles, type Db } from "@paperclipai/db";
import type { CreateToolProfileEntryForProfile, ToolProfileConfiguration } from "@paperclipai/shared";
import { toProfile, toProfileBinding, toProfileEntry, profileCatalogMatcher } from "./projection.js";
import { conflict } from "../../../errors.js";
import { lockProjectConnectionRows } from "../../project-connection-arbitration.js";
import { assertProjectConnectionAdmission } from "../../project-connection-admission.js";
import { assertProjectConnectionNotInUse } from "../../project-connection-retirement.js";
import type { ConnectionManagementContext } from "../../connection-management.js";
import type { ActorInfo, DbTransaction } from "../types.js";
import { lockProfileEntryReferences } from "../assignment-locks.js";

type ProfileRow = typeof toolProfiles.$inferSelect;

/** Saved profiles shown by connection Permissions; this is not effective access. */
export function createConnectionProfileConfigurationReader(db: Db) {
  return async (
    companyId: string,
    connectionId: string,
    visibleProfiles: (profiles: ProfileRow[]) => Promise<ProfileRow[]>,
  ): Promise<ToolProfileConfiguration[]> => {
    const candidates = await db.select().from(toolProfiles).where(and(
      eq(toolProfiles.companyId, companyId),
      or(
        eq(toolProfiles.profileKey, `app:${connectionId}`),
        and(
          eq(toolProfiles.status, "active"),
          sql`${toolProfiles.metadata}->>'source' = 'connection_intent'`,
          sql`${toolProfiles.metadata}->>'connectionId' = ${connectionId}`,
          sql`jsonb_typeof(${toolProfiles.metadata}->'agentId') = 'string'`,
          sql`${toolProfiles.profileKey} = 'connection-intent:' || ${connectionId} || ':' || (${toolProfiles.metadata}->>'agentId')`,
          sql`exists (select 1 from ${toolProfileBindings} where
            ${toolProfileBindings.companyId} = ${toolProfiles.companyId}
            and ${toolProfileBindings.profileId} = ${toolProfiles.id}
            and ${toolProfileBindings.targetType} = 'agent'
            and ${toolProfileBindings.targetId} = ${toolProfiles.metadata}->>'agentId')`,
        ),
      ),
    )).orderBy(desc(toolProfiles.updatedAt));
    // Preserve the full-list route's per-profile current-authority checks before
    // loading configuration. Connection access alone does not grant profile access.
    const profiles = await visibleProfiles(candidates);
    if (profiles.length === 0) return [];
    const ids = profiles.map(profile => profile.id);
    const [entries, bindings] = await Promise.all([
      db.select().from(toolProfileEntries).where(and(
        eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, ids),
      )).orderBy(asc(toolProfileEntries.createdAt), asc(toolProfileEntries.id)),
      db.select().from(toolProfileBindings).where(and(
        eq(toolProfileBindings.companyId, companyId), inArray(toolProfileBindings.profileId, ids),
      )).orderBy(asc(toolProfileBindings.priority), asc(toolProfileBindings.createdAt)),
    ]);
    const entriesByProfile = new Map<string, ToolProfileConfiguration["entries"]>();
    const bindingsByProfile = new Map<string, ToolProfileConfiguration["bindings"]>();
    for (const entry of entries) {
      const group = entriesByProfile.get(entry.profileId) ?? [];
      group.push(toProfileEntry(entry));
      entriesByProfile.set(entry.profileId, group);
    }
    for (const binding of bindings) {
      const group = bindingsByProfile.get(binding.profileId) ?? [];
      group.push(toProfileBinding(binding));
      bindingsByProfile.set(binding.profileId, group);
    }
    return profiles.map(profile => ({
      ...toProfile(profile),
      entries: entriesByProfile.get(profile.id) ?? [],
      bindings: bindingsByProfile.get(profile.id) ?? [],
    }));
  };
}

/** Preserve the original board/agent distinction, including delegated humans. */
export function profileManagementActor(context?: ConnectionManagementContext): ActorInfo | undefined {
  return context ? { managementContext: context, actorType: context.audit.actorType,
    actorId: context.audit.actorId, responsibleUserId: context.responsibleUserId } : undefined;
}

type ProfileTarget = Readonly<{ targetType: string; targetId: string }>;

/**
 * Common effective-reach writer boundary. Resolve saved selectors (including
 * application/catalog/tool-name/risk/default-allow selectors), then take project
 * lifecycle and identity locks BEFORE subordinate profile/reference/agent rows.
 * A profile can select actions, never create an implicit connection install.
 */
export async function guardProjectProfileMutation(tx: DbTransaction, input: Readonly<{
  companyId: string;
  profileIds?: readonly string[];
  entries?: readonly CreateToolProfileEntryForProfile[];
  defaultAction?: string;
  profileKey?: string;
  actor?: ActorInfo;
  additionalTargets?: readonly ProfileTarget[];
  removeTarget?: ProfileTarget;
  removeBindings?: boolean;
  destructive?: boolean;
}>) {
  const { companyId, actor } = input;
  const profileIds = [...new Set(input.profileIds ?? [])].sort();
  const readState = async () => {
    if (profileIds.length === 0) return { profiles: [], entries: [], bindings: [] };
    const profiles = await tx.select().from(toolProfiles).where(and(
      eq(toolProfiles.companyId, companyId), inArray(toolProfiles.id, profileIds),
    )).orderBy(toolProfiles.id);
    const entries = await tx.select().from(toolProfileEntries).where(and(
      eq(toolProfileEntries.companyId, companyId), inArray(toolProfileEntries.profileId, profileIds),
    )).orderBy(toolProfileEntries.id);
    const bindings = await tx.select().from(toolProfileBindings).where(and(
      eq(toolProfileBindings.companyId, companyId), inArray(toolProfileBindings.profileId, profileIds),
    )).orderBy(toolProfileBindings.id);
    return { profiles, entries, bindings };
  };
  const before = await readState();
  const candidates = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), isNotNull(toolConnections.projectId), ne(toolConnections.status, "archived"),
  ));
  if (candidates.length === 0) return;
  const entries = [...before.entries, ...(input.entries ?? [])];
  const matcher = profileCatalogMatcher(entries.map(entry => ({
    ...entry, applicationId: entry.applicationId ?? null, connectionId: entry.connectionId ?? null,
    catalogEntryId: entry.catalogEntryId ?? null, toolName: entry.toolName ?? null, riskLevel: entry.riskLevel ?? null,
  })));
  const catalog = await tx.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId));
  const all = input.defaultAction === "allow" || before.profiles.some(profile => profile.defaultAction === "allow");
  const profileKeys = new Set([input.profileKey, ...before.profiles.map(profile => profile.profileKey)]);
  const affected = candidates.filter(connection => all || profileKeys.has(`app:${connection.id}`)
    || entries.some(entry => entry.connectionId === connection.id || entry.applicationId === connection.applicationId)
    || catalog.some(entry => entry.connectionId === connection.id && matcher(entry)));
  if (affected.length === 0) return;
  // Serialize project membership/identity first, but do not take an
  // application UPDATE lock before the profile's complete reference set. That
  // would invert the established reference -> profile ordering for mixed
  // project-owned and legacy selectors.
  await lockProjectConnectionRows(tx, affected, { lockSavedRows: false });
  await lockProfileEntryReferences(tx, companyId, [
    ...entries,
    ...affected.map(connection => ({ applicationId: connection.applicationId, connectionId: connection.id })),
  ]);
  if (profileIds.length > 0) await tx.select({ id: toolProfiles.id }).from(toolProfiles).where(and(
    eq(toolProfiles.companyId, companyId), inArray(toolProfiles.id, profileIds),
  )).orderBy(toolProfiles.id).for("no key update");
  if (JSON.stringify(before) !== JSON.stringify(await readState())) {
    // Retry outside this tx: taking additional project locks while retaining a
    // profile/connection row would invert the lifecycle lock order.
    throw conflict("Tool profile reach changed while waiting. Retry with current state.", { code: "project_connection_profile_changed", retryable: true });
  }
  // Reference/profile locks can wait. Reload the owned rows after those waits
  // while retaining the project lifecycle and identity locks acquired above.
  const currentConnections = await lockProjectConnectionRows(tx, affected, { lockSavedRows: false });
  const previousTargets: readonly ProfileTarget[] = before.bindings;
  const finalTargets = [...(input.removeBindings ? [] : previousTargets.filter(target =>
    !input.removeTarget || target.targetType !== input.removeTarget.targetType || target.targetId !== input.removeTarget.targetId)),
  ...(input.additionalTargets ?? [])];
  const installs = await tx.select().from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, companyId), inArray(toolConnectionInstalls.connectionId, currentConnections.map(connection => connection.id)),
  ));
  await actor?.managementContext?.reauthorize();
  for (const connection of currentConnections) {
    const explicitAgents = installs.filter(install => install.connectionId === connection.id && install.targetType === "agent").map(install => install.targetId);
    const reached = (targets: readonly ProfileTarget[]) => explicitAgents.filter(agentId => targets.some(target =>
      target.targetType !== "agent" || target.targetId === agentId));
    await assertProjectConnectionAdmission(tx, {
      companyId, projectId: connection.projectId, operation: "update", actor, connection,
      targetAgentIds: reached(finalTargets),
    });
    if (input.destructive && reached(previousTargets).length > 0) await assertProjectConnectionNotInUse(tx, {
      companyId, projectId: connection.projectId!, connectionId: connection.id, actor,
    });
  }
}
