import { definePlugin, type EnvSecretRefBinding, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { GitHubApi, GitHubHttpFailure, isRecord, signManagerAppJwt, type ManagerAppConfig } from "./github-api.js";
import { SafeFailure } from "./errors.js";
import { PluginInstanceSecretManagerKeySource } from "./manager-key-source.js";

const PRIMARY_SMARTY_AGENT_ID = "29b216c4-76bc-41a3-a71a-88d30737b688";
const ALLOWED_ORGANIZATION = "Smarty-Pants-Inc";
const BUILTIN_DENIED_REPOSITORIES = ["tristar-org", "secrets"];
const STATE_NAMESPACE = "row12-installer";
const USED_APPS_KEY = "used-app-slugs";

export interface Row12PluginOptions {
  /** Test-only endpoint override. Production uses GitHub's API origin. */
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
}

interface RegisteredApp {
  slug: string;
  appId: string;
  clientId: string;
  installationId?: string;
  privateKeyRef?: EnvSecretRefBinding;
  approvedRepositoryIds: string[];
}

interface InstallerConfig extends ManagerAppConfig {
  allowedOrg: string;
  allowedCallerAgentIds: string[];
  deniedRepos: string[];
  registeredApps: RegisteredApp[];
}

type SafeData = Record<string, unknown>;
type Operation = (input: {
  ctx: PluginContext;
  config: InstallerConfig;
  run: ToolRunContext;
  params: unknown;
  app: RegisteredApp | null;
  api: GitHubApi;
}) => Promise<{ data: SafeData; audit?: SafeData }>;

const toolDeclarations = {
  github_app_installable_orgs: {
    displayName: "List installable enterprise organizations",
    description: "Verify enterprise-owned organizations available to the manager App.",
    parametersSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  github_app_install: {
    displayName: "Install a registered GitHub App",
    description: "Install an allowlisted project App on approved repositories of Smarty-Pants-Inc.",
    parametersSchema: { type: "object", properties: { slug: { type: "string" }, repositories: { type: "array", items: { type: "string" } } }, required: ["slug", "repositories"], additionalProperties: false },
  },
  github_app_set_repositories: {
    displayName: "Change selected repository access",
    description: "Add approved repositories to an existing registered App installation. Removal is unavailable in phase one.",
    parametersSchema: { type: "object", properties: { installationId: { type: "string" }, add: { type: "array", items: { type: "string" } }, remove: { type: "array", items: { type: "string" } } }, required: ["installationId", "add", "remove"], additionalProperties: false },
  },
  github_app_narrow_installation: {
    displayName: "Narrow an installation",
    description: "Set a registered App installation to exactly the approved selected repositories.",
    parametersSchema: { type: "object", properties: { slug: { type: "string" }, keep: { type: "array", items: { type: "string" } } }, required: ["slug", "keep"], additionalProperties: false },
  },
  github_app_suspend: {
    displayName: "Suspend a registered App installation",
    description: "Suspend a registered App installation using that App's own key.",
    parametersSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false },
  },
  github_app_unsuspend: {
    displayName: "Unsuspend a registered App installation",
    description: "Unsuspend a registered App installation using that App's own key.",
    parametersSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false },
  },
} as const;

function fail(message: string): never {
  throw new SafeFailure(message);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("Invalid tool parameters.");
  return value;
}

function readSafeName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..") {
    fail(`Invalid ${field}; use a simple repository or App slug.`);
  }
  return value;
}

function readNames(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > 50) fail(`Invalid ${field}; supply at most 50 names.`);
  const names = value.map((item) => readSafeName(item, field));
  if (!allowEmpty && names.length === 0) fail(`${field} must not be empty.`);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) fail(`${field} must not contain duplicates.`);
  return names;
}

function readPositiveId(value: unknown, label: string): string {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^[1-9][0-9]*$/.test(raw)) fail(`Invalid ${label}.`);
  return raw;
}

function safeAuditName(value: unknown): string | null {
  return typeof value === "string" && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== ".." ? value : null;
}

function safeAuditNames(params: unknown, key: string): string[] {
  if (!isRecord(params) || !Array.isArray(params[key])) return [];
  return params[key].filter((item): item is string => safeAuditName(item) !== null).slice(0, 50);
}

