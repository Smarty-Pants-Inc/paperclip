# Resident Runner guardian: S9 version 1

This directory implements the Core ↔ resident guardian S9 contract. It does not
activate a Boat capability, change the SDK, or qualify Pi retention. The binding
Core source is `60bf63fbed380f97da46b6242ec159ab58cbf2ae`, notably
`server/src/services/native-runtime/sandbox-runner-retention.ts` and its two test
files. Do not substitute the old supervisor envelope for an S9 frame.

## Installation and trust boundary

Use Linux and Node 24.11+ at `/usr/bin/node`. Route A stages all eight runtime
assets in `/usr/local/libexec/paperclip-guardian-<plugin-version>/`, root:root
0444 in a root:root 0555 directory. The guest `paperclip-runner-guardian` is Node
ESM. A root:root 0755 shell entry at `/usr/local/libexec/paperclip-runner-guardian`
clears inherited environment and execs that exact versioned guest entry through
`/usr/bin/node`. It preserves only SSH_ORIGINAL_COMMAND for the guest's exact
forced-command check. Local non-SSH client invocation remains supported.
Installation uses noninteractive sudo, validates uploaded hashes before any
root install, and does not replace a detected active resident. See `../SSH.md`.

Run the resident as a trusted service UID different from Pi/tool UIDs. Root and
other processes with the service UID are trusted. Pi must have no ptrace access,
shared credentials, sudo path, or write access to the guardian, installed runner,
private directories, or their ancestors. The guardian does not create users or
establish this production boundary. Launch arguments and environment are trusted
Core inputs; screening environment names does not discover disguised secrets.
The distribution must not mutate executable images in place while in use.

Provision `/run/paperclip-runner-guardian` with the service UID and mode 0700.
All ancestors must prevent replacement by the task UID. Start the resident with a
clean service environment, independently of any SSH command/client lifetime:

```sh
/usr/bin/node /usr/local/libexec/paperclip-guardian-<plugin-version>/paperclip-runner-guardian serve /home/user/.paperclip-host/runner
```

`serve <dir>` uses the supplied private directory for the process owner. Its public
socket is always `/run/paperclip-runner-guardian/control.sock`, mode 0600.
`GUARDIAN_SOCKET_PATH` is exported by `guardian.mjs` and by the executable for
staging/forced-command code. There is no environment or client argument override.
Tests can supply an endpoint to the embedded API only.

The resident writes one non-secret readiness line:

```json
{"version":1,"socketPath":"/run/paperclip-runner-guardian/control.sock"}
```

The endpoint serves one allocation/Runner. Its first successful qualification
binds that Runner ID. Filesystem permissions authenticate the local carrier;
Node does not expose `SO_PEERCRED`. The Boat host must authorize the exact
company/environment/provider allocation/Runner before starting the trusted
client. Do not share this resident across unrelated Runners or tenants.

Do not remove an existing socket to force a restart. The guardian fails closed
on an occupied or stale endpoint. There is no process adoption, receipt recovery
after resident death, or permission for cold replacement after a crash. Memory
retention must preserve the resident and its open fd4 endpoint.

## S9 client and framing

Core opens exactly this command through the existing SDK duplex channel:

```text
/usr/local/libexec/paperclip-runner-guardian client --protocol 1 --runner-id <id>
```

Send **one UTF-8 JSON object plus LF** on stdin, using channel write, not shell
arguments, environment, command history, checkpoints, or telemetry. The client
writes one JSON object plus LF with the same request ID. Both directions are
limited to **16 KiB including LF**. Duplicate keys, invalid UTF-8, extra lines,
invalid Unicode and unsafe numeric cuts are rejected. Malformed/oversized input
whose ID cannot safely be parsed gets a typed refusal with `id:null`; Core must
treat it as uncertainty. Valid refusals preserve the request ID.

The CLI runner-id must match a launch's unique `--runner-id` argument or any
frame identity. For claim/retire without identity, a private local envelope
carries that CLI scope to the resident. The envelope is
`{runnerId,request:<exact S9 JSON+LF string>}` plus LF. It is **only a Unix-socket
implementation detail**, not a Core/Rust frame. This preserves byte identity and
prevents an identity-less claim from crossing Runner scope.

