import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { connectionGrants, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { DbTransaction } from "./tool-access/types.js";
import { lockProjectConnectionLifecycle } from "./project-connection-retirement.js";
import { isConsumedProjectAppApprovalPredecessor, isUnconsumedProjectAppApprovalSource, PROJECT_APP_APPROVAL_SOURCE } from "./project-app-custody.js";

/** Lane A. Provider verification belongs outside this transaction. */
export type ProjectConnectionIdentity = Readonly<{
  companyId: string;
  providerHost: string;
  verifiedRegistrationId: string;
  canonicalInstallationKey: string;
}>;

type Connection = typeof toolConnections.$inferSelect;
const INSTALLATION_PREFIX = "github.com/github-app-installation/";
const LIVE_INSTALLATION_INDEX = "tool_connections_project_live_installation_uq";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function decimal(value: unknown): string | null {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

function assertIdentity(identity: ProjectConnectionIdentity) {
  if (!identity.companyId || identity.providerHost !== "github.com"
    || !decimal(identity.verifiedRegistrationId)
    || !identity.canonicalInstallationKey.startsWith(INSTALLATION_PREFIX)
    || !decimal(identity.canonicalInstallationKey.slice(INSTALLATION_PREFIX.length))) {
    throw unprocessable("A verified canonical GitHub App identity is required", {
      code: "project_connection_identity_invalid",
    });
  }
}

/**
 * Read only the arbitration fields of the server envelope. Full approval parsing
 * belongs to admission (B). Never let a null row assert a forged reservation.
 */
export function projectConnectionIdentityForConnection(connection: Pick<Connection, "companyId" | "projectId" | "config">): ProjectConnectionIdentity | null {
  if (connection.projectId == null) return null;
  const scope = object(connection.config.projectScope);
  if (!scope || scope.version !== 1 || typeof scope.exclusive !== "boolean"
    || typeof scope.installationKey !== "string" || !decimal(scope.registrationId)) {
    throw unprocessable("The saved project connection identity is invalid", { code: "project_connection_scope_invalid" });
  }
  const identity: ProjectConnectionIdentity = {
    companyId: connection.companyId,
    providerHost: "github.com",
    verifiedRegistrationId: scope.registrationId as string,
    canonicalInstallationKey: scope.installationKey,
  };
  assertIdentity(identity);
  return identity;
}

/**
 * Registration -> sorted installation locks. The caller must pass its actual
 * transaction and take sorted owning project lifecycle rows FIRST. No provider
 * I/O, saved-row snapshot or subordinate row lock is taken here. In particular,
 * availability/admission must run in NEW READ COMMITTED statements after this
 * returns, never in the statement/snapshot that waited for the advisory lock.
 */
export async function lockProjectConnectionIdentities(
  tx: Db | DbTransaction,
  identities: readonly ProjectConnectionIdentity[],
): Promise<void> {
  for (const identity of identities) assertIdentity(identity);
  const registrations = new Set(identities.map(identity =>
    `paperclip:project-connection:registration:${identity.companyId}:${identity.providerHost}:${identity.verifiedRegistrationId}`));
  const installations = new Set(identities.map(identity =>
    `paperclip:project-connection:installation:${identity.companyId}:${identity.canonicalInstallationKey}`));
  // Sort full identity strings, not hashes (hash collisions only serialize more
  // work). All registrations precede ALL installations, including retargets.
  for (const key of [...registrations].sort().concat([...installations].sort())) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

function legacyAliases(connection: Connection) {
  const installationKeys = new Set<string>();
  const registrationIds = new Set<string>();
  // Legacy drafts/disabled/null rows reserve too. Raw spellings may conservatively
  // block a conflicting reservation; they are NEVER used as verified lock keys,
  // approval or provider authority. App/client spelling cannot hide installation.
  for (const config of [connection.config, connection.transportConfig]) {
    const method = object(config.methodConfig);
    if (config.sourceTemplateKey !== "github" || config.connectionMethodKey !== "app-installation" || !method) continue;
    const installationId = decimal(method.installationId);
    const registrationId = decimal(method.appId);
    if (installationId) installationKeys.add(`${INSTALLATION_PREFIX}${installationId}`);
    if (registrationId) registrationIds.add(registrationId);
  }
  return { installationKeys, registrationIds };
}

/** All identity-affecting owned/null/alias writers use the same live-row arbiter. */
export async function assertProjectConnectionAvailability(
  tx: Db | DbTransaction,
  input: Readonly<{ identity: ProjectConnectionIdentity; projectId: string | null; exclusive: boolean; excludeConnectionId?: string;
    /** RFL 05:56Z: a verified receipt-citing create ignores live approval
     * sources of this installation/registration, but consumes ONLY its own S.
     * Ordinary writers retain the existing reservation checks. */
    consumedSourceConnectionId?: string }>,
): Promise<void> {
  const { identity, projectId, exclusive, excludeConnectionId, consumedSourceConnectionId } = input;
  let receiptCiting = projectId !== null && consumedSourceConnectionId !== undefined;
  assertIdentity(identity);
  if (exclusive && projectId === null) {
    throw unprocessable("Only a project connection can reserve an EXCLUSIVE App", { code: "project_connection_scope_invalid" });
  }
  // Separate post-lock SELECT: PostgreSQL READ COMMITTED sees the winner even
  // when this transaction read an empty set before waiting for its lock.
  const live = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, identity.companyId), ne(toolConnections.status, "archived"),
  ));
  if (excludeConnectionId) {
    const [saved] = await tx.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, identity.companyId), eq(toolConnections.id, excludeConnectionId),
    ));
    if (!saved) throw notFound("Tool connection not found");
    if (saved.projectId !== projectId) {
      throw unprocessable("A connection's project owner cannot change", { code: "project_connection_owner_immutable" });
    }
    if (saved.projectId !== null) {
      if (saved.status === "archived") throw conflict("This project's connection was retired. Create a new approved project connection.", { code: "project_connection_archived" });
      // The winner's saved protected source pointer retains its receipt-citing
      // identity at finish/install/profile writers. Otherwise a losing live S
      // would let create win, then incorrectly block the winner from use. These
      // callers still re-check custody/admission; this is not authorization.
      receiptCiting ||= typeof saved.config[PROJECT_APP_APPROVAL_SOURCE] === "string";
      const savedIdentity = projectConnectionIdentityForConnection(saved)!;
      const savedExclusive = object(saved.config.projectScope)!.exclusive;
      if (exclusive && savedExclusive === false) {
        throw conflict("EXCLUSIVE is supported only when creating a new approved connection", { code: "project_connection_exclusive_promotion_unsupported" });
      }
      if (savedExclusive !== exclusive || savedIdentity.canonicalInstallationKey !== identity.canonicalInstallationKey
        || savedIdentity.verifiedRegistrationId !== identity.verifiedRegistrationId) {
        throw conflict("The saved project connection identity cannot change", { code: "project_connection_identity_immutable" });
      }
    }
  }
  // Legacy organization grants can carry aliases not visible on the connection.
  // Include revoked grants: revocation/health/zero installs never releases a live
  // reservation. github.userId is a BOT account id, NOT a registration id.
  const grants = await tx.select({ connectionId: connectionGrants.connectionId, providerTenant: connectionGrants.providerTenant })
    .from(connectionGrants).where(and(eq(connectionGrants.companyId, identity.companyId), eq(connectionGrants.kind, "organization")));
  const aliasesByConnection = new Map<string, { installations: Set<string>; registrations: Set<string> }>();
  for (const grant of grants) {
    const github = object(grant.providerTenant?.github);
    if (!github) continue;
    const aliases = aliasesByConnection.get(grant.connectionId) ?? { installations: new Set<string>(), registrations: new Set<string>() };
    if (Array.isArray(github.installationIds)) {
      for (const id of github.installationIds) if (decimal(id)) aliases.installations.add(`${INSTALLATION_PREFIX}${id}`);
    }
    // Normalized provider verification can persist this in existing JSON; never
    // derive the numeric App identity from a client id or a caller's marker.
    if (decimal(github.registrationId)) aliases.registrations.add(github.registrationId as string);
    aliasesByConnection.set(grant.connectionId, aliases);
  }
  let duplicate = false;
  let incompatible = false;
  for (const connection of live) {
    if (connection.id === excludeConnectionId || connection.id === consumedSourceConnectionId || isConsumedProjectAppApprovalPredecessor(connection)) continue;
    if (receiptCiting && isUnconsumedProjectAppApprovalSource(connection, identity)) continue;
    const ownedIdentity = projectConnectionIdentityForConnection(connection);
    const aliases = legacyAliases(connection);
    const grantAliases = aliasesByConnection.get(connection.id);
    const sameInstallation = ownedIdentity?.canonicalInstallationKey === identity.canonicalInstallationKey
      || aliases.installationKeys.has(identity.canonicalInstallationKey)
      || grantAliases?.installations.has(identity.canonicalInstallationKey) === true;
    const sameRegistration = ownedIdentity?.verifiedRegistrationId === identity.verifiedRegistrationId
      || aliases.registrationIds.has(identity.verifiedRegistrationId)
      || grantAliases?.registrations.has(identity.verifiedRegistrationId) === true;
    if (projectId !== null && connection.projectId === projectId && sameInstallation) duplicate = true;
    const savedExclusive = ownedIdentity !== null && object(connection.config.projectScope)!.exclusive === true;
    if ((sameInstallation || sameRegistration) && (exclusive || savedExclusive)) incompatible = true;
  }
  // The same P/I conflict is always the named uniqueness result, including when
  // that row is EXCLUSIVE. All other project/null and registration aliases use
  // exclusivity. Shared/shared and null/null remain compatible.
  if (duplicate) throw conflict("This project already has a live connection to that installation", { code: "project_installation_in_use" });
  if (incompatible) throw conflict("This installation or App registration is reserved by another live connection", { code: "installation_not_exclusive" });
}

