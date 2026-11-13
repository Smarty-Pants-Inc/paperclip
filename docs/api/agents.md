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

### Protected environment variables

A plugin environment driver can declare `protectedEnvironmentKeys`: variables
that it sets on its own tasks. Create, hire, update and configuration rollback
check `adapterConfig.env` against them:

- If the agent's environment (its `defaultEnvironmentId`, or the instance
  default when it has none) uses a driver that protects a key, the request
  fails with `422` and code `protected_environment_variable`. The response
  details name the `keys` and the `environmentId`.
- If another active environment protects the key, the save succeeds. The
  response includes `configurationWarnings` entries with code
  `protected_environment_variable`, a `field` such as `adapterConfig.env.KEY`,
  and a `message` that names those environments.

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

Agent callers need a direct `agents:configure` grant matching the target agent.
The same target-scoped decision governs lifecycle retry, session reset, waking
another agent and run cancellation; board checks and state preconditions remain.
See [Recovery and work permissions](../../doc/agent-recovery-work-permissions.md)
for the endpoints, subtree boundary and separate exact-run retry restriction.

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

## Stop a Run

```
POST /api/heartbeat-runs/{runId}/cancel
```

Board only. Stops a run that is running or still waiting in line (`queued`). The caller must be able to read the run, or the response is 404. The run and its wake are cancelled, the task's execution lock is released, and a `heartbeat.cancelled` activity entry is logged. Paperclip does not start another run for that task by itself. The agent's next waiting task starts as usual.

When the stopped run was still waiting in line, the task also returns from `in_progress` to `todo`, and an `issue.updated` activity entry is logged with the reason `stopped_while_waiting`. The task is left unchanged when any of these is true:

- The run had already started.
- The task is not `in_progress`.
- The task is no longer assigned to that agent, or it is assigned to a person.
- Another run holds the task's execution lock, or another run for the task is queued, running, or scheduled to retry.

Send an empty body. The optional `cancellationRequestId` is only for native runs; for any other run, the response is `409`.

## Assigned-Work Invariant Report

```
GET /api/companies/{companyId}/assigned-work-invariant
```

Board only. Read-only. Classifies every open task assigned to an agent (`todo`, `in_progress`, `blocked`): it has a live run, a pending intent that will start one, a named wait that is someone else's move, or it is a violation. Paperclip continues violations automatically; after a deploy, `violationCount` should return to 0.

The response contains:

- `checked`: the number of tasks classified, newest-updated first. At most 2,000.
- `openTasks`: the number of open agent-assigned tasks the caller may read. When it exceeds 2,000, `truncated` and `violationCountIsLowerBound` are `true`: the counts cover only the 2,000 newest tasks, so the real violation count can be higher, never lower.
- Only tasks the caller may read are counted; private tasks the caller cannot read are left out of every count and sample. On an instance with a worktree execution cutoff, the sweep skips tasks created before the cutoff, but the report still counts them.
- `ok`: counts by clause, for example `live_run`, `pending:queued_wake`, `waiting:question`.
- `violations` and `violationCount`: counts by reason (`no_pending_path`, `retry_offered`, `recovery_block`, `unknown_block`, `run_owner_gone`, `native_run_stalled`). `native_run_stalled` is a native run still marked running whose restart-recovery claim nobody renewed for 5 minutes; native recovery ends it, and it stays counted until then.
- `agentsWithStalledSlots`: up to 20 agents whose run slots are held by such stalled runs, with the number of stalled runs and of queued runs waiting behind them.
- `heldByRecoveryOwner`: violations that are blocked under an active recovery hold, which the hold's owner continues.
- `staleBlocked`: tasks blocked by recovery more than 7 days ago. They are reported, not continued.
- `settling`: tasks whose last run ended moments ago and are checked again shortly.
- `sample`: up to 20 violations with the task identifier, status and reason.

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

### Rename an instruction file

Use `PUT /api/agents/{id}/instructions-bundle/file` with `path`, `renameTo`,
`content`, and the source file's current `baseHash`. Use `null` only when the
configured root file is missing; a concurrently created root returns `409`. Renames require the same
instruction configuration permission as file writes. The managed file store
checks the source hash and destination under the agent write lock, then updates
the file and the configured root path together. A stale source or occupied
name returns `409`. External bundles must be migrated to managed storage before
using this operation. A successful response contains the renamed file detail.
