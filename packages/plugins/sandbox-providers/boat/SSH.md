# Route A: S9 resident guardian over SSH

Version `0.1.14-runner-envfile-snapid-retain-routea`. Vendored SDK/shared from
Paperclip `cl/img1b` **ae66270620cb7eeaae2a13fc0aef22e3656d44ad**. Existing plugin
ID `paperclip.boat-sandbox-provider`, provider key `boat`. No Core/SDK patch.
The S9 host-boundary test fixture is Core **51d9a5afbd2a99b974ae060a372082352174df71**;
the image 1b archive lacks that S9 host module. These are not carrier-on
qualification results for image 1b.

## Install and opt-in

**Before installation, read back and record `enableSandboxDuplexBridge=false`
and the Core version on the target instance.** Its default is off. This plugin's static duplex capability also
exposes Core's generic bridge attempt when that separate setting is true. This
carrier is guardian-only, not a general command tunnel. Other commands/SSH-off
leases receive an immediate body-free typed refusal. The pinned generic bridge
records one `channel_open_failed` fallback and uses its file bridge. Its off
setting does not attempt duplex. Both paths have local real-bridge tests.

`duplexCarrier` defaults to `off`; omission also means off. Only acquired/resumed
leases with `duplexCarrier:"ssh"` and successful current guardian preflight receive
`runnerGuardianVersion:1`. Disabled resume removes both an old marker and its
preflight receipt. A failed preflight throws; it cannot return a usable lease.
A worker's open hook refuses every lease not admitted this way.

off takes effect at the next run start; a run that started with ssh ON finishes its own observe/park.
An off save is not immediate revocation of an already-started run.

Opens are possible until the next acquire or resume (an off save does not stop them immediately); the next acquire or resume retires with 0 opens.
This is the accepted Core-limited boundary. The Core 51d9a5af fixture's
`environment-runtime.ts:2826–2833` and `plugin-worker-manager.ts:2651–2659`
omit environment config from the duplex RPC. SDK `PluginDuplexChannelOpenParams`
has no config field. The boundary test exercises repeated opens before lifecycle
admission; it does not impose a one-open limit. The lifecycle regressions require the next off acquire and
resume each to remove the key, marker and preflight with zero transport opens.
They also check both continuations after an SSH-on run parks following an off save.
These local tests do not replace independent review or live installation proof.

The manifest statically declares `reusableLeases:true` (already in the live
retained line) and `duplexCommandStream:true`. Core verifies the hook methods.
S9 additionally requires `reuseLease:true`, an exact active reusable lease and
its marker, then live qualification of the selected Runner binary before it
exposes release/resume. Static support does not enable environment reuse when
`reuseLease:false`. There is no new Core capability method or provider key.

## Distribution and preflight

On SSH acquire/resume, the plugin probes Node >=24.11, boot ID and installed
hashes. Missing/different assets are uploaded through the signed files API;
the signed PUT receives no Boat bearer. A non-secret sudo installer reads those
files without following symlinks, verifies their pinned SHA-256 bytes, and
installs:

- `/usr/local/libexec/paperclip-guardian-<version>/`: root:root, 0555.
- Eight guest runtime files: root:root, 0444. The process reads them via Node.
- `/usr/local/libexec/paperclip-runner-guardian`: root:root, 0755. This stable
  shell entry clears inherited variables and execs the exact versioned Node
  entry, preserving only the original SSH command when present.
- `/run/paperclip-runner-guardian/`: service user, 0700. Provisioned on every
  enabled acquire/resume because /run may have disappeared after a cold boot.

The resident uses `systemctl --user`, `Restart=no`, private umask, null stdio,
and a clean verified environment. Its exact ExecStart is Node + the versioned
`paperclip-runner-guardian serve /home/user/.paperclip-host/runner`. The unit
unsets inherited manager variable names without storing their values. Preflight
checks the actual resident argv/environment, root-owned assets, socket mode and
read-only status of the guardian's internal process owner. That private status
socket is not exposed over SSH. S9 has no public status verb.

No automatic restart, socket reclamation, process adoption or Runner launch is
performed by staging. A detected live/incompatible resident blocks replacement.
An exited owner remains exited, not empty. Metadata records actual boot ID,
`machine: same|new|unknown`, status and `coldStartRequired` when the boot changed
or status is empty. This is not a live-continuity assertion.

## Carrier and trust

The worker generates an ed25519 key in memory and feeds it to its own ssh-agent
through the agent socket. The private key never enters a file, argv, environment
or Boat call. Public-only identity/known-host files live in its private 0700
directory. Boat's `POST /sandboxes/{id}/sshkey` is the only host-pin authority.
StrictHostKeyChecking is yes; there is no TOFU, ssh-keyscan, DNS trust or global
known-host fallback. A proven pin rejection permits exactly one API refresh.
Other transport loss does not authorize accepting a new host key.

The first trusted open binds the exact Runner ID for that admitted lease.
Acquire/resume does not receive that Runner ID, so it cannot authenticate a
ControlMaster with the exact forced command in advance. The old carrier's
first-open prewarm improvement is not available on Route A. Authentication is
deferred, not performed with a placeholder or a broader grant. When an exact
Runner is known, `prewarm` can prepare it without a guardian operation.
The public key editor installs precisely:

