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
remain forbidden even with a legacy unscoped grant or a grant naming that agent.
Existing self-service assignments and board authority are unchanged. Connection
and profile management grants, responsible-user authority, private-connection
access and interaction restrictions still apply; a suggestion grant is not a
substitute for direct configuration authority.

`PUT /api/tool-connections/:connectionId/installs` replaces the complete install
set, but authorizes only additions and removals. Retained targets need not be in
the caller's scope. Binding a profile changes only the named recipient, not its
existing recipients or the consumers of its referenced connections. Editing a
shared connection or profile still authorizes its affected consumers as before.
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

## Descendant budgets and instruction paths

Both `PATCH /agents/:id/budgets` and a `budgetMonthlyCents` field in
`PATCH /agents/:id` accept the same direct descendant-management authority.
The new amount must be positive and no greater than the caller's remaining
monthly billed budget. The budget engine's exact ledger, live exposure and held
reservations count toward that remaining amount. A saved active monthly policy
takes precedence over the legacy amount. A caller without a finite positive
allowance cannot delegate a budget. Zero disables enforcement, so agents cannot
use zero as a delegated allowance. Board budget behavior is unchanged. These
are bounded budget settings, not a transfer/reservation of money between agents.
Self-budget fields are rejected even when they echo the current amount.

`PATCH /agents/:id/instructions-path` uses the same direct descendant check.
Agents may set only known instruction-path keys (`instructionsFilePath` and
`agentsMdPath`), never use the path endpoint to change a host command or another
adapter field. The existing external-filesystem instance-admin restriction stays
in place: agents can point to managed instruction files, not arbitrary host
paths. Board behavior and generic adapter-config protections are unchanged.
API-key management, company budgets and budget-policy/incident administration
are not delegated by these changes.

## Concurrent reporting-tree changes

Descendant budget, permission, instruction-path and lifecycle writes recheck
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
