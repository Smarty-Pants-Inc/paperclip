# Agent configuration grant scopes

New standard agents receive `agents:configure` and `agents:suggest-changes`
with `scope: { subtreeRootAgentId: "<new agent UUID>" }`. This applies at
activation to direct creates, hires (including board-approved hires), and
invitation defaults. Both grants use the same boundary so consent cannot turn
a new agent's suggestion grant into company-wide configuration authority.
Low-trust and built-in agents retain their existing restricted defaults.

The default is independent of the creator: board-created agents should not
silently receive broader authority than agent-created hires. Board users retain
their existing configuration authority and can explicitly grant broader access.
Existing principal grants are **not migrated or backfilled**; existing unscoped
configure grants, including principal agents' grants, continue to work for
configuration. Agent lifecycle, recovery and cross-agent work controls additionally
require a strict reporting descendant; an unscoped or target-naming grant cannot
extend those controls outside the caller's current subtree.

Configuration checks name the target agent. A subtree includes its root and
transitive reports through `reportsTo`, not siblings, managers or unrelated
principal agents. Existing `{ allow: ["subtree:<UUID>"] }` grants are also
supported by the same authorization evaluator. Instruction writes already pass
the target through the shared instruction authorization service. Agent writes to
`/agents/:id/permissions` require direct target-scoped configuration authority
and a strict descendant target, even when the hiring permission is unchanged.
The caller need not be CEO.

Default-grant reconciliation (startup and direct-create follow-up) inserts only
missing grants; it never replaces an existing scope. A missing root CEO's
configure grant is inserted with that CEO's subtree scope, not an unscoped grant.
Existing explicitly unscoped grants are preserved as well.

## Tool assignments to reports

An agent can install a connection or bind/unbind a tool profile for its current
strict reporting descendants with direct, target-scoped `agents:configure`.
This includes a just-hired direct report and indirect reports; no grant snapshot
or hire-time expansion is needed. Peers, managers and other reporting subtrees
remain forbidden for all agents, including roots and CEOs, even with a legacy
unscoped grant or a grant naming that agent. Neither changing `reportsTo` to
`null` nor changing an agent's role grants cross-root tool authority. Cross-root
assignments use the existing board path with its configuration and management
checks. Existing self-service assignments and board authority are unchanged. Connection
and profile management grants, responsible-user authority, private-connection
access and interaction restrictions still apply; a suggestion grant is not a
substitute for direct configuration authority.

`PUT /api/tool-connections/:connectionId/installs` replaces the complete install
set. Agent requests authorize only additions and removals. Retained targets need
not be in the agent's scope. Binding a profile changes only the named recipient, not its
existing recipients or the consumers of its referenced connections. Editing a
shared connection or profile still authorizes its affected consumers as before.
Agent install PUTs never clean up a shared app profile's legacy connection-wide
include, even for an unchanged install list. Board and trusted internal writes
retain that cleanup; board PUTs retain full install-consumer authorization.
The writers recheck the current target/delta under the company reporting-tree
lock; moving an intermediate manager revokes descendant authority atomically.

## Grant updates

Use `PATCH /api/agents/:id/permission-grants`, for example:

```json
{"permissionKey":"agents:configure","enabled":true,"scope":{"subtreeRootAgentId":"<agent UUID>"}}
```

The optional `scope` accepts `subtreeRootAgentId` (UUID), nonempty `agentIds`
(UUIDs), and nonempty `allow` lists containing `subtree:<UUID>` or `agent:<UUID>`.
Unknown keys, malformed IDs, empty lists and an empty object are rejected.
For board callers, omitting `scope` preserves an existing row's scope; when
adding a missing row it retains the historical unscoped default. Explicit
`scope: null` deliberately replaces the scope with an unscoped grant.
`enabled: false` revokes the row. Read the persisted value in
`GET /api/agents/:id` under `access.grants`. Board actors retain their existing
permission-management authority. The human-member permissions route does not
manage agent grants.

