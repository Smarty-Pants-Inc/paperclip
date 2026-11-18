import { companySecretBindings, type Db } from "@paperclipai/db";
import { envBindingSchema } from "@paperclipai/shared";
import { and, eq, inArray } from "drizzle-orm";
import { forbidden, HttpError } from "../errors.js";
import { assertCanManageSubordinateAgent } from "./agent-subtree-management.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { secretService } from "./secrets.js";

type Target = { id: string; companyId: string; adapterType: string };
export const REPORT_RUNTIME_PERMISSION = "agents:configure-reports-runtime" as const;
export const REPORT_ENV_REFUSAL = "Agent keys cannot configure host-executed local adapter settings (env).";

/** A separate, revocable company-scoped grant; it never substitutes for direct
 * configure authority over a current strict reporting descendant. */
export async function canConfigureReportRuntime(db: Db, actor: AuthorizationActor, target: Target) {
  if (actor.type !== "agent" || !actor.agentId || target.adapterType !== "paperclip_runner") return false;
  try {
    await assertCanManageSubordinateAgent(db, actor, target);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return false;
    throw error;
  }
  const decision = await authorizationService(db).decidePrincipalGrant({
    companyId: target.companyId, principalType: "agent", principalId: actor.agentId,
    action: REPORT_RUNTIME_PERMISSION, permissionKey: REPORT_RUNTIME_PERMISSION,
    scope: { targetAgentId: target.id },
  });
  return decision.allowed;
}

/** The new exception covers plain and company-secret bindings only. Other
 * reference kinds retain their existing adapter-specific rules. */
export function isReportRuntimeEnv(env: unknown): boolean {
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  return Object.values(env).every(value => {
    const parsed = envBindingSchema.safeParse(value);
    return parsed.success && (typeof parsed.data === "string" || parsed.data.type === "plain" || parsed.data.type === "secret_ref");
  });
}

/** Reuse own-run secret binding/version admission without decrypting a value.
 * Run-bound callers also reuse the existing access listing, which includes
 * inherited runtime-manifest bindings and enforces the current run boundary. */
export async function assertReportEnvSecretAccess(
  db: Db, actor: AuthorizationActor, target: Target, env: unknown,
) {
  if (actor.type !== "agent" || !actor.agentId || !env || typeof env !== "object" || Array.isArray(env)) return;
  const refs = Object.values(env).flatMap(value => {
    const parsed = envBindingSchema.safeParse(value);
    return parsed.success && typeof parsed.data !== "string" && parsed.data.type === "secret_ref" ? [parsed.data] : [];
  });
  if (refs.length === 0) return;
  const secrets = secretService(db);
  const denied = (secretId: string) => forbidden(`Caller cannot resolve secret ${secretId} for a report's environment`);
  const decision = await authorizationService(db).decide({ actor, action: "secrets:read", resource: { type: "company", companyId: target.companyId } });
  if (!decision.allowed) throw denied(refs[0]!.secretId);
  const bindings = actor.source === "agent_jwt"
    ? await secrets.listAgentSecretAccess(target.companyId, {
        agentId: actor.agentId, actorSource: "agent_jwt", heartbeatRunId: actor.runId ?? "",
        responsibleUserId: actor.onBehalfOfUserId, keyId: actor.keyId, keyScope: actor.keyScope,
      }).then(entries => entries.length > 0
        ? db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, target.companyId), inArray(companySecretBindings.id, entries.map(entry => entry.bindingId))))
        : [])
      .catch(() => { throw denied(refs[0]!.secretId); })
    : await db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, target.companyId), eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, actor.agentId),
      ));
  for (const ref of refs) {
    const candidates = bindings.filter(binding => binding.secretId === ref.secretId
      && (binding.configPath.startsWith("env.") || binding.configPath.startsWith("access.")));
    let allowed = false;
    for (const binding of candidates) {
      try {
        // This calls the same assertBindingContext used by
        // resolveAdapterConfigForRuntime / resolveEnvBindings for the caller's run.
        await secrets.resolveSecretVersionIdentity(target.companyId, ref.secretId, ref.version ?? "latest", {
          consumerType: binding.targetType as "agent" | "project" | "environment" | "routine",
          consumerId: binding.targetId, configPath: binding.configPath,
          actorType: "agent", actorId: actor.agentId, responsibleUserId: actor.onBehalfOfUserId,
          heartbeatRunId: actor.runId,
        });
        allowed = true;
        break;
      } catch { /* Try another binding, never disclose material or provider errors. */ }
    }
    if (!allowed) throw denied(ref.secretId);
  }
}