Closing/stopping a client closes only that carrier. An admitted operation keeps
running in the resident. Disconnects neither cancel native transitions nor close
fd4. The caller retries the exact same bytes and ID to recover a lost receipt.

## Frames and IDs

`identity` has exactly six string fields: `runnerInstanceId`,
`environmentLeaseId`, `runId`, `normalizedSessionId`, `turnId`, `itemId`.
`environmentLeaseId` is the immutable durable Runner binding, not a successor DB
lease UUID. The canonical identity is compact JSON with ASCII-sorted keys.
All hashes below are lowercase SHA-256 of UTF-8 bytes.

| Operation | ID |
| --- | --- |
| qualify | `qualify_` + hash of `JSON.stringify({runnerBinary,runnerDigest})`, that field order |
| launch | `launch_` + hash of `runnerInstanceId + ":" + identityNonce` |
| observe | `observe_` + hash of canonical identity |
| park | `park_` + hash of canonical identity |
| claim | `claim_` + hash of bootstrap ticket |
| retire | `retire_` + hash of `parkId + ":" + (claimId ?? "parked")` |

Caller-chosen arbitrary IDs do not establish ownership. Successful receipts are
kept in resident memory and bound to Runner, exact request bytes, process
ownership and park/source. Only request hashes and non-secret receipt/proof
metadata remain in the cache; launch environment and claim tickets are not
journalled. Changed bytes for an already admitted ID return `ID_CONFLICT`, even
if only key order or whitespace changed. Native timeouts keep the exact pending
fingerprint and permit only the matching retry until reconciled. Transient
refusals can be retried with identical bytes; they do not authorize replacement.
The cache fails closed at 4096 IDs, rather than evicting idempotency evidence.

### qualify

```json
{"op":"qualify","id":"qualify_<hash>","runnerBinary":"/runtime/paperclip-runnerd","runnerDigest":"sha256:<64 lowercase hex>"}
```

The guardian checks the absolute non-symlink executable, ownership/permissions,
protected ancestors and actual SHA-256 bytes. It runs the installed executable's
bounded `--build-metadata` mode with a clean environment and checks schema
`paperclip-runner/runnerd-build-metadata/v1`, `binaryName:paperclip-runnerd`, and
`privateHostControlVersion:1`. It rehashes after that check, on qualification
replay, and before launch. It does not echo an unverified caller attestation.

Reply:

```json
{"id":"qualify_<hash>","status":"qualified","guardianVersion":1,"privateHostControlVersion":1,"runnerBinary":"/runtime/paperclip-runnerd","runnerDigest":"sha256:<hash>"}
```

### launch

```json
{"op":"launch","id":"launch_<hash>","command":"/runtime/paperclip-runnerd","args":["--runner-id","runner","--state-dir","/private/state"],"cwd":"/workspace","environment":{},"identityPath":"/private/identity","identityNonce":"process-A","diagnosticsDirectory":"/private/diagnostics"}
```

`command` must have been qualified. Arguments are preserved, including credential
or bootstrap file paths. A unique `--host-control-fd 4` is appended if absent;
an existing exact flag is kept in place. Duplicate, ambiguous or non-4 flags are
refused. There is no shell. The fd4 stream comes from the existing connected Unix
socket pair/process owner. The accepted stream is passed through Node's public
spawn stdio API; the temporary listener and duplicate child endpoint are closed.
The resident keeps the other endpoint.

The explicit environment is the entire spawn environment. It is not merged with
the guardian environment. `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET` is admitted **only
inside a launch's environment** and reaches only the daemon spawn environment.
It is neither echoed nor stored/logged. Other secret-class names containing
TOKEN, SECRET, PASSWORD, CREDENTIAL, API_KEY, PRIVATE_KEY or BOOTSTRAP_TICKET stay
refused. Core's S9 unit fixture explicitly sends `PRIVATE` as an ordinary private
environment name. Its integration fixture uses credential-home `auth.json` for
`OPENAI_API_KEY`, not an API-key launch-environment exception. The existing Core
transport adds `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`. No broader secret-name allowance
is inferred. Claim tickets occur only in private claim-frame bytes.

