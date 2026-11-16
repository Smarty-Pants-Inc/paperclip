import { notifyMuseContactVerification } from "../modules/external-agents/index.js";
import { notifyBudgetResumeAgentReady } from "./budget-resume-continuation.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { notifyChatInboundWakeNotices } from "./chat-inbound-wake-notice-notifications.js";
import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";
import { isTransientLockContention, postgresErrorCode, retryTransientLockContention } from "./transient-lock-contention.js";
import { transactionRetryStats } from "./transaction-retry.js";
import { agents, companies, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { persistActivity, type ActivityPublication } from "./activity-log.js";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { deleteAgentDependencies } from "./agent-deletion.js";
import { lockAgentConfigurationInteractions, prepareAgentConfiguration, completeAgentConfiguration } from "./agent-configuration.js";
import { prepareAgentHire, initializeAgentHire, prepareAgentHireApproval, completeAgentHireApproval } from "./agent-hiring.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { fenceActiveCompanyAgentStopsInTransaction as fenceActiveCompanyStops } from "../modules/agent-lifecycle/index.js";
import { applyAgentPolicyHoldsInTransaction } from "../modules/agent-lifecycle/index.js";
import { trackIdleWork } from "./task-admission.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { pluginEnvironmentRequiresAgent, pluginForAgentEnvironment } from "./plugin-environment-driver.js";
import { isProviderApiSetupDraft } from "./native-runtime/provider-api-placement.js";
import { redactSensitiveText } from "../redaction.js";

export { scheduleAgentLifecycle, processAgentLifecycle } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function lifecycleErrorDetail(error: unknown): string {
  const details: Array<{ name: string; code?: string | number; message: string }> = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth <= 3 && current !== null && (typeof current === "object" || typeof current === "function"); depth++) {
    const source = current as { cause?: unknown; code?: unknown; status?: unknown; details?: unknown; message?: unknown; constructor?: { name?: unknown } };
    if (seen.has(source)) break;
    seen.add(source);
    const constructorName = typeof source.constructor?.name === "string" ? source.constructor.name : "Error";
    const rawCode = typeof source.code === "string" || typeof source.code === "number" ? source.code : undefined;
    const isSafeCode = (value: string) => /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)
      && !/[a-z0-9]{20,}/i.test(value) && !/(?:sk-|ghp_|gho_|xox)/i.test(value);
    const code = typeof rawCode === "string" ? isSafeCode(rawCode) ? rawCode : undefined : rawCode;
    const rawDetails = source.details;
    const errorDetails = rawDetails !== null && typeof rawDetails === "object" && !Array.isArray(rawDetails)
      ? rawDetails as Record<string, unknown> : undefined;
    const detailCodeValue = [errorDetails?.code, errorDetails?.failureCode, errorDetails?.reason]
      .find((value): value is string => typeof value === "string" && isSafeCode(value));
    const status = Number.isInteger(source.status) && Number(source.status) >= 100 && Number(source.status) <= 599
      ? Number(source.status) : undefined;
    const message = typeof source.message === "string" ? source.message : "";
    const safeMessage = /^[a-z][a-z0-9_]{2,80}(:[ a-z0-9_.()-]{0,160})?$/.test(message)
      && !/[a-z0-9]{20,}/.test(message)
      && !/(?:sk-|ghp_|gho_|xox)/i.test(message)
      ? redactSensitiveText(message) : "withheld";
    details.push({ name: constructorName.slice(0, 80), ...(code === undefined ? {} : { code: typeof code === "string" ? code.slice(0, 80) : code }),
      ...(status === undefined ? {} : { status }), ...(detailCodeValue === undefined ? {} : { detailCode: detailCodeValue.slice(0, 80) }), message: safeMessage });
    current = source.cause;
  }
  let serialized = JSON.stringify(details);
  while (serialized.length > 512 && details.length > 1) {
    details.pop();
    serialized = JSON.stringify(details);
  }
  return serialized.length <= 512 ? serialized : "[]";
}

