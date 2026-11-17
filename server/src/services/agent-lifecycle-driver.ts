import { and, eq, inArray, or, sql } from "drizzle-orm";
import { pendingFailedNativeRetryCancellationCondition } from "./native-runtime/native-cancellation-request.js";
import { CANCELLABLE_HEARTBEAT_RUN_STATUSES } from "./heartbeat/recovery.js";
import { promoteDeferredWorkIntents } from "./work-intent-outbox.js";
import { agents, companies, environmentLeases, environments, heartbeatRuns, plugins, pluginCompanySettings, type Db } from "@paperclipai/db";
import { HANDED_OFF_WARM_EXIT_KEY, proveHandedOffWarmLeases } from "./native-runtime/handed-off-warm-lease.js";
import { instanceSettingsService } from "./instance-settings.js";
import { pluginHasAgentEnvironments, pluginServesAgentEnvironment } from "./plugin-environment-driver.js";
import { heartbeatService } from "./heartbeat.js";
import { listInvalidOrgChainDescendantIds } from "./agent-invokability.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { LifecycleDriver } from "../modules/agent-lifecycle/index.js";
import { agentHarnessVerificationService } from "./agent-harness-verification.js";
import { agentInstanceSecretService } from "./agent-instance-secrets.js";
import { AGENT_LIFECYCLE_STOP_REASON, COMPANY_ARCHIVED_STOP_REASON } from "./governance-pause-stop.js";

