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
configure grants, including principal agents' grants, continue to work.

Configuration checks name the target agent. A subtree includes its root and
transitive reports through `reportsTo`, not siblings, managers or unrelated
principal agents. Existing `{ allow: ["subtree:<UUID>"] }` grants are also
supported by the same authorization evaluator. Instruction writes already pass
the target through the shared instruction authorization service. CEO writes to
`/agents/:id/permissions` also require target-scoped configuration authority,
even when the hiring permission is unchanged.

Default-grant reconciliation (startup and direct-create follow-up) inserts only
missing grants; it never replaces an existing scope. A missing root CEO's
configure grant is inserted with that CEO's subtree scope, not an unscoped grant.
Existing explicitly unscoped grants are preserved as well.

## Board-only grant updates

Use `PATCH /api/agents/:id/permission-grants`, for example:

```json
{"permissionKey":"agents:configure","enabled":true,"scope":{"subtreeRootAgentId":"<agent UUID>"}}
```

The optional `scope` accepts `subtreeRootAgentId` (UUID), nonempty `agentIds`
(UUIDs), and nonempty `allow` lists containing `subtree:<UUID>` or `agent:<UUID>`.
Unknown keys, malformed IDs, empty lists and an empty object are rejected.
Omitting `scope` preserves an existing row's scope; when adding a missing row it
retains the historical unscoped default. Explicit `scope: null` deliberately
replaces the scope with an unscoped grant. `enabled: false` revokes the row.
Read the persisted value in `GET /api/agents/:id` under `access.grants`.
Only board actors with the existing permission-management authority may write
these grants. The human-member permissions route does not manage agent grants.

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