function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return isRecord(value)
    && value.type === "secret_ref"
    && typeof value.secretId === "string"
    && value.secretId.length > 0
    && (value.version === undefined || value.version === "latest" || (typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version > 0));
}

function initialAppId(configValue: unknown, params: unknown): string | null {
  if (!isRecord(configValue) || !Array.isArray(configValue.registeredApps)) return null;
  const slug = isRecord(params) ? safeAuditName(params.slug) : null;
  if (!slug) return null;
  const app = configValue.registeredApps.find((candidate) => isRecord(candidate) && candidate.slug === slug);
  return isRecord(app) && typeof app.appId === "string" && /^[0-9]+$/.test(app.appId) ? app.appId : null;
}

function parseConfig(value: unknown): InstallerConfig {
  if (!isRecord(value)) fail("Installer configuration is unavailable.");
  if (value.allowedOrg !== ALLOWED_ORGANIZATION) fail(`The only permitted organization is ${ALLOWED_ORGANIZATION}.`);
  const enterpriseSlug = typeof value.enterpriseSlug === "string" ? value.enterpriseSlug : "";
  const managerAppId = typeof value.managerAppId === "string" ? value.managerAppId : "";
  const managerInstallationId = typeof value.managerInstallationId === "string" ? value.managerInstallationId : "";
  const managerKeyAnchorProjectId = typeof value.managerKeyAnchorProjectId === "string" ? value.managerKeyAnchorProjectId : "";
  if (!/^[A-Za-z0-9-]+$/.test(enterpriseSlug) || !/^[0-9]+$/.test(managerAppId) || !/^[1-9][0-9]*$/.test(managerInstallationId) || !managerKeyAnchorProjectId) {
    fail("Installer configuration is invalid; no GitHub request was made.");
  }
  const allowedCallers = Array.isArray(value.allowedCallerAgentIds) ? value.allowedCallerAgentIds : [];
  if (allowedCallers.length !== 1 || allowedCallers[0] !== PRIMARY_SMARTY_AGENT_ID) {
    fail("Phase-one caller configuration must contain only the primary Smarty agent.");
  }
  if (!Array.isArray(value.registeredApps) || value.registeredApps.length === 0) fail("The server-side registered App allowlist is empty.");
  const registeredApps: RegisteredApp[] = value.registeredApps.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.slug !== "string" || !/^[A-Za-z0-9_.-]+$/.test(candidate.slug) || typeof candidate.appId !== "string" || !/^[0-9]+$/.test(candidate.appId) || typeof candidate.clientId !== "string" || candidate.clientId.length < 1 || candidate.clientId.length > 200 || (candidate.installationId !== undefined && !(typeof candidate.installationId === "string" && /^[1-9][0-9]*$/.test(candidate.installationId)) && !(typeof candidate.installationId === "number" && Number.isSafeInteger(candidate.installationId) && candidate.installationId > 0)) || (candidate.privateKeyRef !== undefined && !isSecretRef(candidate.privateKeyRef)) || !Array.isArray(candidate.approvedRepositoryIds)) {
      fail("A server-side registered App entry is invalid.");
    }
    const approvedRepositoryIds = candidate.approvedRepositoryIds.map((id) => {
      if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0) && !(typeof id === "string" && /^[1-9][0-9]*$/.test(id))) fail("A primary-ratified repository ID is invalid.");
      return String(id);
    });
    return { slug: candidate.slug, appId: candidate.appId, clientId: candidate.clientId, installationId: candidate.installationId === undefined ? undefined : String(candidate.installationId), privateKeyRef: candidate.privateKeyRef as EnvSecretRefBinding | undefined, approvedRepositoryIds };
  });
  if (new Set(registeredApps.map((app) => app.slug)).size !== registeredApps.length) fail("The registered App allowlist contains duplicate slugs.");
  const deniedRepos = Array.isArray(value.deniedRepos) ? value.deniedRepos.filter((item): item is string => typeof item === "string") : [];
  return {
    enterpriseSlug,
    allowedOrg: ALLOWED_ORGANIZATION,
    managerAppId,
    managerInstallationId,
    managerKeyAnchorProjectId,
    allowedCallerAgentIds: [PRIMARY_SMARTY_AGENT_ID],
    deniedRepos: [...BUILTIN_DENIED_REPOSITORIES, ...deniedRepos],
    registeredApps,
  };
}

