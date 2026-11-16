import type { Db } from "@paperclipai/db";
import { agentHarnessType, type PermissionKey } from "@paperclipai/shared";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { isPlainRecord } from "../lib/agent-records.js";
import { collectAgentAdapterWorkspaceCommandPaths } from "../routes/workspace-command-authz.js";
import type { AuthorizationActor } from "./authorization.js";
import { agentService } from "./agents.js";
import { assertReportEnvSecretAccess, isReportRuntimeEnv } from "./agent-report-runtime.js";
import { authorizeAgentPermissionGrant } from "./agent-permission-grants.js";

export const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
  "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath",
] as const;

export const INHERITABLE_AGENT_CREDENTIAL_ENV_KEYS: Record<string, readonly string[]> = {
  claude_local: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex_local: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  grok_local: ["XAI_API_KEY"],
  opencode_local: ["OPENROUTER_API_KEY"],
};

export function isInheritableCredentialReference(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && (value.type === "secret_ref" || value.type === "user_secret_ref");
}

const LOCAL_ADAPTER_HOST_COMMAND_KEYS = [
  "command", "hermesCommand", "args", "extraArgs", "cwd", "env", "filesystemSandboxCommand",
] as const;
const LOCAL_ADAPTER_CREDENTIAL_ENV_KEYS: Record<string, readonly string[]> = {
  ...INHERITABLE_AGENT_CREDENTIAL_ENV_KEYS,
  gemini_local: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  kimi_local: ["KIMI_MODEL_API_KEY"],
  opencode_local: ["PAPERCLIP_OPENCODE_PROVIDERS", "OPENCODE_AUTH_JSON"],
};
const POOL_AUTH_OVERRIDE_ENV_KEYS = [
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PAPERCLIP_OPENCODE_PROVIDERS", "OPENCODE_AUTH_JSON",
] as const;

export function assertNoAgentAdapterConfigMutation(
  actor: AuthorizationActor, adapterConfig: Record<string, unknown>, path = "adapterConfig",
) {
  if (actor.type !== "agent") return;
  if (Object.hasOwn(adapterConfig, "homeMode")) throw forbidden("Only an operator can configure Runner homeMode.");
  if (["dotAttachmentAccess", "dotWorkspaceAccess", "dotBindingId", "externalBindingId", "museBindingId", "museGeneration", "museConnection"].some(key => Object.hasOwn(adapterConfig, key))) {
    throw forbidden("Only an operator can configure external-agent pairing, attachment access, or workspace access.");
  }
  const instructions = KNOWN_INSTRUCTIONS_BUNDLE_KEYS.filter(key => adapterConfig[key] !== undefined).map(key => `${path}.${key}`);
  if (instructions.length > 0) throw forbidden(`Agent-authenticated callers cannot modify instructions path or bundle configuration (${instructions.join(", ")})`);
  const commands = collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path);
  if (commands.length > 0) throw forbidden(`Agent keys cannot modify host-executed workspace commands (${commands.join(", ")}).`);
}

export function assertNoAgentProcessAdapterMutation(actor: AuthorizationActor, adapterType: string, mutatesConfiguration: boolean) {
  if (actor.type === "agent" && adapterType === "process" && mutatesConfiguration) {
    throw forbidden("Agent keys cannot configure host-executed process adapters.");
  }
}

function containsOnlyLocalAdapterCredentialRefs(adapterType: string, env: unknown, allowPlainCredentials: boolean) {
  if (!isPlainRecord(env)) return false;
  const allowedKeys = LOCAL_ADAPTER_CREDENTIAL_ENV_KEYS[adapterType] ?? [];
  return Object.entries(env).every(([key, value]) =>
    (allowedKeys.includes(key) && isInheritableCredentialReference(value)) ||
    (allowPlainCredentials && POOL_AUTH_OVERRIDE_ENV_KEYS.includes(key as typeof POOL_AUTH_OVERRIDE_ENV_KEYS[number])
      && (typeof value === "string" ? value.trim().length > 0
        : isPlainRecord(value) && value.type === "plain" && typeof value.value === "string" && value.value.trim().length > 0)),
  );
}

