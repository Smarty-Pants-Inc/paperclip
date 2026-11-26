import { and, eq } from "drizzle-orm";
import { companySecretBindings, companySecrets, companySecretVersions, environments, projects, userSecretDeclarations, type Db } from "@paperclipai/db";
import type { RuntimeSecretManifestEntry } from "../secrets.js";
import { runtimeSecretBindingConfiguration } from "../runtime-secret-binding-configuration.js";
import { stableHash } from "../tool-catalog-hash.js";
import { sessionEnvironment } from "./session-fingerprint-inputs.js";
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

const environmentInputs = { id: environments.id, driver: environments.driver, config: environments.config, env: environments.envVars };

export function executionEnvironmentConfigurationFingerprint(row: { id: string; driver: string; config: Record<string, unknown>; env: unknown }) {
  return stableHash({ environment: sessionEnvironment({ selectedEnvironment: { id: row.id, driver: row.driver, config: row.config } }), env: row.env });
}

/** Snapshot configuration CONTENT, never a row revision: status, probe proofs,
 * workspace sync, budget holds and display-only saves must not retire a launch.
 * Environment config uses exactly the session fingerprint's kept fields.
 * No locks or provider calls are held across preparation. */
export async function readExecutionConfigurationRows(db: Db, input: { companyId: string; environmentId: string | null; projectId: string | null }) {
  const environment = input.environmentId ? await db.select(environmentInputs)
    .from(environments).where(eq(environments.id, input.environmentId)).then(rows => rows[0]) : undefined;
  const project = input.projectId ? await db.select({ env: projects.env })
    .from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId))).then(rows => rows[0]) : undefined;
  return { ...input, environment, project,
    environmentFingerprint: environment ? executionEnvironmentConfigurationFingerprint(environment) : null,
    projectFingerprint: project ? stableHash(project.env) : null,
  };
}

/** Called ONLY inside the dispatch transaction, before issue/run ownership
 * locks: saves own configuration -> issue -> run, rotations secret -> version
 * -> issue -> run. SHARE (not KEY SHARE) conflicts with non-key updates. The
 * locks survive through the dispatch decision and synchronous provider handoff.
 * A writer that sampled no native consumer must finish before these reads; we
 * then compare its committed content. No secret is ever resolved a second time. */
export async function assertExecutionConfigurationCurrent(tx: Db, snapshot: Awaited<ReturnType<typeof readExecutionConfigurationRows>>,
  manifest: RuntimeSecretManifestEntry[], supersessions: number) {
  const changed = () => { throw configurationChangedBeforeLaunch(supersessions); };
  if (snapshot.environmentId) {
    const [row] = await tx.select(environmentInputs).from(environments)
      .where(eq(environments.id, snapshot.environmentId)).for("share");
    if (!row || executionEnvironmentConfigurationFingerprint(row) !== snapshot.environmentFingerprint) changed();
  }
  if (snapshot.projectId) {
    const [row] = await tx.select({ env: projects.env }).from(projects)
      .where(and(eq(projects.id, snapshot.projectId), eq(projects.companyId, snapshot.companyId))).for("share");
    if (!row || stableHash(row.env) !== snapshot.projectFingerprint) changed();
  }
  // Stable parent -> version -> semantic binding target order. Binding row IDs
  // are storage identity only; an identical save may delete and reinsert them.
  const bindingKey = (entry: RuntimeSecretManifestEntry) => {
    const binding = entry.dispatchRevision?.binding;
    return binding ? JSON.stringify([binding.kind, binding.targetType, binding.targetId, binding.configPath]) : "";
  };
  for (const entry of [...manifest].sort((a, b) => a.secretId.localeCompare(b.secretId) || a.version - b.version || bindingKey(a).localeCompare(bindingKey(b)))) {
    const revision = entry.dispatchRevision;
    // Old admitted executions bypass this fresh-only guard. Fresh resolutions
    // must carry metadata; absence cannot certify a launch.
    if (!revision) changed();
    const [secret] = await tx.select({ latestVersion: companySecrets.latestVersion,
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
    if (version.id !== revision!.versionId ||
      (revision!.versionSelector === "latest" && secret.latestVersion !== entry.version)) changed();
    const admittedBinding = revision!.binding;
    if (admittedBinding) {
      const table = admittedBinding.kind === "user" ? userSecretDeclarations : companySecretBindings;
      const [binding] = await tx.select().from(table).where(and(eq(table.companyId, snapshot.companyId),
        eq(table.targetType, admittedBinding.targetType), eq(table.targetId, admittedBinding.targetId), eq(table.configPath, admittedBinding.configPath))).for("share");
      if (!binding || runtimeSecretBindingConfiguration(binding).fingerprint !== admittedBinding.fingerprint) changed();
    } else if (entry.bindingId) changed(); // Fresh bound values must have a semantic snapshot.
  }
}