export function createAgentLifecycleEffects(_hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    async setupRequiresPreparation(db, companyId, environmentId, profile) {
      if (isProviderApiSetupDraft(profile)) return false;
      const id = environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
      const environment = id ? await environmentService(db).getById(id) : null;
      if (!environment || !await pluginEnvironmentRequiresAgent(db, environment)) return false;
      const [company] = await db.select({ requiresApproval: companies.requireBoardApprovalForNewAgents }).from(companies).where(eq(companies.id, companyId));
      if (!company || company.requiresApproval) return false;
      const bound = await environmentService(db).listBoundCompanyIds(environment.id);
      if (bound.length && !bound.includes(companyId)) throw new lifecycle.AgentLifecycleConflict("The environment belongs to another company");
      return true;
    },
    async environmentRequiresNewPlugin(db, environmentId, selectedPluginIds) {
      const id = environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
      const environment = id ? await environmentService(db).getById(id) : null;
      const plugin = environment ? await pluginForAgentEnvironment(db, environment) : null;
      return plugin !== null && !selectedPluginIds?.includes(plugin.id);
    },
    notifyWork: tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle),
    leaseHolder: () => currentControllerProcessStamp(),
    beforeConnectionEligibilityRestore: async (tx, companyId, agentId) => {
      await notifyMuseContactVerification(tx, { companyId, agentId });
    },
    async beforeStatusChange(tx, companyId, agentId, before, after) {
      await notifyAttentionRetentionWork(tx, { companyId });
      if (before !== after) {
        await notifyStrandedAgentStatus(tx, { companyId, agentId });
        await notifyRunDispatch(tx, { companyId });
        await notifyDeferredExecutionEligibility(tx, { companyId });
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
      }
      if (!isAgentStatusInvokable(before) && isAgentStatusInvokable(after)) {
        await notifyNativeResponsePresentation(tx, { companyId, agentId });
        await notifyNativeReviewResponse(tx, { companyId, agentId });
        await notifyChatInboundWakeNotices(tx, { companyId });
        await notifyBudgetResumeAgentReady(tx, agentId);
      }
    },
    reportFailure(context, error) {
      const code = lifecycle.lifecycleFailureCode(error);
      logger.warn({ ...context, failureCode: code ?? "unclassified", errorDetail: lifecycleErrorDetail(error) }, "Agent lifecycle operation failed");
    },
    transaction: withAccountingTransaction,
    deleteDependencies: deleteAgentDependencies,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId, isActive) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive, windowKind: "calendar_month_utc",
      }, userId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    lockConfigurationInteractions: lockAgentConfigurationInteractions,
    prepareConfiguration: prepareAgentConfiguration,
    completeConfiguration: completeAgentConfiguration,
    prepareHire: prepareAgentHire,
    initializeHire: initializeAgentHire,
    prepareHireApproval: prepareAgentHireApproval,
    completeHireApproval: completeAgentHireApproval,
  };
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}, authorize?: (tx: Db) => Promise<void>) {
  const effects = createAgentLifecycleEffects(hooks);
  // Reporting-tree edits use this same company accounting lock. Never reuse a
  // route's earlier authorization snapshot after waiting for that lock.
  if (authorize) effects.transaction = (database, companyId, work) =>
    withAccountingTransaction(database, companyId, async (tx, publications) => {
      await authorize(tx);
      return work(tx, publications);
    });
  const agentLifecycle = lifecycle.createAgentLifecycle(db, effects);
  const requestHire = agentLifecycle.requestHire.bind(agentLifecycle);
  agentLifecycle.requestHire = (...args) => requestHireWithContentionRetry(db, requestHire, ...args);
  return agentLifecycle;
}

export const AGENT_HIRE_ATTEMPTS = 5;
export const AGENT_HIRE_CONTENTION_CODE = "agent_hire_grant_contention";
/** Named warning: the agent is complete; company default grants for built-in agents were deferred. */
export const COMPANY_DEFAULT_GRANTS_DEFERRED = "company_default_grants_deferred";

export const AGENT_HIRE_CONTENTION_MESSAGE = "Paperclip could not finish this hire because other updates to the same "
  + "company kept conflicting with it. Nothing was saved. Retry the same request.";

/** #20805: lock contention that survives every hire attempt. The hire transaction
 * rolled back as a whole, so no agent row, membership or grant was kept. Same shape
 * as AccountingContentionError: 503, `code` keeps the SQLSTATE, the database error
 * stays only in `cause`. */
