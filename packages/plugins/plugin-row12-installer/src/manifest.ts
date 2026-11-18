import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-row12-installer",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Enterprise GitHub App Installer",
  description: "Phase-one, primary-only installation of registered GitHub Apps on Smarty-Pants-Inc.",
  author: "Smarty Pants",
  categories: ["connector", "automation"],
  resourceLifecycle: ["project"],
  instanceSecretKeys: ["manager_private_key"],
  capabilities: [
    "agent.tools.register",
    "activity.log.write",
    "events.subscribe",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "projects.instance-secrets",
    "projects.read",
    "issues.read",
    "secrets.read-ref",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    required: ["enterpriseSlug", "allowedOrg", "managerAppId", "managerInstallationId", "managerKeyAnchorProjectId", "allowedCallerAgentIds", "registeredApps"],
    properties: {
      enterpriseSlug: { type: "string", pattern: "^[A-Za-z0-9-]+$" },
      allowedOrg: { type: "string", const: "Smarty-Pants-Inc" },
      managerAppId: { type: "string", pattern: "^[0-9]+$" },
      managerInstallationId: { type: "string", pattern: "^[1-9][0-9]*$" },
      managerKeyAnchorProjectId: { type: "string", minLength: 1 },
      allowedCallerAgentIds: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", const: "29b216c4-76bc-41a3-a71a-88d30737b688" } },
      deniedRepos: { type: "array", items: { type: "string" } },
      registeredApps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["slug", "appId", "clientId", "approvedRepositoryIds"],
          properties: {
            slug: { type: "string", pattern: "^[A-Za-z0-9_.-]+$" },
            appId: { type: "string", pattern: "^[0-9]+$" },
            clientId: { type: "string", minLength: 1 },
            privateKeyRef: { type: "object", format: "secret-ref" },
            installationId: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", pattern: "^[1-9][0-9]*$" }] },
            approvedRepositoryIds: { type: "array", minItems: 1, items: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", pattern: "^[1-9][0-9]*$" }] } },
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  },
  tools: [
    { name: "github_app_installable_orgs", displayName: "List installable enterprise organizations", description: "Verify enterprise-owned organizations available to the manager App.", parametersSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "github_app_install", displayName: "Install a registered GitHub App", description: "Install an allowlisted project App on approved repositories of Smarty-Pants-Inc.", parametersSchema: { type: "object", properties: { slug: { type: "string" }, repositories: { type: "array", items: { type: "string" } } }, required: ["slug", "repositories"], additionalProperties: false } },
    { name: "github_app_set_repositories", displayName: "Change selected repository access", description: "Add approved repositories to an existing registered App installation. Removal is not available in phase one.", parametersSchema: { type: "object", properties: { installationId: { type: "string" }, add: { type: "array", items: { type: "string" } }, remove: { type: "array", items: { type: "string" } } }, required: ["installationId", "add", "remove"], additionalProperties: false } },
    { name: "github_app_narrow_installation", displayName: "Narrow an installation", description: "Set a registered App installation to exactly the approved selected repositories.", parametersSchema: { type: "object", properties: { slug: { type: "string" }, keep: { type: "array", items: { type: "string" } } }, required: ["slug", "keep"], additionalProperties: false } },
    { name: "github_app_suspend", displayName: "Suspend a registered App installation", description: "Suspend a registered App installation using that App's own key.", parametersSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false } },
    { name: "github_app_unsuspend", displayName: "Unsuspend a registered App installation", description: "Unsuspend a registered App installation using that App's own key.", parametersSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: false } },
  ],
};

export default manifest;
