# L1e GitHub ingress integration harness

This is a test-only harness for the L1e contract. It contains no server/runner implementation changes and makes no GitHub calls. It has two protocol peers so either lane can be tested separately, plus a joint mode for when both implementations are available:

1. **Real runnerd + stub core/server** (`--runnerd`): starts the compiled `paperclip-runnerd`, connects to its listening PRP endpoint, completes real v3 mutual authentication, sends a welcome advertising `github_access.http`, then exercises runnerd's Unix-socket HTTP request/reply if the binary exposes it.
2. **Stub runner + real server/core** (`--stub-runner`): listens for the server's outbound WSS/WebSocket connection, sends an authenticated runner hello, verifies the server challenge, completes PRP auth, sends a synthetic `github_access.http` request, and validates its correlated reply. Point the server integration fixture's Boat preview/private URL at this listener. The request body and GitHub credential are synthetic/test-only; output is metadata-only.
3. **Joint real server + real runnerd** (`--runnerd --external-server`): starts runnerd without a stub peer, prints its WSS target, waits for the configured real server/Boat test fixture to connect and for runnerd's private Unix socket, then makes one local request through the full route. Use only a gate-owned test identity and test credentials.

The PRP harness uses Node built-ins only. The exact bridge response timeout is taken from `packages/adapter-utils/src/sandbox-callback-bridge.ts:30` (30 seconds), and its stub queue depth is read from `DEFAULT_BRIDGE_MAX_QUEUE_DEPTH` at line 33 (64), the file/queue bridge path being replaced—not the HTTP/2 stream cap. GitHub-token and `x-paperclip-github-capability` credentials are held in memory and never printed. The scanner checks each credential's raw bytes and base64 encodings at offsets 0, 1 and 2. Before a clean result is accepted, every supplied real sink (`--scan-path`, `--history-file`, and `--process-output-file`) is copied and positively controlled in its native format with all four forms of each credential; a scanner that misses a planted form fails the row. Give `--scan-path` every server log, PRP span/frame-log export, run log and Langfuse export; pass Boat exports explicitly with `--history-file` and `--process-output-file`. Those inputs accept JSON or NDJSON and are scanned alongside `--scan-path`; durable PRP state is scanned automatically in runnerd modes. Boat documents command-history JSON (`commands`) and command logs (`data`) at [command-history.md](https://docs.boat.dev/long-running-tasks/command-history.md#read-the-history) lines 43–50; its process-output records are retained for 72 hours (same doc lines 17–18, 91–100).

## Build and run on base `5b0145ab4`

From the repository root:

```sh
cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml \
  -p paperclip-runner-core --bin paperclip-runnerd
node packages/paperclip-runner/tests/l1-gh-ingress/ingress-harness.mjs --self-test
node packages/paperclip-runner/tests/l1-gh-ingress/ingress-harness.mjs \
  --runnerd packages/paperclip-runner/runner/target/debug/paperclip-runnerd
```

`--self-test` runs deterministic *contract-fixture* cases, including foreign-run refusal, idle-session refusal, wrong-capability 403 before the credential resolver, binding-generation discard, request-ID replay rejection, private socket permissions, out-of-allow-list refusal with `Unknown GitHub session operation`, file/queue-source inflight and body limits, bounded named ingress-drop response, raw plus all three base64 alignments for both GitHub and capability credentials across synthetic Boat history and 72 h process-output exports (including clean exports), native-format positive controls that fire on planted sink copies and fail with a simulated broken scanner, and the masked real Boat command-history sample (one bridge listing; process records excluded). The sanitized logs case proves the SCANNER only (its fixture never held the token), not product evidence. Those validate harness fixtures only; they are not evidence that the production halves pass. The real-runnerd mode proves PRP mutual authentication against the stub peer. On the base snapshot, runnerd has no GitHub-access Unix socket, so the implementation-specific RFL rows are reported as blocked/skipped rather than claimed as passes. Re-run after L1b lands; those rows will execute automatically when the configured `PAPERCLIP_GITHUB_RUNNER_SOCKET` or a socket below runnerd's state directory is present.

### Server-lane (L1a) integration with stub runner

Run this process alongside the server's own integration fixture. Configure that fixture's Boat private/preview WebSocket destination to `ws://127.0.0.1:43127/api/runner/v1/connect/<run-id>` (or the corresponding reachable test host/port). The server must dial the endpoint; this harness does not initiate the server connection.

```sh
L1E_BOOTSTRAP_TICKET='fixture-only-ticket' \
L1E_RUN_ID='fixture-run-id' \
L1E_EXPECT_STATUS=200 \
node packages/paperclip-runner/tests/l1-gh-ingress/ingress-harness.mjs \
  --stub-runner --port 43127 --path /api/runner/v1/connect/fixture-run-id
```

The harness is a fixture runner only. Bind IDs are test values (`L1E_RUNNER_ID`, `L1E_ENVIRONMENT_LEASE_ID`, `L1E_SESSION_ID`, `L1E_TURN_ID`, `L1E_ITEM_ID` may override defaults). Use `L1E_CASE=foreign-run` to add foreign run/company/agent/issue IDs as untrusted request extras; verify the real server rejects them or leaves authenticated authority unchanged. Use `L1E_EXPECT_STATUS` to assert the server response status (e.g. 403 for foreign/idle). Each received reply logs only status, request ID and decoded body size. No credential body, frame headers or header values are logged. A server integration test that exercises idle-session and generation-swap must arrange its own active-run/resolver barrier in its existing fixture and use this peer to send the request; the stub does not pretend to reproduce server-side state.

