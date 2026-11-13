# Agent recovery and work permissions

Agent recovery and work mutations use the same direct configuration decision as
agent resume: `agent_config:update` with `targetAgentId` and
`requiresChangeGrant: true`. An agent needs a matching `agents:configure` grant;
`agents:suggest-changes` alone is not a direct recovery grant. These routes do not
create consent requests or require an additional board handoff for an authorized
agent.

| POST endpoint | Target for configuration authority |
| --- | --- |
| `/api/agents/:id/lifecycle/retry` | The agent whose lifecycle operation is retried |
| `/api/agents/:id/clear-error` | The agent whose runtime error is cleared |
| `/api/agents/:id/runtime-state/reset-session` | The agent whose session state is reset |
| `/api/agents/:id/wakeup` | The agent being woken, when different from the caller |
| `/api/agents/:id/heartbeat/invoke` | The agent being invoked, when different from the caller |
| `/api/heartbeat-runs/:runId/cancel` | The agent named by the saved run, not a request-body agent ID |

Agent callers must satisfy both the existing
[configuration grant scope](agent-configure-permissions.md) and the strict
reporting-subtree check. Direct and transitive reports qualify; self, siblings,
managers and unrelated agents do not. The boundary follows current `reportsTo`
links, not who created or hired the target. Reparenting a worker out of the
lead's reporting subtree removes this authority. An explicitly unscoped grant
or a grant naming an outside target never overrides that boundary. Authority is
rechecked under the reporting-tree mutex at the durable write. No grants are
backfilled or widened.

Board callers retain their existing route-specific checks. Normal self-wake
remains available without a configuration grant. Session reset does not grant
access to the separately board-protected runtime-state or task-session listing
endpoints. Cross-company resource access remains denied.

## Recovery is not a bypass

- Lifecycle retry retains the lifecycle state machine and setup checks. It does
  not revive a terminated agent or clear independent lifecycle holds.
- Clear-error still requires an agent in `error` with a ready lifecycle and a
  valid reporting chain. It preserves run history and diagnostics.
- Session reset retains its optional `taskKey` selection and account-level
  runtime-state preservation.
- Wake and invoke retain normal execution, budget, reporting-chain, trace and
  admission gates. Permission to wake is not a promise that execution starts.
- Exact failed-run retry through a wake request's `failedRunId` is a separate
  board-only operation. It retains its saved task/chat/review authorization;
  lifecycle retry is not that operation.
- Run cancellation additionally requires access to the run's task. Configuration
  authority does not reveal or cancel an inaccessible private task's run.

Mutations record the authenticated actor in the activity log. A managing agent's
run cancellation is attributed to that agent, not to its responsible human. It
uses the existing `operator_interrupted` stop code so recovery does not immediately
fight the intentional stop. Board cancellation attribution is unchanged.

## Verification

[`agent-recovery-work-subtree-routes.test.ts`](../server/src/__tests__/agent-recovery-work-subtree-routes.test.ts)
uses real bearer authentication, the authorization evaluator, reporting links,
route services and embedded PostgreSQL. It checks direct and transitive workers,
outside targets, reparenting, suggestion-only denials, foreign companies, board
behavior, existing unscoped grants, state guards, actor attribution and persisted
state. Execution dispatch is deliberately fenced in this test: queued work is
proved, not a live provider invocation or production acceptance.
