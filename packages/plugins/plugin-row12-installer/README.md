# Row-12 enterprise GitHub App installer (phase 1)

This plugin adds primary-only tools for registered GitHub Apps on the enterprise-owned organization `Smarty-Pants-Inc`. Tests use an ephemeral fake GitHub bound to `127.0.0.1`; there is no deploy, real key, or live GitHub setup.

## Security boundaries

- Only the fixed primary Smarty agent ID in `src/plugin.ts` can invoke tools. Paperclip supplies `agentId`, `runId`, `companyId`, and `projectId` in `ToolRunContext`; the caller cannot supply those values.
- App IDs, client IDs, enterprise slug, repository-ID allowlists, manager installation ID, and anchor project ID come from server-side company plugin config. The manager PEM is not part of this config.
- `PluginInstanceSecretManagerKeySource` accepts only the active, empty project named `github-manager-key` with no lead agent, then reads the fixed `manager_private_key` project instance secret through `ctx.projects.getInstanceSecrets`.
- Install requests always send `repository_selection: "selected"`. Repositories are resolved to stable GitHub IDs and must be in the per-App primary-ratified `approvedRepositoryIds` list. Denied names are rejected before a GitHub mutation.
- `github_app_suspend` and `github_app_unsuspend` are registered-App-only and use that App's own configured `privateKeyRef` to sign an App JWT. The manager key is not used for either call. Only the dedicated unsuspend method can send `DELETE`, and it sends only `/app/installations/{id}/suspended`.
- Repository `remove[]` remains refused. GitHub documents the enterprise repository-removal endpoint as `PATCH .../repositories/remove`; this plugin defers it rather than adding another mutation path. See [GitHub's organization-installations REST docs](https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/organization-installations#remove-repository-access-from-an-organization-installation).
- Every tool attempts a safe intent activity row before GitHub and writes an outcome row. If the intent write fails, no GitHub call is made. The activity RPC and external GitHub effect are separate operations, not one transaction. If an outcome write fails after a successful GitHub result, the tool returns the App, installation, repository names/stable IDs, HTTP status, and a do-not-retry instruction.
- The tool does not create inbox items. Install results include a low-stock flag and deterministic deduplication key for the caller-side helper.

## Configuration shape

Use only server-held configuration. Do not add a `managerPrivateKey` field. Each registered App may have a private-key secret reference used only by its suspend/unsuspend calls:

```json
{
  "enterpriseSlug": "<enterprise-slug>",
  "allowedOrg": "Smarty-Pants-Inc",
  "managerAppId": "<manager-app-id>",
  "managerInstallationId": "<manager-enterprise-installation-id>",
  "managerKeyAnchorProjectId": "<github-manager-key-project-id>",
  "allowedCallerAgentIds": ["29b216c4-76bc-41a3-a71a-88d30737b688"],
  "deniedRepos": ["tristar-org", "secrets", "<client-repository>"],
  "registeredApps": [
    {
      "slug": "<registered-slug>",
      "appId": "<registered-app-id>",
      "clientId": "<registered-client-id>",
      "installationId": "<existing-installation-id-if-known>",
      "privateKeyRef": { "type": "secret_ref", "secretId": "<app-key-secret-id>" },
      "approvedRepositoryIds": [123456]
    }
  ]
}
```

The manager key's first-value/write action is not implemented. The SDK exposes project read and instance-secret read, but no plugin call to synchronously trigger a project lifecycle event. Do not provision a real key until that gate and the separate non-exportability gate are resolved.

## Local checks

```bash
corepack pnpm --filter @paperclipai/plugin-row12-installer test
corepack pnpm --filter @paperclipai/plugin-row12-installer typecheck
corepack pnpm --filter @paperclipai/plugin-row12-installer build
```

The suite tests successful/failed installs, refusals, audit failures, exact suspend/unsuspend calls, and the anchor's fail-closed checks. It does not call GitHub or change any external state.
