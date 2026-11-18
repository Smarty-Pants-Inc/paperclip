# Agent-owned GitHub shell credentials

Self-hosted agents can explicitly select their own GitHub token for shell `gh`
and HTTPS `git` operations, including plugin/sandbox Runner environments:

```json
{
  "adapterConfig": {
    "githubAuthenticationMode": "agent_env",
    "env": {
      "GH_TOKEN": { "type": "secret_ref", "secretId": "<agent-token-secret-id>", "version": "latest" }
    }
  }
}
```

Bind the secret to this agent through the normal secret-binding mechanism. Use
`GH_TOKEN` or `GITHUB_TOKEN`; if both resolve to nonempty values, `GH_TOKEN` wins
and supplies both CLIs. Normal company/agent authorization, missing-binding checks,
and low-trust restrictions still apply. Values are never logged or written to a
Git config file; Git's host-scoped helper reads the token from its environment.

This is an agent-level opt-in. Issue overrides, project/routine/environment env,
company-secret name lookup, server env, sandbox image logins, and managed GitHub
connections are not fallback credential sources in this mode. The shell path
never selects a managed identity or mints a broker capability. GitHub connector
**tools** retain their own independent connection policy.

With no agent token, execution continues without GitHub credentials and records
a `github.agent_env_token_missing` warning. Bind the token to enable authenticated
operations. Token expiry/rotation remains the operator's responsibility.

Omit `githubAuthenticationMode` to retain existing behavior: managed executions
strip configured GitHub tokens and use managed connections; eligible local/SSH
executions may use their existing host credentials. The only accepted explicit
value is `agent_env`; the API rejects other values. To return to default behavior,
remove the field (use adapter-config replacement when necessary).
