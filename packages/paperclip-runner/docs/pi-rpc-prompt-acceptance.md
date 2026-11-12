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