export class AgentHireContentionError extends HttpError {
  readonly code: string;
  constructor(cause: unknown, readonly attempts: number) {
    super(503, AGENT_HIRE_CONTENTION_MESSAGE, { code: AGENT_HIRE_CONTENTION_CODE, retryable: true });
    this.name = "AgentHireContentionError";
    this.code = postgresErrorCode(cause) ?? "40P01";
    this.cause = cause;
  }
}

type RequestHire = ReturnType<typeof lifecycle.createAgentLifecycle>["requestHire"];

/** The whole hire transaction (agent row, membership, grants) is the retried unit,
 * so an attempt that rolls back leaves nothing behind. Post-commit hints run once. */
async function requestHireWithContentionRetry(db: Db, requestHire: RequestHire, ...args: Parameters<RequestHire>) {
  let agent: Awaited<ReturnType<RequestHire>>;
  try {
    agent = await retryTransientLockContention(() => requestHire(...args), AGENT_HIRE_ATTEMPTS, {
      jitterMs: 50,
      onRetry: (error, attempt) => {
        transactionRetryStats.retried++;
        logger.warn({ companyId: args[0], attempt, sqlState: postgresErrorCode(error) }, "Agent hire hit lock contention; retrying the hire transaction");
      },
    });
  } catch (error) {
    if (!isTransientLockContention(error)) throw error;
    throw new AgentHireContentionError(error, AGENT_HIRE_ATTEMPTS);
  }
  if (args[2]?.memberGrant) {
    // The membership is committed: wake a pending Muse contact verification once,
    // outside any attempt that could roll back.
    await db.transaction(tx => notifyMuseContactVerification(tx as unknown as Db, { companyId: agent.companyId, agentId: agent.id }));
  }
  return agent;
}

export function initializeImportedAgentConfigurationInTransaction(tx: Db, publications: ActivityPublication[],
  id: string, data: Parameters<typeof lifecycle.initializeImportedAgentConfigurationInTransaction>[4]) {
  return lifecycle.initializeImportedAgentConfigurationInTransaction(tx, createAgentLifecycleEffects(), publications, id, data);
}

export function requestAgentHireInTransaction(tx: Db, publications: ActivityPublication[],
  ...args: Parameters<ReturnType<typeof createAgentLifecycle>["requestHire"]>) {
  return lifecycle.requestAgentHireInTransaction(tx, createAgentLifecycleEffects(), publications, ...args);
}

function trackedDriver(driver: lifecycle.LifecycleDriver): lifecycle.LifecycleDriver {
  return { ...driver, runHost: agent => trackIdleWork(driver.runHost(agent)),
    runPlugin: (agent, pluginId) => trackIdleWork(driver.runPlugin(agent, pluginId)) };
}

export function configureAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun = () => true) {
  return lifecycle.configureAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

export function startAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun: () => boolean) {
  return lifecycle.startAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

/** Budget evaluation owns the transaction and supplies the aggregate agent decision. */
/** Pass the transaction's post-commit `publications` so the entry reaches live
 * subscribers after commit; without them it publishes nothing until reload. */
export async function applyAgentBudgetHoldInTransaction(tx: Db, companyId: string, agentId: string, blocked: boolean,
  publications?: ActivityPublication[]) {
  const [before] = await tx.select({ holds: agents.lifecycleHolds }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  const updated = await applyAgentPolicyHoldsInTransaction(tx, createAgentLifecycleEffects(), companyId, agentId, { budget: blocked });
  // A budget pause is a governance stop: record it, and its release, with the
  // reason, in the transaction that applies it.
  const had = before?.holds?.includes("budget") ?? false;
  const has = updated?.lifecycleHolds?.includes("budget") ?? had;
  if (updated && had !== has) {
    const { publication } = await persistActivity(tx, { companyId, actorType: "system", actorId: "budget",
      // Releasing the budget hold resumes the agent only when no other hold
      // (a manual or company pause) still keeps it paused.
      agentId, action: has ? "agent.paused" : updated.lifecycleHolds.length === 0 ? "agent.resumed" : "agent.budget_hold_released",
      entityType: "agent", entityId: agentId,
      details: { reason: "budget", lifecycleState: updated.lifecycleState, holds: updated.lifecycleHolds } });
    if (publication) publications?.push(publication);
  }
  return updated;
}

export function fenceActiveCompanyAgentStopsInTransaction(tx: Db, companyId: string, status: "paused" | "archived") {
  return fenceActiveCompanyStops(tx, createAgentLifecycleEffects(), companyId, status);
}
