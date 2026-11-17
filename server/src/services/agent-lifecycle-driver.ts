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
import type { CancelledWarmExportOutcome } from "./heartbeat/cancelled-warm-workspace-export.js";

/** pl/pausing3: the pause's aggregate bound on failed runner-exit proofs:
 * 3 failed attempts or 2 minutes since the first, whichever comes first; the
 * stop_and_retain receipt then gets the same bound before the agent shows an error. */
export const pauseProofBound = { attempts: 3, ms: 2 * 60_000 };
const PAUSE_PROOF_KEY = "handedOffWarmPauseProof";
export const PAUSE_STOP_UNCONFIRMED_ERROR = "Couldn't confirm the stopped turn's box has stopped. Your work is kept. Press Retry now to check again.";
/** pl/pausing4: the export-before-stop guard kept the box (its 'prepared' turn's export was not finalized). */
export const PAUSE_EXPORT_KEPT_ERROR = "The stopped turn's files are not confirmed on the host yet, so its box was kept and not stopped. Nothing on it is lost. Press Retry now to check again.";
/** pl/pausing4 (rf-4 ruling 22:32Z): the export a 'prepared' turn needs before
 * the bound's stop: the cancel-finalize export (finishCancelledWarmWorkspaceExport)
 * under the run's finalization ownership. It needs the run's in-process
 * workspace sync; this process has none for a stopped turn, so the default
 * answers unproven and the box is KEPT with a true line. */
