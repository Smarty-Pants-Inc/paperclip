# Pi RPC prompt acceptance

Pi's command response reports acceptance, not model completion. The runner reads
session events continuously, including while the prompt response is outstanding.
See the [Pi 1.5.2 RPC lifecycle](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/rpc.md#run-lifecycle).

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
