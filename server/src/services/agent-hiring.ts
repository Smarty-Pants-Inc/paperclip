import { assertAgentInteraction } from "./agent-interaction-policy.js";
import { assertNoInitialAgentInteractionPermissions, preserveAgentInteractionPermissions } from "../lib/agent-interaction-permissions.js";
import { assertEphemeralAgentInstructions } from "./agent-instructions.js";
import { initializeDurableAgentFiles } from "./agent-file-durability.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifySkillVersionRetention, notifySkillVersionPinChange } from "./skill-version-retention-notifications.js";
import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { agents, companyMemberships, toolConnectionInstalls, principalPermissionGrants, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { lockCompanyAgentRuntime } from "./agent-runtime-lock.js";
import { notifyMuseContactVerification } from "../modules/external-agents/index.js";
import { unprocessable } from "../errors.js";
import { agentRecordQueries, isPlainRecord, configPatchFromApprovalPayload, normalizeRuntimeConfigForNewAgent, assertAgentDailyCostCap,
  deduplicateAgentName, type CreateAgentData, type CreateAgentOptions, type AgentConfigurationPatch, type AgentHireRecord } from "../lib/agent-records.js";
import { CEO_HIRING_DENIAL_KEY, normalizeAgentPermissions, permissionsImplyLowTrust, NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS,
  newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { secretService, assertClaudeOAuthBindingInvariant } from "./secrets.js";
import { agentCredentialService, lockClaudeOAuthInheritanceParent } from "./agent-credentials.js";
import { agentIdentityService } from "./agent-identity.js";
import { initializePrimaryAgent } from "./primary-agent.js";
import { resolveAgentRunnerTaskDriverForCompany, resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";
import { instanceSettingsService } from "./instance-settings.js";
import { assertProviderApiPlacementPolicy, isProviderApiSetupDraft, resolveProviderApiPlacement } from "./native-runtime/provider-api-placement.js";

export async function prepareAgentHire(db: Db, companyId: string, input: CreateAgentData, options?: CreateAgentOptions): Promise<CreateAgentData> {
  assertAgentDailyCostCap(input.runtimeConfig, options?.createdByAgentId);
  assertNoInitialAgentInteractionPermissions(input.permissions);
  await assertAgentInteraction(db, { companyId, actorAgentId: options?.createdByAgentId, actorCompanyId: options?.createdByAgentCompanyId,
    operation: "mention", texts: [JSON.stringify(input), ...(options?.interactionTexts ?? [])], lock: "update" });
  // #20805 R2 (src8): the new row's reports_to foreign key takes a KEY SHARE on
  // the manager row. Take it here, before the company lock, so the hire never
  // waits for an existing agent row while it holds the exclusive lock.
  if (input.reportsTo) await db.select({ id: agents.id }).from(agents).where(eq(agents.id, input.reportsTo)).for("key share");
  // #20805 R2 (src10): the hire-inheritance claim locks the parent FOR UPDATE.
  // Take it here with the other agent rows, before the company lock; the claim
  // below reads this locked row and takes no row lock after the company lock.
  const inheritedFromAgentId = options?.claudeLogin?.inheritedFromAgentId;
  const inheritanceParent = inheritedFromAgentId ? await lockClaudeOAuthInheritanceParent(db, inheritedFromAgentId) : undefined;
  // #20805: after the hirer (and setup draft, records.ts) row locks, before the
  // agent row write and the grant writes. One lock, independent of company size.
  await lockCompanyAgentRuntime(db, companyId);
  await notifyAttentionRetentionWork(db, { companyId });
  const { runner, ...data } = input;
  const selection = options?.runnerResolved
    ? { adapterType: data.adapterType ?? "process", adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {} }
    : await resolveNewAgentRunnerForCompany(db, companyId, {
        ...data, adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {}, runner,
      });
  data.adapterType = selection.adapterType;
  data.adapterConfig = selection.adapterConfig;
  const { ensureManager, assertBuiltInAgentMetadataMutationAllowed } = agentRecordQueries(db);
  if (data.appearance?.customAvatarAssetId) throw unprocessable("Create the agent before uploading its avatar");
  assertBuiltInAgentMetadataMutationAllowed(null, data.metadata, options);
  if (data.reportsTo) {
    await ensureManager(companyId, data.reportsTo);
  }

  const existingAgents = await db
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const uniqueName = deduplicateAgentName(data.name, existingAgents.filter(agent => agent.id !== options?.setupAgentId));

  const role = data.role ?? "general";
  // Only the permissions control records a CEO hiring restriction.
  const requestedPermissions = data.permissions && typeof data.permissions === "object" && !Array.isArray(data.permissions)
    ? Object.fromEntries(Object.entries(data.permissions).filter(([key]) => key !== CEO_HIRING_DENIAL_KEY)) : data.permissions;
  const normalizedPermissions = normalizeAgentPermissions(requestedPermissions, { context: "create" });
  const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
  const adapterType = data.adapterType ?? "process";
  const rawAdapterConfig = isPlainRecord(data.adapterConfig)
    ? await secretService(db).normalizeAdapterConfigForPersistence(companyId, data.adapterConfig, { adapterType })
    : {};
  const adapterConfig = normalizePaperclipRunnerAdapterConfig(adapterType, rawAdapterConfig);
  const profile = { adapterType, adapterConfig };
  const providerApiDraft = options?.setupOnly === true && isProviderApiSetupDraft(profile);
  const providerApi = providerApiDraft ? null : resolveProviderApiPlacement({ agent: profile });
  if (providerApi) assertProviderApiPlacementPolicy(await instanceSettingsService(db).getGeneral());
  if (!providerApiDraft && !providerApi && adapterType === "paperclip_runner" && !["openai_dot", "grok_bot", "muse"].includes(String(adapterConfig.provider)) &&
      (await resolveAgentRunnerTaskDriverForCompany(db, companyId, data.defaultEnvironmentId))?.warmTaskVersion === 1) {
    adapterConfig.lifecycleMode = "warm";
  }
  await agentCredentialService(db).enforceClaudeOAuthBindingClaim(db, {
    companyId, consume: true, environmentId: data.defaultEnvironmentId ?? null,
    childAdapterConfig: adapterConfig, claudeLogin: options?.claudeLogin, inheritanceParent,
    decision: assertClaudeOAuthBindingInvariant({ adapterType, nextConfig: adapterConfig }),
  });
  if (options?.setupAgentId) await notifySkillVersionRetention(db, companyId);
  return { ...data, name: uniqueName,
    appearance: data.appearance == null ? randomAgentAppearance() : agentAppearanceSchema.parse(data.appearance),
    role, adapterType, adapterConfig, permissions: normalizedPermissions, runtimeConfig };
}

export async function initializeAgentHire(txDb: Db, created: AgentHireRecord, options?: CreateAgentOptions) {
  const tx = txDb;
  const companyId = created.companyId;
  assertEphemeralAgentInstructions({ ...created, name: "" });
  await initializeDurableAgentFiles(txDb, created);
  await agentIdentityService(txDb).ensureAgentIdentity(companyId, created.id);
  // New standard agents receive the standard direct grants at activation.
  // Low-trust and bundled agents keep their explicit, narrower grants.
  if (!options?.setupOnly && created.status !== "pending_approval" && !permissionsImplyLowTrust(created.permissions) &&
      !readBuiltInAgentMarker(created.metadata)) {
    await tx.insert(principalPermissionGrants).values(
      NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
        companyId,
        principalType: "agent" as const,
        principalId: created.id,
        permissionKey,
        scope: newStandardAgentGrantScope(permissionKey, created.id),
      })),
    ).onConflictDoNothing();
  }
  if (options?.memberGrant) await grantNewAgentMembership(tx, companyId, created.id, options.memberGrant.grantedByUserId);
  if (options?.aiConnectionInstall) {
    const install = options.aiConnectionInstall;
    const connectionIds = [...new Set([install.connectionId, ...(install.memberConnectionIds ?? [])])];
    await tx.insert(toolConnectionInstalls).values(connectionIds.map(connectionId => ({
      companyId, connectionId,
      targetType: "agent" as const, targetId: created.id,
      createdByUserId: install.createdByUserId,
    }))).onConflictDoNothing();
  }
  await agentCredentialService(txDb).syncAgentSecretBindings(created, txDb);
  if (!options?.setupOnly && options?.createdByUserId && !readBuiltInAgentMarker(created.metadata)) {
    await initializePrimaryAgent(txDb, companyId, options.createdByUserId, created.id);
  }
}

