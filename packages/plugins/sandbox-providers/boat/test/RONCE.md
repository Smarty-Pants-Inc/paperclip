# R-ONCE: pending person message across an actual durable Runner restart

Keep reason: data safety at the sandbox/process/PRP boundary. This extends the
supplied S-04 monitor harness; no production module, confirmation guard, monitor
fence, or existing Boat assertion is changed.

## Reproduce

Prerequisites: installed workspace dependencies, built shared/plugin SDK and Boat,
plus the real `paperclip-runnerd` and existing `fake-codex-app-server` Rust binaries
built from `packages/paperclip-runner/runner`. Set `TMPDIR` to a private directory.
From repository root, run in the foreground (or under the caller's process owner):

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs \
  packages/plugins/sandbox-providers/boat/test/real-server-monitor-once.mjs \
  "$PWD" /absolute/paperclip-runnerd /absolute/fake-codex-app-server /absolute/output all
node --test packages/plugins/sandbox-providers/boat/test/ronce-verdict.test.mjs
```

The executable imports the unmodified NSE launcher, recovery probe and durable
transport, and drives the emitted Boat plugin. Only Boat HTTP and guest path
mapping are simulated. All network requests are fenced to the fake Boat host.
Cases (a)/(b) require resumed liveness plus a fresh authenticated `thread/read`.

For (c), the runner first authenticates. A test-only SIGSTOP prevents it from
consuming a new turn; the ordinary transport then persists the person's unique
message as exactly one pending `turn.start` command. The harness reads that
journal and verifies no provider turn/answer exists **before** starting archive.
On resume, the fault kills the actual old runner/provider processes. The real
monitor must return 45 and confirm exit; only the existing transport recovery
branch launches the replacement. The harness never resubmits the message.

`ronce-fake-provider.mjs` wraps the existing Rust fake provider, recording both
process generations in one append-only log. It learns the random token only
from actual `turn/start` input and substitutes an input-sensitive answer. Both
the provider output and controller notifications must contain exactly one
matching answer. Final checks bind the original durable command ID/sequence to
its completed result and require the provider thread to be settled. The harness
waits for fresh supervision and checks counts again after closing both handles.
The committed JSON is observed base evidence; Node tests reject missing,
duplicate, stale-generation, wrong-token, unconfirmed-exit and unsettled variants.

## Important separate failure: not whole-application qualification

The supplied base delivers the queued message exactly once **but the original
`turn/start` promise rejects** with `runnerd exited while waiting for turn.start`.
The result and summary expose `requestAdmission: FAIL`; that is not a successful
request response or clean end-to-end application acceptance. The failure is at
`runnerd-codex-transport.ts`'s `#waitCommandWork` / `waitForRunnerCommand` exit
check while the supervisor independently performs its confirmed-exit restart.
The actual command, provider turn, answer and notification are not lost/replayed
in this harness. In accordance with the brief's explicit no-production-change
branch when those counts hold, this delivery records, rather than changes, that
additional issue. A caller that discards events after a rejected request still
needs separate application-level qualification by the owning lead.

No live Boat/gate/fresh, credentials, daily-work acceptance, or CI is claimed.