/** Also used by PATCH and rollback: their existing report authority is unchanged. */
export function assertNoAgentLocalAdapterHostCommandMutation(
  actor: AuthorizationActor, adapterType: string, adapterConfig: Record<string, unknown>,
  allowPlainCredentials = false, harnessConfig = adapterConfig, allowReportEnv = false,
) {
  if (actor.type !== "agent" || (!adapterType.endsWith("_local") && adapterType !== "paperclip_runner")) return;
  const harness = agentHarnessType(adapterType, harnessConfig);
  const changedKeys = LOCAL_ADAPTER_HOST_COMMAND_KEYS.filter(key => adapterConfig[key] !== undefined &&
    (key !== "env" || (!(allowReportEnv && adapterType === "paperclip_runner") &&
      !containsOnlyLocalAdapterCredentialRefs(harness, adapterConfig.env, allowPlainCredentials))));
  if (changedKeys.length > 0) throw forbidden(`Agent keys cannot configure host-executed local adapter settings (${changedKeys.join(", ")}).`);
}

type Grant = { permissionKey: PermissionKey; scope?: Record<string, unknown> | null };
type Company = { id: string; requireBoardApprovalForNewAgents?: boolean | null };
type Proposal = { adapterType?: string | null; adapterConfig?: Record<string, unknown> | null; budgetMonthlyCents?: number | null };

/** Package grants are separate from platform activation defaults. Before creation
 * reject unbounded delegation; after reporting links exist, use the live subtree
 * validator in the same import transaction before replaying any package grant. */
export async function assertAgentActorPermissionGrants(
  db: Db, actor: AuthorizationActor, companyId: string, grants: Grant[], targetAgentId?: string,
) {
  for (const grant of grants) {
    try {
      if (actor.type === "agent" && !grant.scope) throw forbidden("Agents cannot delegate an unscoped permission");
      if (targetAgentId) await authorizeAgentPermissionGrant(db, actor, { id: targetAgentId, companyId }, grant.permissionKey, true, grant.scope);
    } catch (error) {
      if (actor.type !== "agent" || !(error instanceof HttpError) || error.status !== 403) throw error;
      throw unprocessable(`Cannot import permission grant ${grant.permissionKey}: ${error.message}`);
    }
  }
}

/** Actor-aware admission for create, hire and import. Inspect submitted values
 * BEFORE runner/persistence normalization or prepareAgentHire's side effects.
 * Importers call again with transaction-bound services after the company lock.
 * RFL 18:06Z: no plaintext classifier; runner env uses the live PATCH helpers. */
export async function admitAgentActorHire(
  db: Db, actor: AuthorizationActor, company: Company, proposal: Proposal,
  options: { operation?: "create" | "hire"; budgetError?: () => Error; permissionGrants?: Grant[] } = {},
) {
  const requiresApproval = company.requireBoardApprovalForNewAgents === true;
  if (actor.type !== "agent") return { requiresApproval: false };
  if ((proposal.budgetMonthlyCents ?? 0) > 0 && (options.operation === "create" || !requiresApproval)) {
    throw options.budgetError?.() ?? forbidden("Board access required to set a positive starting budget without a pending hire approval");
  }
  if (proposal.adapterType === undefined && proposal.adapterConfig === undefined) return { requiresApproval };
  const adapterType = proposal.adapterType ?? "process";
  const adapterConfig = proposal.adapterConfig ?? {};
  assertNoAgentAdapterConfigMutation(actor, adapterConfig);
  const caller = actor.agentId ? await agentService(db).getById(actor.agentId) : null;
  const callerConfig = caller?.companyId === company.id && isPlainRecord(caller.runtimeConfig) ? caller.runtimeConfig : {};
  const pool = isPlainRecord(callerConfig.aiConnection) && callerConfig.aiConnection.mode === "router";
  const reportEnv = adapterType === "paperclip_runner" && isReportRuntimeEnv(adapterConfig.env);
  assertNoAgentLocalAdapterHostCommandMutation(actor, adapterType, adapterConfig, pool, adapterConfig, reportEnv);
  assertNoAgentProcessAdapterMutation(actor, adapterType, Object.keys(adapterConfig).length > 0);
  await assertReportEnvSecretAccess(db, actor, { id: "", companyId: company.id, adapterType }, adapterConfig.env);
  await assertAgentActorPermissionGrants(db, actor, company.id, options.permissionGrants ?? []);
  return { requiresApproval };
}