/**
 * #20805: the hired agent's active membership and tasks:assign belong to the hire
 * transaction (doc/AGENT-LIFECYCLE.md: a failure rolls back the hire). Same rows
 * the create and hire routes wrote after commit before this change, including
 * pending-approval and low-trust hires and the board user's granted_by_user_id.
 * Idempotent on the two unique keys.
 */
async function grantNewAgentMembership(tx: Db, companyId: string, agentId: string, grantedByUserId: string | null) {
  await tx.insert(companyMemberships).values({
    companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member",
  }).onConflictDoUpdate({
    target: [companyMemberships.companyId, companyMemberships.principalType, companyMemberships.principalId],
    set: { status: "active", membershipRole: "member", updatedAt: new Date() },
    setWhere: sql`${companyMemberships.status} <> 'active' OR ${companyMemberships.membershipRole} IS DISTINCT FROM 'member'`,
  });
  await tx.insert(principalPermissionGrants).values({
    companyId, principalType: "agent", principalId: agentId, permissionKey: "tasks:assign", scope: null, grantedByUserId,
  }).onConflictDoUpdate({
    target: [principalPermissionGrants.companyId, principalPermissionGrants.principalType,
      principalPermissionGrants.principalId, principalPermissionGrants.permissionKey],
    set: { scope: null, grantedByUserId, updatedAt: new Date() },
  });
}