/**
 * Denial-only guard for a generic writer that has not completed B/C preflight.
 * Submitted App/client/installation spellings are lookup hints, NEVER verified
 * identity or approval. Only identities from saved server-owned envelopes may
 * be locked here. This closes known shared/EXCLUSIVE/null alias collisions even
 * while first-bind custody is unavailable; it does not authorize any new bind.
 * B/C still must provide verified facts for previously unbound registrations.
 */
export async function assertKnownProjectConnectionCreateAliases(
  tx: Db | DbTransaction,
  input: Readonly<{ companyId: string; projectId: string | null; exclusive: boolean; config: Record<string, unknown>; excludeConnectionId?: string; consumedSourceConnectionId?: string }>,
): Promise<void> {
  if (input.config.sourceTemplateKey !== "github" || input.config.connectionMethodKey !== "app-installation") return;
  const method = object(input.config.methodConfig);
  if (!method) return;
  const installationId = decimal(method.installationId);
  const installationKey = installationId ? `${INSTALLATION_PREFIX}${installationId}` : null;
  // Numeric spellings are lookup hints only. This can refuse a conflicting
  // registration alias, but never authorizes or verifies an unbound App.
  const registrationHint = decimal(method.appId);
  const saved = await tx.select().from(toolConnections).where(and(
    eq(toolConnections.companyId, input.companyId), ne(toolConnections.status, "archived"),
  ));
  // A definite live legacy collision can be refused without inventing verified
  // identity for the null row. This is denial-only, so no lock can turn it into
  // approval. B/C must still verify and lock any eventual successful attempt.
  if (input.exclusive && saved.some(connection => {
    if (connection.id === input.excludeConnectionId || connection.id === input.consumedSourceConnectionId || isConsumedProjectAppApprovalPredecessor(connection)) return false;
    // The protected first-bind scope is server-prepared, never request metadata.
    // Raw spellings remain denial-only hints for every ordinary create.
    const receiptIdentity = input.consumedSourceConnectionId && input.projectId !== null
      ? projectConnectionIdentityForConnection({ companyId: input.companyId, projectId: input.projectId, config: input.config }) : null;
    if (receiptIdentity && isUnconsumedProjectAppApprovalSource(connection, receiptIdentity)) return false;
    const aliases = legacyAliases(connection);
    return (installationKey !== null && aliases.installationKeys.has(installationKey))
      || (registrationHint !== null && aliases.registrationIds.has(registrationHint));
  })) throw conflict("This installation or App registration is reserved by another live connection", { code: "installation_not_exclusive" });
  const identities = saved.flatMap(connection => {
    const identity = projectConnectionIdentityForConnection(connection);
    if (!identity || connection.id === input.excludeConnectionId || connection.id === input.consumedSourceConnectionId) return [];
    const sameInstallation = identity.canonicalInstallationKey === installationKey;
    const sameRegistration = identity.verifiedRegistrationId === registrationHint;
    const exclusiveConflict = (input.exclusive || object(connection.config.projectScope)?.exclusive === true)
      && (sameInstallation || sameRegistration);
    const duplicate = input.projectId !== null && connection.projectId === input.projectId && sameInstallation;
    return exclusiveConflict || duplicate ? [identity] : [];
  });
  if (!identities.length) return;
  await lockProjectConnectionIdentities(tx, identities);
  for (const identity of identities) await assertProjectConnectionAvailability(tx, {
    identity, projectId: input.projectId, exclusive: input.exclusive, excludeConnectionId: input.excludeConnectionId,
    consumedSourceConnectionId: input.consumedSourceConnectionId,
  });
  // A concurrent archive may have released the known collision while we waited.
  // Retry OUTSIDE this transaction; do not now take project lifecycle rows while
  // retaining identity locks acquired by this refusal-only path.
  throw conflict("The known reservation changed while waiting. Retry with current state.", {
    code: "project_connection_changed", retryable: true,
  });
}