export const pauseBoundExport = {
  finish: async (_db: Db, _run: { id: string; companyId: string }): Promise<CancelledWarmExportOutcome> =>
    ({ outcome: "unproven", reason: "no_export_owner_in_process" }),
};
function preparedDescriptor(profile: unknown): boolean {
  const reference = (profile as { remoteWorkspace?: { state?: unknown } } | null)?.remoteWorkspace;
  return reference?.state === "prepared";
}
type LifecycleAgentArg = Parameters<LifecycleDriver["runHost"]>[0];

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
    const failed: typeof runs = [];
    for (const run of runs) {
      const outcome = await proveHandedOffWarmLeases(db, run, { stopFallback: false }).catch(() => "timed_out" as const);
      if (outcome === "proven") proven = true;
      if (outcome === "timed_out") failed.push(run);
    }
    return { proven, failed };
  }

  /** pl/pausing3/4: the pause's aggregate proof bound. Failed (502/hang) proofs are
   * counted in the operation's existing stopFailures; the first failure's time is
   * kept on the agent's lease (PAUSE_PROOF_KEY). At the bound the pause takes the
   * Send's documented stop_and_retain fallback (box and files kept) through the
   * export-before-stop guard (rf-4 ruling 22:32Z): a box holding a 'prepared'
   * turn is exported first (pauseBoundExport, the cancel-finalize export under
   * its finalization ownership) or KEPT with a true line; a busy owner is never
   * stopped. If the stop's receipt does not come within the bound, the agent
   * shows lifecycleError + retryRequired ("Retry now"). Retry clears stopFailures,
   * and the first pass after it opens a NEW receipt window (stopRequestedAt reset). */
  async function boundPauseProof(agent: LifecycleAgentArg, failed: Awaited<ReturnType<typeof proveStoppedWarmHandoffs>>["failed"]) {
    const operationId = agent.lifecycleOperation?.id;
    if (!operationId) return;
    const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, agent.companyId),
      sql`${environmentLeases.metadata}->'${sql.raw(PAUSE_PROOF_KEY)}'->>'operationId' = ${operationId}`));
    const record = leases.map(lease => lease.metadata?.[PAUSE_PROOF_KEY] as { firstFailedAt?: string; stopRequestedAt?: string })
      .find(Boolean);
    const awaitingReceipt = leases.filter(lease => lease.metadata?.sandboxStopAndRetain && lease.metadata?.sandboxStopAndRetainReceipt == null);
    if (!failed.length && !awaitingReceipt.length) return;
    // No stopFailures: the first pass of this operation, or the first after Retry now.
    const fresh = agent.lifecycleOperation?.stopFailures == null;
    const failures = (agent.lifecycleOperation?.stopFailures ?? 0) + 1;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const firstFailedAt = fresh || !record?.firstFailedAt ? nowIso : record.firstFailedAt;
    const same = and(eq(agents.id, agent.id), eq(agents.lifecycleVersion, agent.lifecycleVersion),
      sql`${agents.lifecycleOperation}->>'id' = ${operationId}`);
    await db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} || ${JSON.stringify({ stopFailures: failures })}::jsonb` })
      .where(same);
    const stamp = async (runIds: string[], value: Record<string, unknown>) => runIds.length && db.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [PAUSE_PROOF_KEY]: { operationId, firstFailedAt, ...value } })}::jsonb` })
      .where(and(eq(environmentLeases.companyId, agent.companyId), inArray(environmentLeases.heartbeatRunId, runIds)));
    // A true state the person can act on (AgentLifecycleStatus.tsx renders
    // lifecycleError with "Retry now"); never 'pausing' forever.
    const showError = (line: string) => db.update(agents).set({ lifecycleError: line,
      lifecycleOperation: sql`(${agents.lifecycleOperation} - 'leaseOwner' - 'leaseUntil' - 'leaseHolder' - 'retryAt') || '{"retryRequired":true}'::jsonb`,
      updatedAt: new Date() }).where(same);
    if (failed.length) {
      const atBound = failures >= pauseProofBound.attempts || now - Date.parse(firstFailedAt) >= pauseProofBound.ms;
      await stamp(failed.map(run => run.id), {});
      if (!atBound) return;
      const { handedOffWarmOwnerBusy } = await import("./native-runtime/native-session-executor.js");
      let kept = false;
      for (const run of failed) {
        const runLeases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
          eq(environmentLeases.heartbeatRunId, run.id)));
        // Never a busy owner: no stop; the agent stays 'pausing' (its true state).
        if (runLeases.some(lease => handedOffWarmOwnerBusy({ runId: run.id, providerLeaseId: lease.providerLeaseId }))) continue;
        // Export-before-stop guard: a 'prepared' turn is exported (finalized) first, or kept.
        if (preparedDescriptor(run.runnerProfileJson)) {
          const exported = await pauseBoundExport.finish(db, run).catch(() => ({ outcome: "unproven" as const, reason: "export_failed" }));
          const [current] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId)));
          if (exported.outcome !== "finalized" || !current || preparedDescriptor(current.runnerProfileJson)) { kept = true; continue; }
        }
        // The Send's own bounded proof with its stop_and_retain fallback (the box is
        // stopped and KEPT, never destroyed); it never stops a busy owner.
        await proveHandedOffWarmLeases(db, run).catch(() => "timed_out" as const);
      }
      const intents = (await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, agent.companyId),
        inArray(environmentLeases.heartbeatRunId, failed.map(run => run.id)))))
        .filter(lease => lease.metadata?.sandboxStopAndRetain && lease.metadata?.sandboxStopAndRetainReceipt == null);
      await stamp([...new Set(intents.map(lease => lease.heartbeatRunId!))], { stopRequestedAt: nowIso });
      if (kept) await showError(PAUSE_EXPORT_KEPT_ERROR);
      return;
    }
    if (fresh || !record?.stopRequestedAt) {
      // A new receipt window (first pass after Retry now): stopRequestedAt is reset.
      await stamp([...new Set(awaitingReceipt.map(lease => lease.heartbeatRunId!))], { stopRequestedAt: nowIso });
      return;
    }
    if (now - Date.parse(record.stopRequestedAt) < pauseProofBound.ms) return;
    await showError(PAUSE_STOP_UNCONFIRMED_ERROR);
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
        if (blocker && agent.lifecycleState === "pausing") {
          let failed: Awaited<ReturnType<typeof proveStoppedWarmHandoffs>>["failed"] = [];
          if (blocker === "remote_stop_unconfirmed") {
            const proof = await proveStoppedWarmHandoffs(agent);
            failed = proof.failed;
            if (proof.proven) blocker = await heartbeat.agentInvocationStopBlocker(ids, reason, options);
          }
          // pl/pausing3/4: a persistent proof failure (502 or hang) is bounded.
          // Its own stop intent then awaits the receipt (environment_lease_unreleased),
          // which gets the same bound (boundPauseProof acts only on this operation's leases).
          if (blocker) await boundPauseProof(agent, failed);
        }
        if (blocker) return { pending: blocker };
      }
      return "complete";
    },
  };
}