An agent with direct target-scoped `agents:configure` can edit a strict
reporting descendant's grants. It cannot edit itself, a sibling, an ancestor,
or an unrelated agent, even with a legacy unscoped configure grant. A later
`reportsTo` change takes effect on the next request. A suggestion grant or
accepted consent alone is not enough for this administrative operation.

The caller must hold the permission being enabled. Delegation must fit both
its existing grant and its current subtree; it cannot issue an unscoped grant.
For a missing grant, omitted scope defaults to the target's subtree. For an
existing grant, omission preserves its scope only when that scope is still
within the caller's authority. Explicit subtree-only source scopes can be
narrowed to contained subtrees or individual agents. Finite agent sets can be
narrowed to finite sets, not expanded into subtrees. Compound source constraints
that cannot be safely narrowed require a board editor rather than silently
dropping constraints. Revocation requires management authority over the target
but does not require holding the revoked permission.

The legacy `/permissions` endpoint also requires held hiring/skill authority
for enabling those settings and a held, contained `tasks:assign` grant whenever
it enables assignment. Assignment grant writes are scoped to the target's
subtree. Trust presets and authorization-policy administration stay board-only.
Agent administrative mutations are attributed to the agent in the activity log.

## Runner report environments

The company-scoped `agents:configure-reports-runtime` grant permits an agent to
PATCH plain environment values and company `secret_ref` bindings on existing
`paperclip_runner` reports. It is on by default for standard agents, and is
independently revocable through the existing permission-grants API. Revoking it
for the company's agents switches this exception off; grant removal is not
reconciled back on. It never substitutes for direct `agents:configure` authority
and the current strict reporting-subtree check: self, peers and unrelated agents
keep the existing refusal. Both decisions are rechecked under the writer's
company reporting-tree lock.

To revoke **one hire's** runtime capability, its manager uses the existing
`PATCH /api/agents/:id/permission-grants` route, with the hire's UUID as `:id`:

```http
PATCH /api/agents/11111111-1111-4111-8111-111111111111/permission-grants
Content-Type: application/json

{"permissionKey":"agents:configure-reports-runtime","enabled":false}
```

Use the manager's normal authenticated request context. The hire must be a
current strict reporting descendant (direct or indirect) over which the manager
has direct, target-scoped `agents:configure` authority. Revocation does not
require the manager to hold `agents:configure-reports-runtime` itself. It removes
the hire's ability to use this exception on **its own reports**; it does not
remove the manager's grant or block the manager from configuring the hire.
Read back `GET /api/agents/:id` under `access.grants` to confirm the removal.

