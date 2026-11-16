import type { ActorInfo, DbTransaction, ToolAccessMutationDb } from "../types.js";
import { forbidden, unprocessable } from "../../../errors.js";
import { lockProjectConnectionRows } from "../../project-connection-arbitration.js";
import { assertProjectConnectionAdmission } from "../../project-connection-admission.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { RAILWAY_SSH_SECRET_PATH } from "../../railway-ssh.js";
import { isRailwayConnection } from "../../railway.js";

export function createOrganizationGrantStore(db: Db) {
  async function ensureDefaultOrganizationGrant(
    connection: typeof toolConnections.$inferSelect,
    dbClient: ToolAccessMutationDb = db,
    onMutation?: (mutation: {
      previous: typeof connectionGrants.$inferSelect | null;
      current: typeof connectionGrants.$inferSelect;
    }) => void,
    /**
     * Scope provenance from the authorization that just completed, for the callers that have
     * one. The default organization grant is created before OAuth has issued any credentials,
     * so without this the grants API reads back a shared identity whose scope has no source
     * and no over-grant warning — while the connection record carries both.
     *
     * Scope provenance includes its consent timestamp. The shared grant takes its credential lifecycle from the
     * connection, and writing `accessTokenExpiresAt` here would make an expired connection
     * look fresh to the refresh-due check and skip the reconnect prompt.
     */
    oauthProvenance?: {
      scopes: string[];
      scopeSource: "provider" | "requested_fallback";
      unrequestedScopes: string[];
      requestedScopes: string[];
    },
    actor?: ActorInfo,
  ) {
    if (connection.projectId !== null) {
      // Owned finish/create must compose this with connection + receipt on its
      // ACTUAL transaction. A standalone default-grant write cannot reauthorize
      // or make a non-serving migration draft usable after a partial failure.
      if (dbClient === db || !("execute" in dbClient)) throw unprocessable(
        "Project organization grants require the connection writer transaction", { code: "project_connection_transaction_required" });
      const tx = dbClient as DbTransaction;
      [connection] = await lockProjectConnectionRows(tx, [connection]);
      const installs = await tx.select().from(toolConnectionInstalls).where(and(
        eq(toolConnectionInstalls.companyId, connection.companyId), eq(toolConnectionInstalls.connectionId, connection.id),
      ));
      if (installs.some(install => install.targetType !== "agent")) throw forbidden(
        "Project connections require explicit project agent installs", { code: "project_connection_target_outside_project" });
      await actor?.managementContext?.reauthorize();
      await assertProjectConnectionAdmission(tx, {
        companyId: connection.companyId, projectId: connection.projectId,
        operation: "finish", actor, connection, proposedSecretRefs: connection.credentialSecretRefs,
        targetAgentIds: installs.map(install => install.targetId),
      });
      const grants = await tx.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id),
      ));
      if (grants.length > 1 || grants.some(grant => grant.kind !== "organization")) {
        throw unprocessable("Project Apps support one fixed default organization identity", { code: "project_connection_provider_unsupported" });
      }
    }
    const providerTenantWithOauth = (
      current: (typeof connectionGrants.$inferSelect)["providerTenant"],
    ) =>
      oauthProvenance
        ? {
            ...(current ?? {}),
            oauth: {
              ...(current?.oauth ?? {}),
              scopes: oauthProvenance.scopes,
              scopeSource: oauthProvenance.scopeSource,
              unrequestedScopes: oauthProvenance.unrequestedScopes,
              requestedScopes: oauthProvenance.requestedScopes,
              consentedAt: new Date().toISOString(),
            },
          }
        : current;
    const [existing] = await dbClient
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "organization"),
          // Revocation clears isDefault. A verified same-reference recovery of
          // the sole owned identity updates it rather than inserting a second.
          connection.projectId !== null ? undefined : eq(connectionGrants.isDefault, true),
        ),
      )
      .limit(1);
    if (existing) {
      // OAuth connections create their organization grant before the browser
      // callback has issued any credentials. Reconnects can rotate those
      // credentials later as well. Keep the execution grant synchronized with
      // the connection so the gateway projects the current secrets instead of
      // sending an unauthenticated request after an apparently successful
      // setup. Reconnecting is also the explicit recovery path for a revoked
      // shared identity, so it is correct to reactivate that default grant here.
      const [updated] = await dbClient
        .update(connectionGrants)
        .set({
          credentialSecretRefs: isRailwayConnection(connection)
            ? [...connection.credentialSecretRefs, ...existing.credentialSecretRefs.filter((ref) => ref.configPath === RAILWAY_SSH_SECRET_PATH && !connection.credentialSecretRefs.some((candidate) => candidate.configPath === ref.configPath))]
            : connection.credentialSecretRefs,
          ...(oauthProvenance
            ? { providerTenant: providerTenantWithOauth(existing.providerTenant) }
            : {}),
          status: "active",
          ...(connection.projectId !== null ? { isDefault: true } : {}),
          revokedAt: null,
          revokedByAgentId: null,
          revokedByUserId: null,
          updatedAt: new Date(),
        })
        .where(and(eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.id, existing.id)))
        .returning();
      if (!updated)
        throw new Error("Failed to update default connection grant");
      onMutation?.({ previous: existing, current: updated });
      return updated;
    }
    const [created] = await dbClient
      .insert(connectionGrants)
      .values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: "organization",
        credentialSecretRefs: connection.credentialSecretRefs,
        ...(oauthProvenance
          ? { providerTenant: providerTenantWithOauth(null) }
          : {}),
        status: "active",
        isDefault: true,
      })
      .returning();
    if (!created) throw new Error("Failed to create default connection grant");
    onMutation?.({ previous: null, current: created });
    return created;
  }
  return ensureDefaultOrganizationGrant;
}
