import { and, eq, sql } from "drizzle-orm";
import { agents, issues, routines, companySecretBindings, companySecrets, companySecretVersions, environments, projects, userSecretDeclarations, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import type { RuntimeSecretManifestEntry } from "../secrets.js";
import { runtimeSecretBindingConfiguration } from "../runtime-secret-binding-configuration.js";
import { stableHash } from "../tool-catalog-hash.js";
import { sessionEnvironment } from "./session-fingerprint-inputs.js";
import { ConfigurationIncompleteFailure } from "./run-preparation.js";
import { instanceSettingsService } from "../instance-settings.js";
import { parseIssueExecutionWorkspaceSettings } from "../execution-workspace-policy.js";
import { resolveFreshHeartbeatEnvironmentId, type HeartbeatEnvironmentSelectionSnapshot } from "./environment-selection.js";
import { environmentService } from "../environments.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";

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

type IssueLaunchConfiguration = Pick<typeof issues.$inferSelect,
  "projectId" | "assigneeAgentId" | "assigneeAdapterOverrides" | "originKind" | "originId" | "originRunId" | "executionPolicy">;

export type PlainLaunchSources = {
  agentId: string;
  agentEnv: unknown;
  agentDefaultEnvironmentId: string | null;
  issue: (IssueLaunchConfiguration & { id: string }) | null;
  liveRoutine: { id: string; env: unknown } | null;
};

// Non-env adapterConfig (including model) belongs to the model-change seam:
// a preparation-window edit launches the old model once, next message uses new.
function issuePlainConfiguration(issue: IssueLaunchConfiguration, companyId: string) {
  return { projectId: issue.projectId, assigneeAgentId: issue.assigneeAgentId,
    env: parseObject(parseObject(issue.assigneeAdapterOverrides).adapterConfig).env ?? null,
    originKind: issue.originKind, originId: issue.originId, originRunId: issue.originRunId,
    trust: resolveCoreTrustPreset({ companyId, issue: { executionPolicy: issue.executionPolicy } }) };
}

/** Snapshot configuration CONTENT, never a row revision: status, probe proofs,
 * workspace sync, budget holds and display-only saves must not retire a launch.
 * Environment config uses exactly the session fingerprint's kept fields.
 * No locks or provider calls are held across preparation. */
export async function readExecutionConfigurationRows(db: Db, input: { companyId: string; environmentId: string | null; projectId: string | null; plainSources?: PlainLaunchSources; environmentSelection?: HeartbeatEnvironmentSelectionSnapshot | null }) {
  const environment = input.environmentId ? await db.select(environmentInputs)
    .from(environments).where(eq(environments.id, input.environmentId)).then(rows => rows[0]) : undefined;
  const project = input.projectId ? await db.select({ env: projects.env })
    .from(projects).where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId))).then(rows => rows[0]) : undefined;
  return { ...input, environment, project,
    environmentFingerprint: environment ? executionEnvironmentConfigurationFingerprint(environment) : null,
    projectFingerprint: project ? stableHash(project.env) : null,
    // Bind the ORIGINAL consumed values, not a later read that could certify
    // already-stale preparation. Hashes/values stay in memory, never receipts.
    agentEnvFingerprint: input.plainSources ? stableHash(input.plainSources.agentEnv ?? null) : null,
    issueFingerprint: input.plainSources?.issue ? stableHash(issuePlainConfiguration(input.plainSources.issue, input.companyId)) : null,
    routineFingerprint: input.plainSources?.liveRoutine ? stableHash(input.plainSources.liveRoutine.env ?? null) : null,
  };
}

/** Called ONLY inside the dispatch transaction, before issue/run ownership
 * locks: saves own configuration -> issue -> run, rotations secret -> version
 * -> issue -> run. SHARE (not KEY SHARE) conflicts with non-key updates; the
 * ordinary issue uses SHARE and never upgrades. All issue validation is
 * deferred until after the coordinator and optional ownership issue UPDATE.
 * The fence itself invokes lockIssue before validating issue/selection content;
 * there is no returned check that a caller can silently ignore.
 * Except the bounded agent read below, source locks survive the synchronous handoff.
 * A writer that sampled no native consumer must finish before these reads; we
 * then compare its committed content. No secret is ever resolved a second time. */
