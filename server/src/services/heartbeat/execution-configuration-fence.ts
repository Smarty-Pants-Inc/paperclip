import { and, eq, sql } from "drizzle-orm";
import { companySecretBindings, companySecrets, companySecretVersions, environments, projects, userSecretDeclarations, type Db } from "@paperclipai/db";
import type { RuntimeSecretManifestEntry } from "../secrets.js";
import { ConfigurationIncompleteFailure } from "./run-preparation.js";

/** A fresh preparation lost to a configuration write; no provider work is owed. */
export class ConfigurationSupersededFailure extends Error {
  constructor() { super("Configuration changed before launch; preparing the same wake again."); }
}

export function configurationChangedBeforeLaunch(supersessions: number): Error {
  return supersessions < 3 ? new ConfigurationSupersededFailure()
    : new ConfigurationIncompleteFailure("Configuration kept changing before launch after three automatic preparations. Wait for configuration changes to finish, then retry.", {
      configurationIncomplete: { reason: "configuration_churn", supersessions },
    });
}

/** Snapshot the exact plain/binding rows used by the resolver, not an earlier
 * selection's objects. xmin catches no-op saves and same-millisecond updates.
 * No locks or provider calls are held across preparation. */
export async function readExecutionConfigurationRows(db: Db, input: { companyId: string; environmentId: string | null; projectId: string | null }) {
  const environment = input.environmentId ? await db.select({ env: environments.envVars, revision: sql<string>`xmin::text` })
    .from(environments).where(eq(environments.id, input.environmentId)).then(rows => rows[0]) : undefined;
  const project = input.projectId ? await db.select({ env: projects.env, revision: sql<string>`xmin::text` })
    .from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId))).then(rows => rows[0]) : undefined;
  return { ...input, environment, project };
}

/** Called ONLY inside the dispatch transaction, before issue/run ownership
 * locks: saves own configuration -> issue -> run, rotations secret -> version
 * -> issue -> run. SHARE (not KEY SHARE) conflicts with non-key updates. The
 * locks survive through the dispatch decision and synchronous provider handoff.
 * A writer that sampled no native consumer must finish before these reads; we
 * then see its committed revision. No secret is ever resolved a second time. */
export async function assertExecutionConfigurationCurrent(tx: Db, snapshot: Awaited<ReturnType<typeof readExecutionConfigurationRows>>,
  manifest: RuntimeSecretManifestEntry[], supersessions: number) {
  const changed = () => { throw configurationChangedBeforeLaunch(supersessions); };
  if (snapshot.environmentId) {
    const [row] = await tx.select({ revision: sql<string>`xmin::text` }).from(environments)
      .where(eq(environments.id, snapshot.environmentId)).for("share");
    if (!row || row.revision !== snapshot.environment?.revision) changed();
  }
  if (snapshot.projectId) {
    const [row] = await tx.select({ revision: sql<string>`xmin::text` }).from(projects)
      .where(and(eq(projects.id, snapshot.projectId), eq(projects.companyId, snapshot.companyId))).for("share");
    if (!row || row.revision !== snapshot.project?.revision) changed();
  }
  // Stable parent -> version -> binding order, shared by all fresh dispatches.
  for (const entry of [...manifest].sort((a, b) => a.secretId.localeCompare(b.secretId) || a.version - b.version || (a.bindingId ?? "").localeCompare(b.bindingId ?? ""))) {
    const revision = entry.dispatchRevision;
    // Old admitted executions bypass this fresh-only guard. Fresh resolutions
    // must carry metadata; absence cannot certify a launch.
    if (!revision) changed();
    const [secret] = await tx.select({ updatedAt: companySecrets.updatedAt, latestVersion: companySecrets.latestVersion,
      status: companySecrets.status, deletedAt: companySecrets.deletedAt }).from(companySecrets)
      .where(and(eq(companySecrets.id, entry.secretId), eq(companySecrets.companyId, snapshot.companyId))).for("share");
    const [version] = secret ? await tx.select({ id: companySecretVersions.id, status: companySecretVersions.status,
      revokedAt: companySecretVersions.revokedAt }).from(companySecretVersions)
      .where(and(eq(companySecretVersions.secretId, entry.secretId), eq(companySecretVersions.version, entry.version))).for("share") : [];
    // Revocation/missing material is a real configuration blocker, not churn.
    if (!secret || secret.deletedAt || secret.status !== "active" || !version || version.revokedAt || ["disabled", "destroyed"].includes(version.status)) {
      throw new ConfigurationIncompleteFailure(!secret ? "The required secret was removed before launch."
        : secret.status !== "active" || secret.deletedAt ? "The required secret is no longer active."
          : "The required secret version is missing or revoked.", {
        configurationIncomplete: { reason: !secret ? "secret_deleted" : secret.status !== "active" || secret.deletedAt ? "secret_inactive" : "version_inactive" },
      });
    }
    if (secret.updatedAt.toISOString() !== revision!.secretUpdatedAt || version.id !== revision!.versionId ||
      (revision!.versionSelector === "latest" && secret.latestVersion !== entry.version)) changed();
    if (entry.bindingId) {
      const table = revision!.bindingKind === "user" ? userSecretDeclarations : companySecretBindings;
      const [binding] = await tx.select({ updatedAt: table.updatedAt }).from(table)
        .where(and(eq(table.id, entry.bindingId), eq(table.companyId, snapshot.companyId))).for("share");
      if (!binding || binding.updatedAt.toISOString() !== revision!.bindingUpdatedAt) changed();
    }
  }
}