/** Re-assert an existing hire's membership and tasks:assign in one transaction
 * (idempotent replays of hires that may predate #20805). No retry loop. */
export async function ensureNewAgentMembership(db: Db, companyId: string, agentId: string, grantedByUserId: string | null) {
  await db.transaction(async tx => {
    const txDb = tx as unknown as Db;
    await lockCompanyAgentRuntime(txDb, companyId);
    await grantNewAgentMembership(txDb, companyId, agentId, grantedByUserId);
  });
  // After commit: a rolled-back grant never queues a Muse contact intent.
  await db.transaction(tx => notifyMuseContactVerification(tx as unknown as Db, { companyId, agentId }));
}

export async function prepareAgentHireApproval(txDb: Db, existing: AgentHireRecord, approvedPayload?: Record<string, unknown> | null): Promise<AgentConfigurationPatch> {
  // #20805: approval activates the agent row (a shared runtime hold) and then
  // writes its grants (an exclusive one), so it takes the exclusive hold before
  // its first agent write. R2 (src8): rows first, like the hire. The approved
  // agent's row (and a new manager's key share) are locked by plain SELECT ...
  // FOR, which fires no runtime trigger, so no shared hold exists yet to upgrade.
  const approvedPatch = approvedPayload ? configPatchFromApprovalPayload(approvedPayload) : {};
  await txDb.select({ id: agents.id }).from(agents).where(eq(agents.id, existing.id)).for("no key update");
  const approvedManager = (approvedPatch as { reportsTo?: unknown }).reportsTo;
  if (typeof approvedManager === "string")
    await txDb.select({ id: agents.id }).from(agents).where(eq(agents.id, approvedManager)).for("key share");
  await lockCompanyAgentRuntime(txDb, existing.companyId);
  const patch = { ...approvedPatch } as AgentConfigurationPatch;
  const hasApprovedAdapterConfig = Object.prototype.hasOwnProperty.call(patch, "adapterConfig") && isPlainRecord(patch.adapterConfig);
  if (
    Object.prototype.hasOwnProperty.call(patch, "adapterConfig") &&
    isPlainRecord(patch.adapterConfig)
  ) {
    const normalizedAdapterConfig = await secretService(txDb).normalizeAdapterConfigForPersistence(
      existing.companyId, patch.adapterConfig, { adapterType: (patch.adapterType ?? existing.adapterType) as string },
    );
    patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
      (patch.adapterType ?? existing.adapterType) as string,
      normalizedAdapterConfig,
    );
  } else if (
    Object.prototype.hasOwnProperty.call(patch, "adapterType")
    && isPlainRecord(existing.adapterConfig)
  ) {
    patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
      patch.adapterType as string,
      existing.adapterConfig,
    );
  }
  if (patch.permissions !== undefined) {
    // The pending-approval activation replays the original hire
    // request, so the new-agent creation default applies.
    patch.permissions = normalizeAgentPermissions(preserveAgentInteractionPermissions(existing.permissions, patch.permissions), { context: "create" });
  }
  if (hasApprovedAdapterConfig) {
    await agentCredentialService(txDb).enforceClaudeOAuthBindingClaim(txDb, {
      companyId: existing.companyId, consume: false, environmentId: null,
      childAdapterConfig: patch.adapterConfig,
      decision: assertClaudeOAuthBindingInvariant({ adapterType: patch.adapterType ?? existing.adapterType,
        nextConfig: patch.adapterConfig, priorConfig: existing.adapterConfig }),
    });
  }
  if (patch.adapterConfig !== undefined) await notifySkillVersionPinChange(txDb, existing.companyId, existing.adapterConfig ?? {}, patch.adapterConfig);
  assertEphemeralAgentInstructions({ ...existing, ...patch, name: "" });
  return patch;
}

export async function completeAgentHireApproval(txDb: Db, updated: AgentHireRecord, existing: AgentHireRecord) {
  const tx = txDb;
  await agentCredentialService(txDb).syncAgentSecretBindings(updated, txDb, existing.adapterConfig);
  if (!permissionsImplyLowTrust(updated.permissions) && !readBuiltInAgentMarker(updated.metadata)) {
    await tx.insert(principalPermissionGrants).values(
      NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
        companyId: updated.companyId,
        principalType: "agent" as const,
        principalId: updated.id,
        permissionKey,
        scope: newStandardAgentGrantScope(permissionKey, updated.id),
      })),
    ).onConflictDoNothing();
  }
}
