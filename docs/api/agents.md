---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Read execution environment identity

Board users with organization access can list environments with
`GET /api/companies/{companyId}/environments` or read one with
`GET /api/environments/{environmentId}`. These routes read instance environments.
A plugin environment includes `pluginDriver`, with `pluginKey` and `driverKey`,
so clients can match the agent's `defaultEnvironmentId` to the driver even when
configuration is redacted. This field does not contain driver configuration,
environment variables, or credentials. An agent with no default inherits the
instance default.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "cto" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Set a Descendant Agent's Budget

```
PATCH /api/agents/{agentId}/budgets
{"budgetMonthlyCents": 10000}
```

An agent caller needs direct, target-scoped `agents:configure` authority over
a strict reporting descendant. The positive amount cannot exceed the caller's
remaining monthly billed budget, including live exposure and held reservations.
The same rules apply to `budgetMonthlyCents` in the agent PATCH above. Agents
cannot edit their own budget or disable a budget with zero. Board behavior is
unchanged.

## Edit a Descendant Agent's Permissions

```
PATCH /api/agents/{agentId}/permission-grants
{
  "permissionKey": "agents:configure",
  "enabled": true,
  "scope": {"subtreeRootAgentId": "{agentId}"}
}
```

A non-CEO agent may manage a strict reporting descendant with direct,
target-scoped configuration authority. It cannot grant a permission it does not
hold, delegate outside its own subtree, widen its grant, or edit its own grants.
An omitted scope defaults a new grant to the target's subtree; a saved scope is
preserved only if it remains within the caller's authority. `enabled: false`
revokes a descendant's grant. Board permission-management authority is unchanged.

The legacy `PATCH /api/agents/{agentId}/permissions` endpoint accepts the same
strict descendant authority. Enabling hiring, skills or assignment requires
that authority on the caller; implicit assignment grants remain subtree-scoped.
Trust presets and authorization-policy edits remain board-only.

## Set a Descendant Agent's Instructions Path

```
PATCH /api/agents/{agentId}/instructions-path
{"path": "{managed-instructions-root}/AGENTS.md"}
```

Agents need the same direct descendant configuration authority. Only known
instruction-path adapter keys are editable. Adapters without a default key can
specify `adapterConfigKey: "instructionsFilePath"`. The existing instance-admin
requirement for external host paths remains in effect. This does not permit
host command edits through an arbitrary `adapterConfigKey`.

The reporting subtree follows current `reportsTo` links, not creation history.
Self, outside-subtree and reparented-away administrative targets return `403`;
cross-company targets retain the existing access boundary. These operations
record the agent as the activity actor. See [grant scopes](../../doc/agent-configure-permissions.md)
for supported scope narrowing and the limits on these administrative writes.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Clear Agent Error

```
POST /api/agents/{agentId}/clear-error
```

Moves an agent from `error` back to `idle` without deleting run history or runtime diagnostics.
Only agents currently in `error` can be cleared.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