Implementation: [route and manager/board authorization](../server/src/routes/agent-permission-grants.ts#L16-L50)
(`server/src/routes/agent-permission-grants.ts:16`),
[strict descendant and direct configuration checks](../server/src/services/agent-subtree-management.ts#L13-L28)
(`server/src/services/agent-subtree-management.ts:13`), and
[single-agent grant deletion](../server/src/routes/agent-permission-grants.ts#L74-L80)
(`server/src/routes/agent-permission-grants.ts:74`). The existing
[grant-update instructions](#grant-updates) document `enabled: false` revocation.

For the organization to turn this off for **all agents**, a board user with
`users:manage_permissions` sends the same route and body once per agent,
including primary agents and managers. The local implicit board actor retains
its existing permission-management path. The route accepts one target agent
UUID, not a bulk target; no separate bulk revoke path or company setting is
provided. Revoking it for every agent in the company is the company-wide off.
An agent manager cannot perform the all-agent operation across roots or on
itself; use the board permission-management path cited above. **New standard
hires get the grant by default**, even after the current roster's grants are
revoked, so revoke each new hire's grant too to maintain the company-wide off.
Existing revocations survive ordinary updates, startup and normal migration
reruns; manually replaying a one-time backfill SQL file is not the revoke path.

A referenced secret must also pass the caller's existing own-run secret binding
and version admission; a run-bound caller additionally needs a currently running
run and a direct or inherited runtime-manifest binding. A refusal names the
secret ID, never its value. **Secrets go in as `secret_ref`, never as a plain
value.** Plain values are stored unencrypted and read back redacted; send known
values rather than copying redacted GET placeholders back into a PATCH.

This exception does not open creation, hiring, rollback, `*_local` environment
settings, or host execution keys (`command`, `hermesCommand`, `args`, `extraArgs`,
`cwd`, `filesystemSandboxCommand`). Existing narrow provider-credential paths
remain unchanged. The Pi runner retains ownership of its `--session` and
`--mode` arguments; `PAPERCLIP_PI_RUNTIME_DIR` is not an eligible configured env
key. Retire a report through the existing pause, then terminate routes, not DELETE.

## Descendant budgets and instruction paths

Both `PATCH /agents/:id/budgets` and a `budgetMonthlyCents` field in
`PATCH /agents/:id` accept the same direct descendant-management authority.
The new amount may be any nonnegative integer, including zero (unlimited for
that scope). It is not capped by the caller's remaining allowance: setting a
policy does not spend or transfer money. Company budget enforcement remains
the overall cap. The `POST /companies/:companyId/budgets/policies` agent-scope
alias follows the same rule. Self-budget fields are rejected even when they
echo the current amount.

The policy POST also accepts project budgets when `project.leadAgentId` is the
caller or a current strict reporting descendant it can directly configure. An
unrelated project's policy stays forbidden. Both company-budget aliases (the
policy POST and `PATCH /companies/:companyId/budgets`) admit only a primary
agent: `reportsTo` is null, irrespective of role or title. Other agents are
refused. Send `principalRequestUrl` with the task/comment link for the principal's
ask. The existing `budget.policy_upserted` activity details retain that link;
without one the change still succeeds and records `no principal request linked`.
Budget incidents remain board-only. Board behavior is unchanged.

`PATCH /agents/:id/instructions-path` uses the same direct descendant check.
Agents may set only known instruction-path keys (`instructionsFilePath` and
`agentsMdPath`), never use the path endpoint to change a host command or another
adapter field. The existing external-filesystem instance-admin restriction stays
in place: agents can point to managed instruction files, not arbitrary host
paths. Board behavior and generic adapter-config protections are unchanged.
API-key management and budget-incident administration remain board-only.

## Concurrent reporting-tree changes

Runner report environment, budget policy, descendant permission, instruction-path and lifecycle writes recheck
management authority inside their writer transaction, after acquiring the same
company-row accounting lock as `reportsTo` updates. Moving an intermediate
manager therefore cannot race a stale descendant check. The lock order is
company, then target/task/run rows. Board behavior remains unchanged. Agent
lifecycle authority requires a strict reporting descendant even with an explicitly
unscoped legacy grant or a grant naming an outside target.

Managed wakes and run cancellation use that boundary when saving their durable
wake receipt or Stop intent. Execution/provider cleanup may finish after a later
reparent; that completes the already-accepted request, not a new grant of access.
Self-wake remains separate from cross-agent lifecycle management.

An agent cannot terminate a pending hire through either `POST /terminate` or
`PATCH /agents/:id` with `status: "terminated"`: hire rejection is a board
approval decision, whose decider schema currently records only a user ID. Both
entry points return 403 and leave approval and hire unchanged; the pending state
is checked again inside the company-locked lifecycle writer. A board user can still reject the
hire, recording that user's ID. Approved hires retain delegated lifecycle control.

## Named follow-up: target-manager consent-card eligibility

This minimal grant fix does **not** establish or test that only the target
agent's manager chain or a board user may accept its configuration consent
card. That restriction belongs in interaction creation/resolution governance
(including legacy target keys and already-open cards), not just grant matching.
Track it separately with real card accept/reject tests for the target's direct
and transitive managers, board users, self, siblings and unrelated agents.

This also does not scope hiring authority or narrow existing unscoped
suggest-changes grants. A legacy agent with that suggestion grant can still
apply a protected change after accepted consent. Newly scoped suggestion
grants remain denied outside their subtree even with accepted consent.