```text
restrict,command="/usr/local/libexec/paperclip-runner-guardian client --protocol 1 --runner-id <id>" ssh-ed25519 <public-key> <worker-marker>
```

The guest checks `SSH_ORIGINAL_COMMAND` equals that exact requested argv joined
with single spaces. A shell, other Runner, extra arg or protocol change is refused
before connecting to the guardian. Runner IDs are safe ASCII tokens of 1–128
bytes. The allocation's resident independently binds its first qualified Runner.

One ControlMaster belongs to each exact lease/account/company/environment/driver
scope. Unary clients multiplex through it; a missing master cannot silently open
a new TCP connection. Two workers have separate keys/masters. Guest flock and
atomic rename serialize public-key updates, preserve unrelated keys, retire only
this worker's exact entries and prune expired marked entries. At most 32 marked
workers are admitted. Preparation checks the local control socket and recorded
master PID. An idle/dead master restarts only its handshake with the cached API
pin and exact registered command. A different live PID is refused, never adopted.
Authorized resume invalidates the endpoint/pin. A stale socket can be removed
only after its local control check refuses it.

SSH keepalives are five seconds with three misses. Process exits settle lost
channels even if another process holds their pipes open. A 40-second slave
deadline is the safety net for a peer that keeps SSH alive but sends no reply.
Structured guardian errors still drain their complete response. The 4096-route
table evicts only fully closed tombstones; an ineligible full table refuses with
`BOAT_SSH_ROUTE_LIMIT`. Recent duplicate fences remain.

## Protocol and lifecycle

Only the six S9 flat operations enter SSH stdin: qualify, launch, observe, park,
claim and retire. Both directions are bounded at 16 KiB including LF. Core checks
one object/reply ID; the real guest validates exact-byte idempotency and source
ownership. No claim/launch body, ticket or reply goes through Boat commands,
files or telemetry. The old hostControl envelope is not this wire protocol.

Open binds the exact host route and worker session. Write and stop require that
pair; close acknowledges the host route and remains retryable after uncertainty.
Client close/stop kills only local SSH, never the resident or fd4. Lost replies
are failures, not absence. Retry the same request bytes and ticket.

Core's confirmed native park precedes the release hook. The plugin drains its
clients and attempts key/master retirement, then calls the live line's non-force
Boat stop and polls its operation to completion. Retirement has three attempts,
with an abortable five-second guest-editor deadline per attempt. Exhaustion
clears the retiring flag, retains public cleanup identity, logs a body-free
warning and returns `warnings:[{code:"BOAT_SSH_RETIRE_FAILED",attempts:3}]` with
the stop receipt. Provider stop errors still fail. Only confirmed stop returns
`state:"stopped"`; this is not a claim of confirmed key revocation.
**No sandbox DELETE implementation or fallback exists.** Destroy requests also
stop and retain the guest; they must not discard pending key cleanup.

The worker-local `retirePending` record retains the OLD worker marker, public
key, expiry and exact Runner. On the next authorized acquire/resume, one abortable
five-second editor attempt removes the old line before any new registration or
authentication. The route remains suspended throughout cleanup and binds only
after it succeeds, so a concurrent open cannot race past that ordering.
Failure preserves the record and returns `BOAT_SSH_RETIRE_PENDING`
on both lifecycle admission and subsequent opens. Only confirmed removal clears
it for a surviving guest. The carrier's confirmed-external-destruction helper
can forget it, but Route A's stop-only destroy hook does not call that helper.
Pending state is not restart-persistent. Shutdown destroys signing authority even
if remote revocation fails.

Company/global `configChanged` is not an effective environment edit. Unrelated
saves preserve routes and keys. Scoped off acquire/resume suspends that exact
lease and retires its key; no broad company/global invalidation is inferred.
Resume uses the same sandbox ID, then workspace proof and fresh guardian
preflight; it does not acquire a replacement. Core owns claim, source PRP
reconciliation, run.attach, monitoring and durable stop-intent handling.

## Proven locally, not production qualification

The suite executes a real local sshd, root-owned staged entry/modules, real S9
resident/client and fd4 fake Runner using Core-derived frames. It covers full
launch/observe/park/claim/exact retry/retire, one SSH authentication, two workers,
forced-command rejection, lost claim reply, API pin refresh, SDK dispatch,
retirement failure and exact cleanup retry. A separate test runs the actual
pinned generic bridge through two successful HTTP requests after typed refusal.
The service manager and Boat API are fixtures. Local latency is not Boat latency.

Remaining production gates belong to the lead: independent review; installed
instance setting read-back; guest Node/sshd/sudo/systemd and service UID/ptrace
isolation; native Runner/provider qualification; credential/checkpoint recovery;
and three real daily-work W1 cycles including >300000 ms sleep and the controller
cache window. W2 is checkpoint recovery, not process continuity.

Root-owned files do not isolate a same-UID process or a task with sudo. This
plugin does not create a separate service account. API key registration briefly
precedes its forced-line rewrite; no connection is opened before restriction
succeeds. Concurrent operator/API key-file edits that ignore flock are not a
lossless compare-and-swap. The 24-hour marker is a pruning timestamp, not sshd
hard expiry; hard worker death does not guarantee remote revocation. Every
per-environment config edit is not a company plugin config callback. Hook-time
cached-binding gates do not enforce a new run's effective off before acquire/resume;
the missing config on the pinned duplex RPC is the explicit accepted boundary above.