These are reference-release guarantees, not JavaScript heap zeroization. Linux
initial `/proc/<pid>/environ` remains visible to root/same UID after runnerd clears
the live variable. The separate task UID/ptrace boundary is mandatory.

Launch success is only `{id,status:"launched"}`. It is not PRP authentication or
runner/provider readiness. Exact replay returns the original receipt and never
spawns twice. Another nonce cannot launch while a process is live **or unretired**,
even if the original process crashed. A fresh nonce can replace it only after
exact proven retirement. Marker failure kills the owned child and holds the
unretired record rather than silently retrying a spawn.

The marker is atomically renamed from an exclusive private temporary file, synced,
mode 0600, non-symlink, and has exactly five newline-terminated lines:

```text
identityNonce
actual-daemon-pid
ISO-8601-startedAt
runnerInstanceId
linux:<boot-id>:<proc-stat-field-22>
```

The PID is the spawned daemon's PID, not the resident/client. State, diagnostics
and marker directories must be private, owned and non-symlinked. An existing
marker is overwritten only for the exactly retired prior owner at that path.

### observe

```json
{"op":"observe","id":"observe_<hash>","identity":{"runnerInstanceId":"runner","environmentLeaseId":"lease","runId":"run","normalizedSessionId":"session","turnId":"turn","itemId":"item"}}
```

The safe source is `<--state-dir>/runner-state.json`. Native
`runner-core/src/durable/state.rs` serializes all six fields and both counters
with camelCase and commits through fsync + atomic rename. The guardian validates
the live owned process/birth, marker, command line, state directory, private file,
post-launch modification time, schema, all six fields and immutable Runner/lease.
It rejects unsafe/non-settled cuts: non-safe integers, nonempty outbox, unacked
source tail, warm transition, pending terminal/provider cleanup, recoverable
failure, or pending/indeterminate commands. It never guesses zeros or uses a
caller-supplied cut as an observation.

Reply is `{id,status:"observed",identity,lastControllerCommandSeq,ackedSourceSeq}`.
No state-dir, missing state, stale owner, bad file or unsafe cut produces a typed
refusal. Observation is advisory: native park must still independently accept
that exact cut and provider readiness. A cached observation is the original
receipt; a later native park rejects a cut that became stale.

### park, claim and retire

The existing private host-control v1 frames are forwarded **byte-for-byte**:

```text
{op:"park",id,identity,lastControllerCommandSeq,ackedSourceSeq}
{op:"claim",id,parkId,bootstrapTicket}
{op:"retire",id,parkId}
{op:"retire",id,parkId,claimId,identity,lastControllerCommandSeq,ackedSourceSeq}
```

The last form uses the original source/cut after a possibly applied claim. The
guardian records possibly applied claim IDs, never their tickets. It requires
the exact owned park/source and full claimed-cut form. Native `parked`, `claimed`,
`retired` and `conflict` replies are correlated by ID. No ACK is manufactured.
`parked` does not imply Boat stop success. `claimed` does not imply source PRP
authentication, reconciliation, run.attach or permission for B's prompt.

A retirement reply is augmented with all three booleans only after:

1. Exact native retirement ACK.
2. Confirmed exit/reap of the owned daemon.
3. Exact private lineage writer PID and birth at
   `process-lineage/writer-<pid>.json`.
4. The same qualified executable's bounded `reap-lineage` reports
   `paperclip.runner.process-lineage-reap.v1`, `verified:true`, no reason and no
   remaining descendants. Native lineage tracking owns descendant discovery;
   the guardian does not infer completeness from a one-time `/proc` scan.
5. Private durable state remains present and valid for that same source/cut.

Then, and only then:

```text
{id,status:"retired",executionStopped:true,descendantsStopped:true,sessionStateAvailable:true}
```

`RETIREMENT_UNCERTAIN` contains no proof booleans. A claim for an exactly retired
owned park can return `{id,status:"absent",identity,lastControllerCommandSeq,
ackedSourceSeq,executionStopped:true,descendantsStopped:true,
sessionStateAvailable:true}` after rechecking the complete proof. Unknown owner,
crash, EOF, missing writer/state, stale source/cut or timeout never becomes
absence. This proves the guardian/native durable-state boundary; the existing
Core provider checkpoint and credential writeback obligations still apply.

