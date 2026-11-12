# Native Pi RPC recordings

These are **real Pi RPC process outputs** from the pinned npm dependency, talking to a local controlled OpenAI-compatible SSE peer. The peer supplies model responses; Pi itself emits the RPC events, runs Bash, invokes the installed extension tool and performs retry/compaction. This is not a live-provider or production-organization run.

- Legacy `real-1.5.1*`: preserved from the prior slice; no rewriting or relabeling.
- `*-1.5.2.jsonl`: exact stdout JSONL from `@earendil-works/pi-coding-agent@1.5.2`.
- `.commands.jsonl`: exact stdin RPC commands, including unsupported `high`, queued steer/follow-up and fence cancellation.
- `.requests.json`: local HTTP-peer request summaries (not secrets or full user messages).
- `.provenance.json`: runtime version, CLI/capture SHA256, scenario, child exit, model-request count. All eight exit normally with code 0.
- `.normalized.json`: deterministic replay through the checked-in **current projector**, not hand-authored expected provider events. Each record now includes its explicit replay-driver `runId` and `turnId`; the captured wire, commands, requests and provenance are unchanged.

## Driver-owned attribution (C3)

`createPiEventProjector({ runId, turnId, includeThinking? })` requires the
Runner driver's admitted origin. It copies both IDs at creation and returns
that origin on **every** record, including diagnostics, compaction and usage.
Missing, empty, non-string or over-240-character IDs are refused by name. There
is no current-run default and native payload fields cannot override ownership.

Keep one projector per admitted Runner turn. Retain that projector in delayed
event callbacks after the turn settles; do not dispatch old callbacks through
the next turn's projector. Persist/envelope the returned `runId` and `turnId`
without replacing them with mutable current-driver context. Usage receipt
identity, deduplication and totals remain local to the originating projector.
The projector cannot infer an old turn from an unlabelled native event routed
to the wrong projector; event routing and terminal authority remain driver-owned.

`pi-event-attribution.test.ts` demonstrates red-before-green delayed text,
tool-result and usage delivery after next-turn admission (both same-run and
cross-run), including a driver reusing its mutable origin holder.
`pi-event-origin.test.ts` checks every output family, native spoofing, output
mutation, diagnostic suppression and invalid origins. The recording replay
helper uses explicit fixture-driver origins, not arrival-time stamping. Its
fenced diagnostic uses the fixture journal's `turn-0`, not a prompt grant.
These are helper/PRP-boundary checks, not proof of installed driver routing.

Scenarios: baseline text with U+2028 and emoji, real successful/failing Bash calls and streamed thinking opt-in; unsupported-thinking clamped to `off`; streaming abort; steer/follow-up queue; native HTTP-500 auto-retry; automatic threshold compaction with 4096-token context; unsolicited extension turn; installed `pi-subagents@0.88.0` **action:list** (no child launch).

The extension scenario permits a single already-starting HTTP request before clear_queue→abort and records that honestly. Output is fenced, but this is not proof of a production pre-inference authority/budget barrier. The production broker must deny absent Runner authority before forwarding inference.

## Dynamic callback burst regression

Pi 1.5.2 executes sibling tools in parallel by default (see the pinned runtime's
`docs/extensions.md`, **tool_call** and **Tool Definition / Execution mode**).
`src/drivers/pi/pi-rpc-callback-hol.test.ts` drives the actual Pi child and owned
extension through `PiRpcDriver`, using a loopback SSE peer that emits 130 ordinary
calls, then `paperclip_finish` either in the next response or last in the same
response. Each fake host round trip takes 200 ms. It asserts 131 successful
native results, no callback refusals, and finish within 10 seconds, and writes
requests, native records, the session and measured latencies when
`PI_HOL_PROOF_DIR` is set. This is a real-runtime protocol/load regression, not
production-organization or live-provider qualification.

The host callback server allows eight ordinary dispatches plus a separate slot
for `paperclip_finish` / `paperclip_block`. Controls retain the exact native
announcement, authority, once-only and cancellation gates. At most eight request
frames are read concurrently and 128 parsed calls wait for dispatch; additional
connected peers remain paused, applying stream backpressure rather than dropping
the ninth socket. This bounds buffered application work, not the number of
connected OS sockets. Close drains paused, queued and active peers.

Reading, announcement waiting and result writing are separately bounded. The
host-execution deadline starts only after dispatch admission and the native
announcement join; queue residence does not spend it. The existing extension
and private-request **60-second overall transport deadlines remain unchanged**;
this regression does not qualify batches whose total queue plus execution time
exceeds that outer bound. Priority applies once a control request has been read;
peers beyond the parsed/read budget wait for read capacity first.

From the Runner package, with `PI_TEST_BINARY` pointing to a Pi 1.5.2 CLI wrapper:

```bash
PI_TEST_BINARY=/absolute/path/to/pi-1.5.2 PI_HOL_PROOF_DIR=/absolute/path/to/evidence pnpm exec vitest run src/drivers/pi/pi-rpc-callback-hol.test.ts src/drivers/pi/pi-rpc-callback-server.test.ts
```

Without `PI_TEST_BINARY`, the real-runtime cases explicitly skip; the Unix-socket
server regressions still run. Those also cover queue residence longer than a
host deadline, independent announcement/execution budgets, control-slot priority,
a 300-call backpressured burst, queued cancellation and close.

## Reproduce (no provider credentials required)

From `packages/paperclip-runner`, with the repo's dependencies already installed and `tsx` available:

```bash
RUNTIME_DIR="$(mktemp -d)"
(cd "$RUNTIME_DIR" && npm init -y && npm install --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@1.5.2 pi-subagents@0.88.0)
PI_ENTRY="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
SUBAGENTS_ENTRY="$RUNTIME_DIR/node_modules/pi-subagents/index.js"
for s in baseline unsupported-thinking abort queue retry compaction extension subagent; do
  node test/capture-pi-rpc.mjs --pi-entry "$PI_ENTRY" --out "$RUNTIME_DIR/captures/$s" --scenario "$s" --subagents-entry "$SUBAGENTS_ENTRY"
  cp "$RUNTIME_DIR/captures/$s/wire.jsonl" "test-fixtures/pi-rpc/$s-1.5.2.jsonl"
  cp "$RUNTIME_DIR/captures/$s/commands.jsonl" "test-fixtures/pi-rpc/$s-1.5.2.commands.jsonl"
  cp "$RUNTIME_DIR/captures/$s/requests.json" "test-fixtures/pi-rpc/$s-1.5.2.requests.json"
  cp "$RUNTIME_DIR/captures/$s/provenance.json" "test-fixtures/pi-rpc/$s-1.5.2.provenance.json"
done
node_modules/.bin/tsx test/normalize-pi-rpc.ts
```

When run inside the bounded task harness, all capture commands were supervised by `smarty-reap`, explicitly waited for and stopped. Do not launch unsupervised long/background captures there.

Tests: `src/drivers/pi/pi-recordings.test.ts` compares every normalized golden and validates PRP envelopes; `ui/src/components/transcript/native-pi-rpc-golden.test.ts` exercises the actual app native consumer. Production Pi proxy encoder replay is explicitly skipped on b7bfd4e5 because `src/cli/pi-app-server-proxy.ts` does not exist; proposed test ports in that test are not existing exports.

A terminal in the app test is a **simulated driver-governed terminal**. Native final prose does not prove task completion or authorize a terminal. Child costs, unqualified summarizer costs and nonfinite/missing costs remain unknown; estimated local Pi prices are labelled estimates.
