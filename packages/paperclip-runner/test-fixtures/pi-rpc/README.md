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