export function createLifecycleDriver(db: Db, manager: PluginWorkerManager): LifecycleDriver {
  const { verify } = agentHarnessVerificationService(db, manager);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });

  async function resolveAgentEnvironment(agent: { id: string; companyId: string }) {
    const [placement] = await db.select({ environmentId: agents.defaultEnvironmentId }).from(agents)
      .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)));
    const environmentId = placement?.environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
    const [environment] = environmentId ? await db.select().from(environments).where(eq(environments.id, environmentId)) : [];
    return environment;
  }

  /** pl/pausing2: the agent's cancelled native runs holding a retained lease
   * with no runner-exit stamp yet; proveHandedOffWarmLeases keeps only the
   * handed-off warm ones (handedOffWarmLease, the shared Send predicate). */
  async function proveStoppedWarmHandoffs(agent: { id: string; companyId: string }) {
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.runtimeMode, "native"),
      sql`exists (select 1 from ${environmentLeases} where ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
        and ${environmentLeases.companyId} = ${heartbeatRuns.companyId} and ${environmentLeases.status} = 'retained'
        and not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${HANDED_OFF_WARM_EXIT_KEY}))`));
    let proven = false;
    for (const run of runs) {
      const outcome = await proveHandedOffWarmLeases(db, run, { stopFallback: false }).catch(() => "unproven" as const);
      if (outcome === "proven") proven = true;
    }
    return proven;
  }

  return {
    async onReady(agent) {
      await db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: agent.companyId, trigger: "pause_lifted" }));
      await heartbeat.resumeQueuedRunsForAgent(agent.companyId, agent.id);
    },
    async requiredPluginIds(agent) {
      const selected = agent.lifecycleRequiredPluginIds;
      const installed = await db.select().from(plugins).where(inArray(plugins.status, ["ready", "error", "installed", "upgrade_pending"]));
      const disabled = await db.select({ pluginId: pluginCompanySettings.pluginId }).from(pluginCompanySettings)
        .where(and(eq(pluginCompanySettings.companyId, agent.companyId), eq(pluginCompanySettings.enabled, false)));
      const candidates = installed.filter(plugin => !disabled.some(row => row.pluginId === plugin.id) &&
        plugin.manifestJson.agentLifecycle && plugin.manifestJson.capabilities.includes("agents.lifecycle.manage"));
      const environment = await resolveAgentEnvironment(agent);
      if (selected !== null) {
        const added = candidates.filter(plugin => pluginServesAgentEnvironment(plugin, environment) && !selected.includes(plugin.id));
        return [...selected, ...added.map(plugin => plugin.id)];
      }
      return candidates.filter(plugin => !pluginHasAgentEnvironments(plugin) || pluginServesAgentEnvironment(plugin, environment)).map(plugin => plugin.id);
    },
    async runPlugin(agent, pluginId) {
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
      const [settings] = await db.select().from(pluginCompanySettings).where(and(
        eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, agent.companyId)));
      if (settings?.enabled === false || !plugin || plugin.status !== "ready" || !plugin.manifestJson.agentLifecycle || !plugin.manifestJson.capabilities.includes("agents.lifecycle.manage")) {
        throw Object.assign(new Error("A required lifecycle plugin is unavailable"), { code: "required_plugin_unavailable" });
      }
      const operationId = agent.lifecycleOperation!.id;
      const secrets = agentInstanceSecretService(db);
      const instanceSecrets = ["preparing", "resuming"].includes(agent.lifecycleState)
        ? await secrets.read({ companyId: agent.companyId, agentId: agent.id, pluginId }) : {};
      const environment = await resolveAgentEnvironment(agent);
      const environmentDriverKey = pluginServesAgentEnvironment(plugin, environment) && typeof environment?.config?.driverKey === "string"
        ? environment.config.driverKey : undefined;
      const request = { companyId: agent.companyId, agentId: agent.id, operationId, version: agent.lifecycleVersion, phase: agent.lifecycleState,
        ...(environmentDriverKey ? { environmentDriverKey } : {}), instanceSecrets };
      const result = await manager.call(plugin.id, "agentLifecycle", request, 30_000);
      if (!result || result.operationId !== operationId || result.version !== agent.lifecycleVersion || !["complete", "pending"].includes(result.status)) {
        throw Object.assign(new Error("Invalid lifecycle result"), { code: "invalid_lifecycle_result" });
      }
      if (result.instanceSecrets !== undefined) await secrets.apply(request, pluginId, result.instanceSecrets, agent.lifecycleOperation?.leaseOwner);
      return result.status;
    },
    async runHost(agent) {
      if (agent.lifecycleState === "verifying") return verify(agent);
      if (["pausing", "terminating", "cleaning_up"].includes(agent.lifecycleState)) {
        const ids = agent.lifecycleState === "pausing" ? [agent.id]
          : [agent.id, ...listInvalidOrgChainDescendantIds(agent.id,
            await db.select().from(agents).where(eq(agents.companyId, agent.companyId)))];
        const reason = agent.lifecycleHolds?.includes("company_archived")
          ? COMPANY_ARCHIVED_STOP_REASON : AGENT_LIFECYCLE_STOP_REASON;
        // Record what this pause stopped the runs for, so a budget resume
        // continues only the work its own budget stopped, never a manual pause.
        if (agent.lifecycleState === "pausing") {
          // The cause recorded when the pause started survives a resume that
          // already removed the holds before this Stop ran.
          const cause = agent.lifecycleOperation?.pauseCause;
          const pauseStop = sql`jsonb_build_object('pauseStop', jsonb_build_object(
            'holds', ${JSON.stringify(cause?.holds ?? agent.lifecycleHolds ?? [])}::jsonb,
            'companyPauseReason', ${cause ? sql`${cause.companyPauseReason}::text`
              : sql`(select ${companies.pauseReason} from ${companies} where ${companies.id} = ${agent.companyId})`}))`;
          await db.update(heartbeatRuns).set({
            resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${pauseStop}`,
          }).where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
            or(inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]), pendingFailedNativeRetryCancellationCondition()),
            sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'pauseStop')`));
        }
        const options = { preservePauseDeferred: agent.lifecycleState === "pausing",
          ...(agent.lifecycleOperation?.id ? { trigger: `lifecycle:${agent.lifecycleOperation.id}` } : {}) };
        let blocker = await heartbeat.agentInvocationStopBlocker(ids, reason, options);
        // pl/pausing2: a person's warm Stop with NO Send leaves the stopped run's
        // retained warm box (idle Runner alive) without any stop receipt, so the
        // pause waited forever (remote_stop_unconfirmed). Run the Send's own
        // runner-exit proof here: runHost runs outside any DB transaction, the
        // proof is bounded (handedOffWarmProofTimeout), stops the PROCESS only
        // (no box stop/destroy, no lease release, no stop-and-retain fallback),
        // never TERMs a busy owner, and persists the stamp agentExecutionStopBlocker
        // then accepts. A failed proof keeps 'pausing'; the driver retries.
        if (blocker === "remote_stop_unconfirmed" && agent.lifecycleState === "pausing"
          && await proveStoppedWarmHandoffs(agent)) {
          blocker = await heartbeat.agentInvocationStopBlocker(ids, reason, options);
        }
        if (blocker) return { pending: blocker };
      }
      return "complete";
    },
  };
}