### Runner-lane (L1b) integration with stub server

```sh
node packages/paperclip-runner/tests/l1-gh-ingress/ingress-harness.mjs \
  --runnerd packages/paperclip-runner/runner/target/debug/paperclip-runnerd \
  --scan-path /path/to/server.log \
  --scan-path /path/to/prp-spans.jsonl \
  --scan-path /path/to/run.log \
  --scan-path /path/to/langfuse-export.json \
  --history-file /path/to/boat-command-history.json \
  --process-output-file /path/to/boat-process-output-72h.ndjson
```

The harness starts a disposable runnerd, authenticates with a synthetic bootstrap ticket, then waits for its Unix socket. On an implementation build it sets `PAPERCLIP_GITHUB_RUNNER_SOCKET` to a private path (override with `L1E_SOCKET_PATH`), sends the current HTTP credentials endpoint over that socket, replies through encrypted `github_access.http`, verifies HTTP body delivery, and then drops the PRP connection to check the named 503 deadline. The runnerd socket must be 0600. A second-UID probe uses `setpriv` and UID 65534 when possible; it reports an explicit skip if the private `$TMPDIR` parent prevents reaching the socket, or if host policy denies switching to a second UID.

The ephemeral reply kind can be overridden for protocol iteration with `L1E_REPLY_KIND` (default `github_access.http.reply`). The response is synthetic `{status:"available",env:{GH_TOKEN:<sentinel>}}`; the generated GitHub sentinel and forwarded capability token must be absent from runnerd output, supplied server/span/run/Langfuse sinks, Boat history and 72 h process output, and durable runner state. The harness itself scans metadata-only observations, not encrypted wire bytes. A gate must additionally confirm shim stdout/stderr and collect server logs, run logs and PRP spans rather than leaving `--scan-path` empty.

### Joint real-server + real-runnerd

Point the real server test fixture's Boat dial target to the runnerd address printed by:

```sh
L1E_BOOTSTRAP_TICKET='test-ticket-from-server-fixture' \
L1E_RUN_ID='fixture-run-id' L1E_LISTEN_PORT=43127 \
L1E_BROKER_TOKEN='test-broker-token' L1E_CAPABILITY='test-capability' \
L1E_SENTINEL='synthetic-test-token' \
node packages/paperclip-runner/tests/l1-gh-ingress/ingress-harness.mjs \
  --runnerd packages/paperclip-runner/runner/target/debug/paperclip-runnerd \
  --external-server --socket-wait-ms 60000 \
  --scan-path /path/to/server.log --scan-path /path/to/prp-spans.jsonl \
  --scan-path /path/to/run.log --scan-path /path/to/langfuse-export.json
```

Supply only the corresponding synthetic fixture values. The bootstrap ticket must be the same fixture ticket the server uses to authenticate this runner, and `L1E_CAPABILITY` must be the valid fixture capability. Joint mode's first request uses that real fixture capability and must return 200; the second uses a distinct wrong capability and must return 403 before the credential resolver is called. It then scans GitHub and capability credentials (including the wrong token sent in case 2) in runnerd durable state, supplied server/run/Langfuse sinks, Boat command history and 72 h process output. The server fixture must capture/scan its own process output and Boat's runnerd/shim process output as required by the binding contract; harness success alone does not claim those remote sinks were collected.

To exercise **forced ingress drop** in the joint fixture, make the server test close the authenticated PRP connection after dispatching the request and before replying; the local HTTP request must still resolve to 503 `runner ingress unavailable` within 30 seconds. `--external-server` does not synthesize that drop because the real server owns that connection.

## Gate Boat command counter

Export Boat command history for one gate box/run as JSON (an array or an object containing `history`, `commands`, or `entries` rows). Each row must carry a box identifier and run identifier. Then run:

```sh
node packages/paperclip-runner/scripts/count-boat-history.mjs \
  --box GATE_BOX --run GATE_RUN --history /path/to/boat-history.json \
  --require-prp --transport-log /path/to/run-transport.jsonl
```

The report counts command records by their history `kind`/operation and separately reports `bridgeQueueLists`; Boat `mode: "process"` records are excluded. It recognizes the env-wrapped JSON-glob plus `basename` bridge listing even when the private queue path is masked, without counting its setup, upload or tar-sync neighbors. A masked real Boat fixture exercises this rule. For the PRP gate row, `--require-prp --transport-log` also requires a run/session-scoped `transport=prp` record, rejects fallback/bridge-start records for that run, and rejects a later bridge/fallback in the same session (including reconnect). The script exits nonzero if no history rows match (zero is not evidence) or if any command lists the callback bridge's `requests` queue. Transport-log JSON or JSONL rows use `runId`, `sessionId`, `transport`, optional `fallbackReason`/`bridgeStarted`, and `timestamp`. The gate evidence must retain the exact history export, transport log and output, identity and time window; count RateLimit headers/counters separately for Boat API request totals.

## Current evidence boundary

On base `5b0145ab4`, the harness can prove that the real runnerd binary completed PRP mutual auth with the stub server. The deterministic stub fixtures can pass their own contract-model assertions. The base runner has no socket or `github_access.http` dispatch, and there is no L1a server patch in this worktree, so no product RED row is reported as passed. Real daily native Pi work, Boat proxy/process-output sentinel evidence, the 30-box idle-fleet budget and gate-identity A/B remain release-gate work, not locally simulatable proof.