export async function assertExecutionConfigurationCurrent(tx: Db, snapshot: Awaited<ReturnType<typeof readExecutionConfigurationRows>>,
  manifest: RuntimeSecretManifestEntry[], supersessions: number, ownershipIssueId: string | null = null,
  lockIssue: () => Promise<void> = async () => {}) {
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
  // Writers save agent/routine -> secret bindings -> issue -> run. Acquire
  // those source rows before secret/binding locks; issue is deliberately last.
  const sources = snapshot.plainSources;
  if (sources) {
    // A settings default save invalidates runtime journals under agents NO KEY
    // UPDATE (0378_environment_skill_runtime_hooks.sql). Holding agent SHARE
    // through handoff would merely move the singleton's writer wait there.
    // Wait for an open agent writer and compare, then release this read lock.
    // Later agent saves use the existing held-turn close / next-prepare seam.
    await tx.execute(sql`savepoint execution_configuration_agent_read`);
    try {
      const [agent] = await tx.select({ adapterConfig: agents.adapterConfig, defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents)
        .where(and(eq(agents.id, sources.agentId), eq(agents.companyId, snapshot.companyId))).for("share");
      if (!agent || agent.defaultEnvironmentId !== sources.agentDefaultEnvironmentId ||
        stableHash(parseObject(agent.adapterConfig).env ?? null) !== snapshot.agentEnvFingerprint) changed();
    } finally {
      // PostgreSQL releases locks acquired after a rolled-back savepoint.
      await tx.execute(sql`rollback to savepoint execution_configuration_agent_read`);
      await tx.execute(sql`release savepoint execution_configuration_agent_read`);
    }
    if (sources.liveRoutine) {
      const [routine] = await tx.select({ env: routines.env }).from(routines)
        .where(and(eq(routines.id, sources.liveRoutine.id), eq(routines.companyId, snapshot.companyId))).for("share");
      if (!routine || stableHash(routine.env ?? null) !== snapshot.routineFingerprint) changed();
    }
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
  if (sources?.issue && ownershipIssueId && sources.issue.id !== ownershipIssueId) changed();
  // Even ordinary recovery may own a coordinator lease: coordinator -> issue.
  await lockIssue();
  await assertExecutionIssueConfigurationCurrent(tx, snapshot, supersessions, sources?.issue?.id !== ownershipIssueId);
  // The earlier agent SHARE was released before routine/secret/issue waits.
  // Re-read committed content here, unlocked, at the actual final boundary.
  if (sources) {
    const [agent] = await tx.select({ adapterConfig: agents.adapterConfig, defaultEnvironmentId: agents.defaultEnvironmentId }).from(agents)
      .where(and(eq(agents.id, sources.agentId), eq(agents.companyId, snapshot.companyId)));
    if (!agent || agent.defaultEnvironmentId !== sources.agentDefaultEnvironmentId ||
      stableHash(parseObject(agent.adapterConfig).env ?? null) !== snapshot.agentEnvFingerprint) changed();
  }
  const selection = snapshot.environmentSelection;
  if (selection) {
    // Deliberately NO settings row lock across handoff. This read is the
    // admission boundary. Later saves retire an admitted native hold at its
    // next hold check; the next fresh preparation reads settings uncached.
    // Compare -> dispatch commit is an UNBOUNDED scheduling / DB-contention
    // window: neither lock_timeout nor statement_timeout supplies a bound.
    const settings = await instanceSettingsService(tx).getReadOnly();
    if (!settings || stableHash({ ...selection,
      executionMode: settings.general.executionMode ?? "any",
      managedSandboxOnly: settings.experimental.enableManagedSandboxOnly === true,
      ...(Object.hasOwn(selection, "instanceDefaultEnvironmentId")
        ? { instanceDefaultEnvironmentId: settings.defaultEnvironmentId ?? null } : {}),
    }) !== stableHash(selection)) changed();
    const svc = environmentService(tx);
    const managed = selection.managedSandboxOnly ? await svc.findManagedSandboxEnvironment(snapshot.companyId) : null;
    const kubernetes = selection.executionMode === "kubernetes" ? await svc.findKubernetesEnvironment(snapshot.companyId) : null;
    let id: string | null;
    try {
      id = resolveFreshHeartbeatEnvironmentId({
        executionMode: settings!.general.executionMode ?? "any", kubernetesEnvironmentId: kubernetes?.id ?? null,
        lowTrustIssueEnvironmentId: selection.lowTrustIssueEnvironmentId ?? null,
        agentDefaultEnvironmentId: sources?.agentDefaultEnvironmentId ?? null,
        instanceDefaultEnvironmentId: settings!.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: selection.localEnvironmentId,
        managedSandboxOnly: selection.managedSandboxOnly, managedSandboxEnvironmentId: managed?.id ?? null,
      });
    } catch { return changed(); }
    const row = id ? await svc.getById(id) : null;
    if (id !== snapshot.environmentId || !row || executionEnvironmentConfigurationFingerprint({ ...row, env: row.envVars }) !== snapshot.environmentFingerprint) changed();
  }
}

async function assertExecutionIssueConfigurationCurrent(tx: Db, snapshot: Awaited<ReturnType<typeof readExecutionConfigurationRows>>,
  supersessions: number, lock: boolean) {
  const issueId = snapshot.plainSources?.issue?.id;
  if (!issueId) return;
  const query = tx.select({ projectId: issues.projectId, assigneeAgentId: issues.assigneeAgentId,
    assigneeAdapterOverrides: issues.assigneeAdapterOverrides, originKind: issues.originKind,
    originId: issues.originId, originRunId: issues.originRunId, executionPolicy: issues.executionPolicy,
    executionWorkspaceSettings: issues.executionWorkspaceSettings }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, snapshot.companyId)));
  const [issue] = await (lock ? query.for("share") : query);
  const selection = snapshot.environmentSelection;
  if (!issue || stableHash(issuePlainConfiguration(issue, snapshot.companyId)) !== snapshot.issueFingerprint ||
    (selection && Object.hasOwn(selection, "lowTrustIssueEnvironmentId") &&
      (parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true })?.environmentId ?? null)
        !== selection.lowTrustIssueEnvironmentId)) throw configurationChangedBeforeLaunch(supersessions);
}