function registeredApp(config: InstallerConfig, slug: string): RegisteredApp {
  const app = config.registeredApps.find((candidate) => candidate.slug === slug);
  if (!app) fail(`App slug ${slug} is not in the server-side registered allowlist.`);
  return app;
}

async function registeredAppJwt(ctx: PluginContext, config: InstallerConfig, run: ToolRunContext, app: RegisteredApp): Promise<string> {
  if (!app.privateKeyRef) fail(`Registered App ${app.slug} has no private-key secret reference; no GitHub request was made.`);
  let privateKey: string;
  try {
    const index = config.registeredApps.indexOf(app);
    privateKey = await ctx.secrets.resolve(app.privateKeyRef, { companyId: run.companyId, configPath: `registeredApps.${index}.privateKeyRef` });
  } catch {
    throw new SafeFailure(`Registered App ${app.slug} private key unavailable; no GitHub request was made.`);
  }
  try {
    return signManagerAppJwt(app.appId, privateKey);
  } catch {
    throw new SafeFailure(`Registered App ${app.slug} private key unavailable; no GitHub request was made.`);
  }
}

async function registeredInstallationId(ctx: PluginContext, companyId: string, app: RegisteredApp): Promise<string> {
  const stored = await ctx.state.get(companyState(companyId, `installation-${app.slug}`));
  const value = stored ?? app.installationId;
  if (value === undefined || value === null) fail(`Registered App ${app.slug} has no bound installation; no GitHub request was made.`);
  return readPositiveId(value, "installation ID");
}

async function findRegisteredInstallation(ctx: PluginContext, companyId: string, config: InstallerConfig, installationId: string): Promise<RegisteredApp> {
  const matches: RegisteredApp[] = [];
  for (const app of config.registeredApps) {
    const stored = await ctx.state.get(companyState(companyId, `installation-${app.slug}`));
    const current = stored ?? app.installationId;
    if (String(current ?? "") === installationId) matches.push(app);
  }
  if (matches.length !== 1) fail("Installation ID is not uniquely bound to a registered App in server configuration or plugin state.");
  return matches[0]!;
}

function authorizePrimary(run: ToolRunContext, config: InstallerConfig): void {
  if (run.agentId !== PRIMARY_SMARTY_AGENT_ID || !config.allowedCallerAgentIds.includes(run.agentId)) {
    fail(`Only the primary Smarty (${PRIMARY_SMARTY_AGENT_ID}) may use this installer in phase one.`);
  }
}

function requireAllowedRepositories(config: InstallerConfig, names: string[]): void {
  const denied = new Set(config.deniedRepos.map((name) => name.toLowerCase()));
  const blocked = names.find((name) => denied.has(name.toLowerCase()));
  if (blocked) fail(`Repository ${blocked} is denied by the client-data and secrets boundary.`);
}

async function installableOrganizations(api: GitHubApi, config: InstallerConfig, token: string): Promise<{ status: number; logins: string[] }> {
  const response = await api.request("GET", `/enterprises/${encodeURIComponent(config.enterpriseSlug)}/apps/installable_organizations?per_page=100`, token);
  const data = Array.isArray(response.data)
    ? response.data
    : isRecord(response.data) && Array.isArray(response.data.organizations)
      ? response.data.organizations
      : [];
  const logins = data.filter(isRecord).map((org) => org.login).filter((login): login is string => typeof login === "string");
  return { status: response.status, logins };
}

async function assertEnterpriseOrganization(api: GitHubApi, config: InstallerConfig, token: string): Promise<number> {
  const response = await installableOrganizations(api, config, token);
  if (!response.logins.some((login) => login.toLowerCase() === config.allowedOrg.toLowerCase())) {
    fail(`${config.allowedOrg} is not enterprise-owned by this manager App; fall back to manual install.`);
  }
  return response.status;
}

async function resolveApprovedRepositories(api: GitHubApi, config: InstallerConfig, app: RegisteredApp, names: string[], token: string): Promise<string[]> {
  requireAllowedRepositories(config, names);
  const ids: string[] = [];
  for (const name of names) {
    const response = await api.request("GET", `/repos/${encodeURIComponent(config.allowedOrg)}/${encodeURIComponent(name)}`, token);
    const id = isRecord(response.data) ? response.data.id : null;
    const stableId = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === "string" && /^[1-9][0-9]*$/.test(id) ? id : null;
    if (!stableId || !app.approvedRepositoryIds.includes(stableId)) {
      fail(`Stable repository ID for ${name} is not approved for this project.`);
    }
    ids.push(stableId);
  }
  return ids;
}

