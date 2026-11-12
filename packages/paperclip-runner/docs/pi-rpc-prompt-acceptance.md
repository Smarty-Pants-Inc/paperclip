# Pi RPC prompt acceptance

Pi's command response reports acceptance, not model completion. The runner reads
session events continuously, including while the prompt response is outstanding.
See the [Pi 1.5.2 RPC lifecycle](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc.md#run-lifecycle).

## Prompt dispositions

- `started`: Pi accepted this input to start work. Wait for the captured run's
  `agent_settled`, not merely `agent_end`.
- `queued`: Pi accepted the input into its run queue. Keep the host turn active
  through the corresponding lifecycle and settlement; queuing is not rejection
  or completion. The driver does not add a steering or follow-up API.
- `handled`: An extension command or input handler consumed the input. Complete
  the host turn immediately with `outcome: "handled"` and `modelOutput: false`.
  Do not wait for `agent_settled`, fabricate assistant output or usage, or retire
  the resident session. Model work independently started by an extension does not
  belong to this turn, even if its events arrive before the prompt response.

The prompt response gates event ownership. For `handled`, unowned extension
activity is discarded until fresh idle admission before another prompt. A real
pre-acceptance error fails only its turn (`pi_prompt_rejected`); ordinary turn
finalization revokes any per-turn capability, and the resident child may rebind
for the next input. A cleanup failure or transport failure remains a separate
reason to retire the child.

See [Pi's prompt command contract](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc-commands.md#prompt).
Disposition, independent-extension ownership and same-resident reuse regressions
are in `pi-rpc-prompt.test.ts` and `pi-rpc-resident-binding.test.ts`.

## Late receipts and bounded identity history

Settlement releases the turn's projector, arguments, text and exact identity
map. An unfinished native tool remains a park blocker with only its captured
`runId`, `turnId` and tool name. Its matching final `tool_execution_end` can still
complete the original canonical display item, including while a handled prompt
is awaiting or has received its acknowledgment. This does not start an item,
report new usage, complete a new turn, announce tool execution, or restore any
host capability. Unknown extra identities and conflicting tool names remain
refused. The first matching terminal consumes the blocker; duplicates are dropped.

Retired identities use a fixed 1 MiB, four-hash tombstone filter rather than a
resident-lifetime map. It never forgets an inserted identity. Hash collisions
can conservatively suppress projection of a new identity; a filter match can
never select an owner or grant authority. The active exact identity budget
resets every turn. Genuine unresolved tool blockers are separately capped at
65,536; exceeding that bound fails closed instead of forgetting live work.
No settled projector or display body is retained for late receipts.

See [Pi's final tool receipt contract](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/json.md#tool-execution-events).
The original K4 before/after-ACK regressions and P0-4 warm-session/stale-callback
regressions run unchanged in `pi-rpc-driver.test.ts`. Its cross-run late-terminal
case also checks canonical item identity, duplicate suppression, mixed-owner
refusal and completion of the next prompt.

## Active-turn event-idle deadline

After Pi accepts a prompt (`started` or `queued`), the driver arms a one-shot
10-minute event-idle deadline. `PiRpcDriverOptions.turnIdleTimeoutMs` changes
that budget; it must be a positive integer within Node's timer range. Prompt
acceptance retains its separate deadline below.

Every native Pi event resets the deadline, including hidden thinking deltas,
tool updates, retries, and compaction progress. An admitted host tool callback
pauses the timer while its execution is in flight and starts a fresh budget on
result, rejection, or cancellation. Host execution keeps its own bounded callback
deadline; merely opening a socket or waiting for an unannounced call is not
activity. A long tool that emits updates does not time out. A silent native tool
with no host callback or native progress remains subject to the event-idle limit.

Expiry fails only the captured active turn with `pi_turn_idle_timeout` and
physically retires the Pi session through the existing Stop cleanup path. The
next input needs a fresh session. Settlement, Stop, and close cancel the timer;
an idle warm session has no active-turn deadline and does not poll.

Regression checks live in `pi-rpc-idle.test.ts` (silent streams, progress, hidden
activity and warm-run ownership) and `pi-rpc-c2-live.test.ts` (actual Unix callback
execution and Stop retirement). These hermetic checks do not qualify a live
provider deployment.

## Lost acknowledgments

`PiRpcTransport` gives commands a 30-second client response deadline. Set
`PiRpcTransportOptions.requestTimeoutMs` to change its default, or pass
`{ timeoutMs }` as the third `request` argument for a particular command.
`PiRpcDriverOptions.promptTimeoutMs` configures the prompt acceptance deadline
without changing startup admission or model execution time limits.

The deadline also covers a child that does not drain stdin. An expired request
is removed from the pending map; request IDs are never reused. A late response
cannot acknowledge another command. Matched responses, failures and process exit
cancel their timers and drain listeners.

Prompt acceptance is **unknown** after an ACK deadline. The runner never resends
that input. It makes one bounded `get_state` inspection, retaining the sole input
owner throughout. Only the already captured agent lifecycle plus a matching native
session reporting `isStreaming: true` can reconcile ongoing work. A captured turn
that already settled also needs no second run. Otherwise that turn fails with
`pi_prompt_deadline_exceeded` and `acceptance: "unknown"`, and its Pi child is
retired using normal bounded cleanup. The next turn must use a fresh session.
An idle snapshot does not prove rejection or authorize replay.

The inspection budget is the lesser of the startup budget (default five seconds)
and the prompt acceptance budget. Cleanup has its own bounded shutdown escalation;
these budgets are not additional permission to wait for an unanswered prompt.

Regression proof lives in `pi-rpc-prompt.test.ts` and `pi-rpc-transport.test.ts`:
real local subprocess pipes cover missing ACKs, unavailable or mismatched state,
reconciled streaming, fast settlement, stdin backpressure and late ACKs. These
hermetic failure-path checks do not qualify a live provider deployment.
