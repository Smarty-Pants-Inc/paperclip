# Concurrent issues for one native agent

Use `runtimeConfig.heartbeat.maxConcurrentRuns` to let one agent work on
independent issues concurrently. For example, retain the rest of the agent's
configuration and set:

```json
{
  "heartbeat": {
    "maxConcurrentRuns": 3
  }
}
```

This is a **runtimeConfig fragment**, not a replacement for the full runtime
configuration. Preserve AI-connection bindings, heartbeat flags and other
settings when saving through the ordinary agent configuration surface.

The current default is 20; the heartbeat policy floors and clamps the value to
1–50. A saved value of 1 still serializes the agent's active runs. The native
`openai_dot`, `grok_bot` and `muse` providers require a cap of 1. Native Codex,
OpenCode and Pi RPC use the configured cap.

The queue counts running rows, claims available slots, and dispatches each run
without waiting for the other runs to finish. Its per-agent start lock protects
claim/start, not the lifetime of a turn. Wake coalescing and persisted task
sessions are task-scoped, so a message on issue B does not join issue A's
conversation merely because their assignee is the same agent.

## Sessions and workspaces are separate limits

A native session scope includes company, agent, workspace, provider and
normalized session identity. Independent issues normally have separate task
sessions and session-owned Runner/provider processes. Sequential warm turns of
one issue reuse that issue's session; concurrent issues are not simultaneous
turns on one Pi process.

The cap does **not** override physical workspace ownership. Local and SSH
folders can be shared, with the usual concurrent-mutation risks. Sandbox and
plugin shared workspaces serialize by default. Setting their shared-workspace
policy to `allow` does not enable physical sharing: it rejects unsupported
sharing. A fixed sandbox ingress also permits only one active session owner.
Use the existing task-owned isolated workspace/allocation path instead of
removing these guards. See [issue workspaces](experimental/issue-worktree-support.md).

The cap bounds **active runs**, not the total number of parked warm processes.
An idle timeout governs retention separately (the current default is 5 minutes).
A new issue's first turn remains cold even when another issue of the same agent
is warm. Remote warm reuse also requires a reusable sandbox lease and compatible
managed-AI routing; an explicit cap does not change those lifecycle checks.

## Prove the real chat path

Use a clone of the actual daily-work organization and the candidate build;
record the exact revision, saved configuration and workspace/allocation IDs.
Do not use the deterministic server test as evidence of sandbox or Pi latency.

1. Read and save the existing agent configuration, set only the nested cap to
   3, and read it back. If it was already at least 3, diagnose the observed wait
   before attributing it to the cap.
2. Warm A and B independently through ordinary chat, awaiting terminal commit
   and warm release. Record distinct session IDs, Runner IDs and Pi PIDs;
   verify task-owned sandbox allocations and an unexpired warm idle deadline.
3. Start bounded real work on A and wait for meaningful native activity. While
   A remains running, send the ordinary chat message on B through the product
   composer/comment route, capturing acceptance and first committed activity.
4. Open B's `run.performance.span` rows: `comment.to_run_created` (accepted
   comment to run creation), `heartbeat.queue` (run creation to run start), `task.prepare`,
   `environment.startup`, `native.coordinator.claim`, `runner.session.startup`,
   `runner.session.resume`, `runner.turn.submit`,
   `runner.turn.submitted_to_started`, and
   `provider.time_to_first_agent_event`. A bootstrap, workspace-busy retry, or
   supervisor-busy refusal is not warm success.
5. Use `task.time_to_first_agent_activity` for accepted input to first durable
   reasoning/text/tool activity, checking its anchor against message
   acceptance. `turn.started`, usage and empty deltas are not the milestone.
   Report total latency as well as pre-provider overhead. Require overhead
   below 3000 ms without summing overlapping cumulative spans; if the gate is
   total first activity, require that cumulative duration below 3000 ms too.
6. Fill C as the third independent active issue and verify D remains queued
   until a slot frees. Preserve trace/event evidence showing A was still busy
   when B responded and the active count never exceeded 3. Finish owned work
   and restore temporary settings with read-back.

For an API reproduction, use the same authenticated board user that owns B's
existing conversation. Send `POST /api/issues/<B>/comments` with a fresh UUID in
`clientRequestId` and a unique `body`, for example
`{"clientRequestId":"<new UUID>","body":"CONCURRENCY-B <nonce>: reply with B <nonce> only."}`.
Do not use the direct agent wake endpoint instead of this chat path. Read the
resulting run from `GET /api/companies/<company>/heartbeat-runs` and retain its
`GET /api/heartbeat-runs/<run>/events` and `/log` responses. If reproducing A needs
a bounded nonmutating hold, ask A to announce `A_STARTED <nonce>`, execute one
`sleep 90` terminal tool call, then announce completion; verify the tool is
actually running before sending B. Prefer the original bounded daily-work task
when available.

The <3000 ms threshold above is this reproduction's explicit gate, not an
existing Pi automatic speed budget. The current native speed-budget adapter map
does not include Pi. Absence of `run.performance.budget_exceeded` proves nothing
about Pi latency. Do not subtract provider time without trustworthy, aligned
intervals; if those are absent, report raw first activity and mark the
overhead-only claim unqualified.

See [native timing](observability.md#native-runner-trace-spans) for span semantics.
The focused `server/src/__tests__/heartbeat-pi-rpc-concurrency.test.ts` exercises
real PostgreSQL, wake admission and native dispatch with a held deterministic
backend: B waits at cap 1, starts alongside A at cap 3, D waits at capacity,
and a released slot dispatches D. It does not launch Pi or qualify a live
sandbox, browser, model connection or responsiveness budget.