/**
 * Assignment/grant/profile writers share the same lock order as create/finish.
 * Candidates are only lock hints, never authority. Re-read each row AFTER all
 * waits and reject a changed identity before the caller checks final admission.
 * Call before any connection, grant, install, profile or agent row lock.
 */
export async function lockProjectConnectionRows(
  tx: Db | DbTransaction,
  candidates: readonly Connection[],
  options: Readonly<{ lockSavedRows?: boolean }> = {},
): Promise<Connection[]> {
  const owned = candidates.filter(connection => connection.projectId !== null);
  if (owned.length === 0) return [...candidates];
  const projectKeys = new Map(owned.map(connection => [`${connection.companyId}:${connection.projectId}`, connection]));
  for (const key of [...projectKeys.keys()].sort()) {
    const connection = projectKeys.get(key)!;
    await lockProjectConnectionLifecycle(tx, { companyId: connection.companyId, projectId: connection.projectId! });
  }
  await lockProjectConnectionIdentities(tx, owned.map(connection => projectConnectionIdentityForConnection(connection)!));
  const locked: Connection[] = [];
  // Sort by company + UUID before subordinate saved-row locks. Avoid depending
  // on insertion/catalog order when a profile covers several project scopes.
  for (const companyId of [...new Set(owned.map(connection => connection.companyId))].sort()) {
    // Install/finish uses application -> connection -> profile. Profile writers
    // instead keep their existing full-reference key-share -> profile order;
    // taking one owned application's UPDATE lock here before another profile
    // reference would invert that order. Lifecycle/identity locks still protect
    // the owned mutations, and that caller re-reads after its subordinate waits.
    if (options.lockSavedRows !== false) await tx.select({ id: toolApplications.id }).from(toolApplications).where(and(
      eq(toolApplications.companyId, companyId),
      inArray(toolApplications.id, owned.filter(connection => connection.companyId === companyId).map(connection => connection.applicationId)),
    )).orderBy(toolApplications.id).for("update");
    const query = tx.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, companyId),
      inArray(toolConnections.id, owned.filter(connection => connection.companyId === companyId).map(connection => connection.id)),
    )).orderBy(toolConnections.id);
    locked.push(...await (options.lockSavedRows === false ? query : query.for("no key update")));
  }
  const byId = new Map(locked.map(connection => [connection.id, connection]));
  for (const previous of owned) {
    const current = byId.get(previous.id);
    if (!current) throw notFound("Tool connection not found");
    const before = projectConnectionIdentityForConnection(previous)!;
    const after = projectConnectionIdentityForConnection(current);
    if (!after || previous.projectId !== current.projectId || before.canonicalInstallationKey !== after.canonicalInstallationKey
      || before.verifiedRegistrationId !== after.verifiedRegistrationId) {
      throw conflict("The project connection changed while waiting. Retry with current state.", { code: "project_connection_changed", retryable: true });
    }
    await assertProjectConnectionAvailability(tx, {
      identity: after, projectId: current.projectId,
      exclusive: object(current.config.projectScope)!.exclusive === true,
      excludeConnectionId: current.id,
    });
  }
  return candidates.map(connection => byId.get(connection.id) ?? connection);
}

/** Catch OUTSIDE the complete writer transaction, never commit losing residue. */
export function mapProjectConnectionUniquenessError(error: unknown): unknown {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); ) {
    seen.add(current);
    const record = object(current);
    if (!record) break;
    if (record.code === "23505" && [record.constraint_name, record.constraint].includes(LIVE_INSTALLATION_INDEX)) {
      return conflict("This project already has a live connection to that installation", { code: "project_installation_in_use" });
    }
    current = record.cause;
  }
  return error;
}
