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
event-idle deadline, defaulting to `max(600_000, longestConfiguredToolTimeoutMs +
60_000)`. The runner's longest configured Pi tool deadline is the 60-second
host callback maximum in `pi-bind-protocol.ts` and `extension/index.ts`, so the
default remains 10 minutes. Pi 1.5.2's native bash tool has **no default timeout**
and the runner sets none; its optional timeout is not a finite runner-configured
execution bound. Native tools therefore pause the silence deadline rather than
relying on an assumed bash limit. `PiRpcDriverOptions.turnIdleTimeoutMs` overrides
the silence budget (including short regression-test budgets); it must be a
positive integer within Node's timer range. Prompt acceptance retains its
separate deadline below.

Every native Pi event resets the deadline, including hidden thinking deltas,
tool updates, retries, and compaction progress. Any announced native execution
pauses it from `tool_execution_start` until the matching `tool_execution_end`.
All outstanding tool IDs count, including nested IDs and tools that produce no
progress at all. Only the last matching end can start a fresh silence budget;
an unknown end cannot release another tool's execution. An admitted host callback
also pauses the timer until result, rejection, or cancellation, independently of
native execution. A callback result or cancellation does not substitute for Pi's
native execution-end event. Merely opening a socket or waiting for an unannounced
call is not host activity.

Expiry belongs only to the captured turn: send Pi `abort` and wait up to five
seconds for native `agent_settled`, independently of the abort acknowledgment.
Late successful-looking output cannot change the timeout into completion, and
next-turn admission waits behind this recovery. The terminal error remains
`pi_turn_idle_timeout`, with `recoverable: false` meaning the expired input is not
automatically replayed, **not** that the conversation is retired. If abort
settles, the same `HarnessSession`, child process, provider session ID and
`--session` file remain usable. Managed-provider turns revoke the old capability
and rebind normally for the next input; there is no session-level failure.

Only an abort that fails to settle (or uncertain cleanup) physically retires Pi
through the existing Stop cleanup path. Retirement does not delete its session
file. The next open with the same normalized session ID uses that same file;
the facade retains the actual normalized ID after an idle timeout even without
`PAPERCLIP_NORMALIZED_SESSION_ID`. Explicit thread close clears that fallback.
Settlement, Stop, and close cancel the timer; an idle warm session has no
active-turn deadline and does not poll.

Regression checks live in `pi-rpc-idle.test.ts` (silent streams, nested silent
tools, progress, hidden activity, bounded abort and same-session reuse),
`pi-rpc-prompt.test.ts` (real subprocess pipes, same-PID reuse and facade
same-file reopen after an unresponsive abort), and `pi-rpc-c2-live.test.ts`
(actual Unix callbacks and managed-provider rebind after timeout).
`pi-rpc-idle-native.test.ts`, enabled with `PI_TEST_BINARY`, additionally drives
the actual Pi 1.5.2 process against local SSE inference: a silent inference
aborts without replacing Pi, and a real silent `sleep 1` native bash call runs
longer than its 200 ms silence budget. Both cases complete the next turn on
the same PID/session. These local checks do not qualify a live provider
deployment.

## Typed compaction and failed items

Native `compaction_start`/`compaction_end` receipts share a canonical
`contextCompaction` item's start/completion identity. Only a successful end emits
`context.compacted`, with Pi's available pre/post token counts and a distinct ID
for each compaction, even when one turn compacts repeatedly. An aborted compaction
does not claim success. The proxy carries successful compaction through the
existing `thread/compacted` facade notification; Pi-specific Rust normalization
retains its measurements and identity without changing Codex's defaults.

A native compaction `errorMessage` becomes a bounded, redacted warning item
(`pi_compaction_failed`), not a turn failure. Likewise, `item.failed` crosses both
the proxy and Rust normalization as an item failure, never a turn terminal. Pi's
`agent_settled` remains the turn-settlement authority. Summarization accounting
stays explicitly incomplete; these display receipts do not establish billing.

`pi-event-projector.test.ts`, `pi-recordings.test.ts`,
`pi-rpc-app-server-proxy.test.ts`, and the Rust `provider_events` tests cover these
boundaries, including the captured Pi 1.5.2 compaction recording. They do not
qualify a live provider deployment.

## Missing saved conversations

A cold `thread/resume` whose saved Pi JSONL file is absent returns JSON-RPC
`error.data.code = "pi_session_file_missing"`; it never reports a newly minted
native thread as a successful resume. Runnerd recognizes only that typed
rejection and explicitly sends `thread/start` with the same server-owned
normalized conversation ID. It records the old and new native session IDs in
`piNativeAdmission.sessionRecovery` on the ordinary session identity receipt.
Live model/thinking admission remains mandatory. The facade's cold recovery
settles the unused bootstrap binding over the existing authenticated `settle` channel and
revokes its broker before exposing the session. The current run then binds and
admits normally; prepared-binding ownership checks are not relaxed. The shared
facade accepts changed native IDs only for the exact Pi receipt, same normalized
conversation, and an idle checkpoint without pending runtime requests or an
active goal. It drops the old native-turn bookkeeping, never replays an
uncertain input, and leaves Codex's exact-identity checks unchanged. An existing
but invalid file, an untyped error, a timeout, or an unexplained identity
mismatch still fails closed; this fallback does not repair or overwrite an
invalid transcript.

The server projects the receipt into one warning in the issue thread:
“My earlier conversation could not be restored: the saved Pi conversation file
is missing on this computer. Starting a new one.” Conversation selection keeps
the normalized ID and generation. The new Pi thread has no old private history;
subsequent turns continue its new history normally. Projection is serialized
under the issue/run/task locks and deduplicated by conversation and previous
native session, including replay after an interrupted projection and later warm
identity events. This does not claim restored history or process continuity.

The full-server continuing-turns lifecycle test deletes the file after closing
the settled resident through the controller-restart boundary. It checks a new
runner/Pi, a successful fresh second turn, the unchanged conversation ID, exactly
one visible notice, and private-history continuity on the third turn. The
runnerd recovery integration separately covers real SIGKILL recovery with an
intact file on local and split-filesystem layouts. These credential-free local
checks are not separate-host, deployed, or daily-work qualification.

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