function readInstallationId(data: unknown): number {
  const raw = isRecord(data) ? data.id : null;
  const value = typeof raw === "number" && Number.isSafeInteger(raw) ? raw : typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value < 1) fail("GitHub response did not include an installation ID.");
  return value;
}

function companyState(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: STATE_NAMESPACE, stateKey };
}

async function usedApps(ctx: PluginContext, companyId: string): Promise<Set<string>> {
  const value = await ctx.state.get(companyState(companyId, USED_APPS_KEY));
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function result(data: SafeData): ToolResult {
  return { content: JSON.stringify(data), data };
}

function resultHttpStatus(data: unknown): number | null {
  return isRecord(data) && typeof data.httpStatus === "number" ? data.httpStatus : null;
}

function resultInstallationId(data: unknown): number | null {
  return isRecord(data) && typeof data.installationId === "number" ? data.installationId : null;
}

function resultRepositories(data: unknown): string[] {
  return isRecord(data) && Array.isArray(data.repositories) ? data.repositories.filter((item): item is string => typeof item === "string") : [];
}

function resultRepositoryIds(data: unknown): string[] {
  return isRecord(data) && Array.isArray(data.repositoryIds) ? data.repositoryIds.map(String).filter((item) => /^[1-9][0-9]*$/.test(item)) : [];
}

function makeAuditMetadata(run: ToolRunContext, operation: string, appId: string | null, slug: string | null, installationId: number | null, repositories: string[], repositoryIds: string[], status: string, httpStatus: number | null): SafeData {
  return {
    phase: status === "attempt" ? "intent" : "outcome",
    operation,
    runId: run.runId,
    agentId: run.agentId,
    projectId: run.projectId || null,
    appId,
    slug,
    installationId,
    repositories,
    repositoryIds,
    status,
    httpStatus,
  };
}

function outcomeAuditFailure(tool: string, app: RegisteredApp | null, slug: string | null, installationId: number | null, repositories: string[], repositoryIds: string[], httpStatus: number | null): string {
  const repoResults = repositories.length === 0
    ? "none"
    : repositories.map((name, index) => `${name} (${repositoryIds[index] ?? "stable ID unavailable"})`).join(", ");
  return `GitHub result: ${tool} for App ${app?.slug ?? slug ?? "unknown"} (App id ${app?.appId ?? "unknown"}), installation ${installationId ?? "unknown"}, repositories [${repoResults}], HTTP ${httpStatus ?? "unknown"}; the outcome audit could not be recorded. Do not retry; reconcile the GitHub state first.`;
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof SafeFailure) return error.message;
  if (error instanceof GitHubHttpFailure) return `GitHub request failed with HTTP ${error.httpStatus ?? "unknown"}.`;
  return "GitHub operation failed safely; no credentials or remote response were returned.";
}