## Limits and errors

- S9 request/reply: 16 KiB including LF.
- Local envelope: 128 KiB (JSON escaping of the bounded S9 bytes).
- 32 carrier connections; 16 queued operations; 4096 remembered IDs.
- Resident input deadline: 5 s; CLI whole exchange: 14 s (Core default is 15 s).
- Native exchange: 12 s; a longer native park preparation remains uncertain
  and must be reconciled by exact retry, never translated to absence.
- Exit proof: 1.5 s; lineage command: 1 s native deadline, 3 s process bound.
- No idle polling. Timers exist only for active input/exchange/cleanup obligations.

Failures are body-free:

```json
{"id":"<same-id>","status":"refused","error":{"code":"RUNNER_MISMATCH"}}
```

Codes include `INVALID_FRAME`, `FRAME_TOO_LARGE`, `INVALID_ID`, `INVALID_LAUNCH`,
`RUNNER_MISMATCH`, `ID_CONFLICT`, `NOT_QUALIFIED`, `ARTIFACT_MISMATCH`,
`UNSUPPORTED_PRIVATE_CONTROL`, `ALREADY_RUNNING`, `UNSAFE_MARKER`, `UNSAFE_STATE`,
`PARK_NOT_OWNED`, `STALE_CUT`, `SOURCE_CONFLICT`, `RETIREMENT_UNCERTAIN`,
`REPLY_TIMEOUT`, `UNCERTAIN`, `CHANNEL_FAILED`, `CARRIER_FAILED`, `CLIENT_TIMEOUT`,
`INVALID_REPLY`, `BUSY` and `RECEIPT_LIMIT`. None grant replacement permission.
A native malformed/wrong-ID reply fails the channel closed. Ordinary client
close never closes it. Resident shutdown closes fd4 and invokes the existing
owned-process cleanup; it is not a retirement proof.

## Legacy and validation

The old `runner-supervisor.mjs` and `runner-control.mjs` API remain for existing
mechanism tests. The S9 resident reuses that process owner; its private internal
`process/control.sock` is **not** the Core endpoint and must never be exposed by
Boat. Legacy `{op:"hostControl",generation,frame}` is refused at the S9 endpoint.
The old owner still defaults to its original argument validation and protocol.
Route A preflight uses its private read-only `status` operation after checking
the S9 resident's exact argv, clean environment, installed ownership/hashes and
S9 socket. S9 itself deliberately has no public `status` verb.

Run the dependency-free S9 flow:

```sh
node --test packages/plugins/sandbox-providers/boat/src/runner-guardian-flow.mjs
```

`src/runner-guardian.test.ts` also runs that suite in focused Vitest checks.
The current root Vitest project list does not include Boat; this delivery does
not claim CI coverage or change the lead-owned CI/project admission.
The suite uses Core-derived fixture frames, real local clients/sockets/processes
and an explicitly fake native peer. It covers all operations, exact marker,
byte-preserving fd4, replay/lost replies, second launch, private ticket delivery,
unsafe state/identity, retirement/absence proofs, protocol limits and client
scope/reply checks. It is not evidence that real runnerd or Pi accepted a park.

## Lead-owned deployment and remaining production gate

Boat must stage these files and Node, restrict the exact forced command, bind
the host route to company/environment/allocation/Runner, and implement the four
existing SDK duplex hooks. Stop/close affect only the client. Do not log payloads.
Exact park precedes memory-retaining provider release; failed stop never falls
back to destroy. Resume the exact allocation, claim the same ticket/ID, then
source PRP auth/reconciliation, ordinary run.attach, and B's prompt. Successor
DB lease rows must not change the durable environmentLeaseId.

Before activation, run the separate real guest UID/ptrace, artifact staging,
checkpoint/credential-writeback, Pi readiness and retention gates. The lead must
run three real daily-work W1 cycles, including >300000 ms sleep and the selected
controller-cache window, and record allocation, predecessor/successor leases,
PID/birth/provider session, claim/attach ordering and clean retirement. W2 is
checkpoint recovery, not live-process continuity. No such proof is supplied by
this guest implementation or its fake-runner tests.