export function createRow12Plugin(options: Row12PluginOptions = {}) {
  return definePlugin({
    async setup(ctx) {
      const keySource = new PluginInstanceSecretManagerKeySource(ctx);
      const api = new GitHubApi(keySource, { baseUrl: options.apiBaseUrl, fetcher: options.fetcher });

      const register = (name: keyof typeof toolDeclarations, operation: Operation) => {
        const declaration = toolDeclarations[name];
        ctx.tools.register(name, declaration, async (rawParams: unknown, run: ToolRunContext): Promise<ToolResult> => {
          const rawConfig = await ctx.config.get(run.companyId).catch(() => null);
          const slug = safeAuditName(isRecord(rawParams) ? rawParams.slug : null);
          const repositories = safeAuditNames(rawParams, "repositories").length > 0
            ? safeAuditNames(rawParams, "repositories")
            : safeAuditNames(rawParams, "keep").length > 0
              ? safeAuditNames(rawParams, "keep")
              : safeAuditNames(rawParams, "add");
          const appId = initialAppId(rawConfig, rawParams);
          const installationId = isRecord(rawParams) ? safeAuditName(rawParams.installationId) : null;
          const attempt = makeAuditMetadata(run, name, appId, slug, installationId && /^[1-9][0-9]*$/.test(installationId) ? Number(installationId) : null, repositories, [], "attempt", null);
          try {
            await ctx.activity.log({
              companyId: run.companyId,
              message: `Row-12 ${name} attempt`,
              entityType: "github_app_installation",
              entityId: installationId ?? undefined,
              metadata: attempt,
            });
          } catch {
            return { error: "Audit intent could not be recorded; no GitHub request was made." };
          }

          let config: InstallerConfig | null = null;
          let selectedApp: RegisteredApp | null = null;
          let output: SafeData | null = null;
          let outcomeStatus = "refused";
          let auditHttpStatus: number | null = null;
          let auditInstallationId: number | null = attempt.installationId as number | null;
          let auditRepositories = repositories;
          let auditRepositoryIds: string[] = [];
          try {
            if (!rawConfig) fail("Installer configuration is unavailable.");
            config = parseConfig(rawConfig);
            authorizePrimary(run, config);
            if (slug) selectedApp = config.registeredApps.find((candidate) => candidate.slug === slug) ?? null;
            const completed = await operation({ ctx, config, run, params: rawParams, app: selectedApp, api });
            output = completed.data;
            outcomeStatus = "succeeded";
            auditHttpStatus = resultHttpStatus(output);
            auditInstallationId = resultInstallationId(output) ?? auditInstallationId;
            auditRepositories = resultRepositories(output).length > 0 ? resultRepositories(output) : auditRepositories;
            auditRepositoryIds = resultRepositoryIds(output);
          } catch (error) {
            outcomeStatus = error instanceof SafeFailure && error.httpStatus ? "failed" : "refused";
            auditHttpStatus = error instanceof SafeFailure ? error.httpStatus ?? null : null;
            const outcome = makeAuditMetadata(run, name, selectedApp?.appId ?? appId, slug, auditInstallationId, auditRepositories, auditRepositoryIds, outcomeStatus, auditHttpStatus);
            try {
              await ctx.activity.log({
                companyId: run.companyId,
                message: `Row-12 ${name} ${outcomeStatus}`,
                entityType: "github_app_installation",
                entityId: auditInstallationId ? String(auditInstallationId) : undefined,
                metadata: outcome,
              });
            } catch {
              return { error: "Operation failed; the outcome audit could not be recorded." };
            }
            return { error: toolErrorMessage(error) };
          }

          const outcome = makeAuditMetadata(run, name, selectedApp?.appId ?? appId, slug, auditInstallationId, auditRepositories, auditRepositoryIds, outcomeStatus, auditHttpStatus);
          try {
            await ctx.activity.log({
              companyId: run.companyId,
              message: `Row-12 ${name} succeeded`,
              entityType: "github_app_installation",
              entityId: auditInstallationId ? String(auditInstallationId) : undefined,
              metadata: outcome,
            });
          } catch {
            return { error: outcomeAuditFailure(name, selectedApp, slug, auditInstallationId, auditRepositories, auditRepositoryIds, auditHttpStatus) };
          }
          return output ? result(output) : { error: "Operation completed without a safe result." };
        });
      };

      register("github_app_installable_orgs", async ({ config, run }) => api.withInstallationToken(config, run.companyId, async (token) => {
        const response = await installableOrganizations(api, config, token);
        const available = response.logins.some((login) => login.toLowerCase() === config.allowedOrg.toLowerCase());
        return {
          data: {
            organizations: response.logins,
            allowedOrgAvailable: available,
            message: available ? `${config.allowedOrg} is enterprise-owned and installable.` : `${config.allowedOrg} is not enterprise-owned by this manager App; fall back to manual install.`,
            httpStatus: response.status,
          },
        };
      }).then((completed) => completed));

      register("github_app_install", async ({ ctx: pluginCtx, config, run, params, api: github }) => {
        const input = readRecord(params);
        const slug = readSafeName(input.slug, "slug");
        const app = registeredApp(config, slug);
        const repositories = readNames(input.repositories, "repositories");
        requireAllowedRepositories(config, repositories);
        return github.withInstallationToken(config, run.companyId, async (token) => {
          await assertEnterpriseOrganization(github, config, token);
          const repositoryIds = await resolveApprovedRepositories(github, config, app, repositories, token);
          const response = await github.request("POST", `/enterprises/${encodeURIComponent(config.enterpriseSlug)}/apps/organizations/${encodeURIComponent(config.allowedOrg)}/installations`, token, {
            client_id: app.clientId,
            repository_selection: "selected",
            repositories,
          });
          const installationId = readInstallationId(response.data);
          await pluginCtx.state.set(companyState(run.companyId, `installation-${slug}`), installationId);
          const used = await usedApps(pluginCtx, run.companyId);
          for (const registered of config.registeredApps) {
            if (registered.installationId) used.add(registered.slug);
          }
          used.add(slug);
          await pluginCtx.state.set(companyState(run.companyId, USED_APPS_KEY), [...used].sort());
          const unusedSlugs = config.registeredApps.map((item) => item.slug).filter((item) => !used.has(item)).sort();
          const lowStock = unusedSlugs.length <= 2;
          const lowStockDeduplicationKey = lowStock ? `row12:low-stock:${run.companyId}:${unusedSlugs.join(",")}` : null;
          return {
            data: { installationId, appId: app.appId, slug, repositories, repositoryIds, httpStatus: response.status, lowStock, lowStockDeduplicationKey },
          };
        });
      });

      register("github_app_set_repositories", async ({ ctx: pluginCtx, config, run, params, api: github }) => {
        const input = readRecord(params);
        const installationId = readPositiveId(input.installationId, "installation ID");
        const add = readNames(input.add, "add", true);
        const remove = readNames(input.remove, "remove", true);
        if (remove.length > 0) fail("Repository removal is refused in this phase; no DELETE request will be sent.");
        if (add.length === 0) fail("Specify at least one approved repository to add.");
        requireAllowedRepositories(config, add);
        return github.withInstallationToken(config, run.companyId, async (token) => {
          await assertEnterpriseOrganization(github, config, token);
          const app = await findRegisteredInstallation(pluginCtx, run.companyId, config, installationId);
          const repositoryIds = await resolveApprovedRepositories(github, config, app, add, token);
          const response = await github.request("POST", `/enterprises/${encodeURIComponent(config.enterpriseSlug)}/apps/organizations/${encodeURIComponent(config.allowedOrg)}/installations/${installationId}/repositories`, token, { repositories: add });
          return { data: { installationId: Number(installationId), appId: app.appId, slug: app.slug, repositories: add, repositoryIds, httpStatus: response.status } };
        });
      });

      register("github_app_narrow_installation", async ({ ctx: pluginCtx, config, run, params, api: github }) => {
        const input = readRecord(params);
        const slug = readSafeName(input.slug, "slug");
        const app = registeredApp(config, slug);
        const keep = readNames(input.keep, "keep");
        requireAllowedRepositories(config, keep);
        const storedInstallation = await pluginCtx.state.get(companyState(run.companyId, `installation-${slug}`));
        const installationId = readPositiveId(storedInstallation ?? app.installationId, "installation ID");
        return github.withInstallationToken(config, run.companyId, async (token) => {
          await assertEnterpriseOrganization(github, config, token);
          const repositoryIds = await resolveApprovedRepositories(github, config, app, keep, token);
          const response = await github.request("PATCH", `/enterprises/${encodeURIComponent(config.enterpriseSlug)}/apps/organizations/${encodeURIComponent(config.allowedOrg)}/installations/${installationId}/repositories`, token, {
            repository_selection: "selected",
            repositories: keep,
          });
          return { data: { installationId: Number(installationId), appId: app.appId, slug, repositories: keep, repositoryIds, httpStatus: response.status } };
        });
      });

      const setSuspended = async (input: { ctx: PluginContext; config: InstallerConfig; run: ToolRunContext; params: unknown; api: GitHubApi }, suspended: boolean) => {
        const params = readRecord(input.params);
        const slug = readSafeName(params.slug, "slug");
        const app = registeredApp(input.config, slug);
        const installationId = await registeredInstallationId(input.ctx, input.run.companyId, app);
        const appJwt = await registeredAppJwt(input.ctx, input.config, input.run, app);
        const response = suspended
          ? await input.api.suspendInstallation(installationId, appJwt)
          : await input.api.unsuspendInstallation(installationId, appJwt);
        return { data: { installationId: Number(installationId), appId: app.appId, slug, repositories: [], repositoryIds: [], httpStatus: response.status } };
      };

      register("github_app_suspend", (input) => setSuspended(input, true));
      register("github_app_unsuspend", (input) => setSuspended(input, false));
    },
    async onResourceLifecycle(event) {
      return { eventId: event.id, status: "acknowledged" };
    },
  });
}
