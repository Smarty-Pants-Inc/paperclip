# Idle environment cleanup

Pending lease cleanup and historical resource verification use the existing
transaction signals, delivery coordinator, and in-process scheduler. They no
longer run unconditionally from the server maintenance tick. The run reaper
performs its inline pending-cleanup sweep only after actually recovering a run
or an orphaned active lease. Explicit user retry keeps its existing direct path.

## Work and ownership

| Duty | Truth | Trigger and next deadline | Quiet condition |
| --- | --- | --- | --- |
| Failed teardown | Existing `environment_leases` rows in `pending_cleanup` | Commit signal; later of row backoff and saved retry/ownership deadline | No pending lease or deferred orphan |
| Interrupted acquisition | `sandbox_creation_operations` committed before provider creation | Transaction signal; saved acquisition deadline; five-minute backoff after recovery failure | Normal lease or one claimed cleanup lease owns the resource; unsupported uncertainty requires operator reconciliation |
| Historical provider verification | Existing failed ephemeral leases and finished custom-image setups without matching cleanup proof | Commit signal; five-minute retry while an unverified candidate remains | No unverified candidates, including retained verified history |

`environment-cleanup-state.ts` owns the deadline query and the shared safe reader
for retry/ownership metadata. Cleanup claims and the scheduler use that same
reader, including malformed-number handling and the existing maximum horizon.
Startup retains the immediate scan, but never bypasses a saved in-flight claim or
retry cooldown. Subsequent scans respect the five-minute row backoff. Claims,
provider readiness, Stop authority, workspace retention, copyback, receipt
validation, and escalation rules stay with their current owners.

`environment-cleanup-work.ts` registers two independent workers. Their generation
counters preserve a wake until successful reconciliation, including a first write
during drain, changes during a sweep, and failure followed by drain. The existing
heartbeat interval bounds pending-cleanup starts after bursts of writes. Historical
verification has a separate minimum five-minute spacing, including commit-triggered
passes, and does not delay server readiness. No timer remains once
there is no obligation. A self-generated write can require a final reconciliation
before quiet. A failed sweep retains a retry. Shutdown unsubscribes local buffer
wakes; the delivery coordinator stops subscriptions/timers and joins active work.

## Producer coverage

The shared `writeEnvironmentCleanup` helper registers and awaits intent before a
write in a transaction. Existing transaction owners call
`notifyEnvironmentCleanup(tx)` directly. Nested calls retain outer transaction
settlement and uncertainty handling through the shared DB implementation.

- `environments.ts`: orphan insertion, release, metadata replacement, and run-wide
  release. These stores cover normal provider teardown and failed acquisition.
- `environment-runtime.ts`: reusable sandbox cleanup claims and their settlement,
  and Stop/export cleanup claims. Renewal of an already active claim retains its
  bounded timer; it cannot create new pending work.
- `heartbeat/recovery.ts` and `heartbeat/run-control.ts`: orphan-active recovery,
  retry settlement, and explicit recovery of historical leases.
- `environment-task-runtime.ts`: unconfirmed plugin task termination and plugin
  replacement creations. Replacement intent commits before the provider call.
- `sandbox-creation-operations.ts`: admission, atomic lease transfer, and bounded
  recovery. An unavailable database stops admission before external creation.
- `sandbox-stop-and-retain.ts`: persisted Stop intent and its settlement.
- `native-workspace-export-resume.ts` and `native-workspace-export-retry.ts`:
  terminal-export cleanup, resumed-export cleanup claims, and settlement.
- `workspace-recovery.ts`: verified copyback schedules destruction.
- `native-workspace-sync.ts` and the native session executor's backup stamp:
  writes that can invalidate an existing historical row-version proof.
- `environment-custom-images.ts`: provider state, terminal state, and promotion.
  Initial active setup insertion is not a historical verification candidate.

Other lease metadata writes neither create pending cleanup nor change the
row-version/provider identity of a matching historical proof. Changes to an
already pending claim remain covered by its existing deadline. Deletion removes
work; an already scheduled reconciliation observes that removal. Independent SQL
writers and another server process are not covered by these process-local signals.

## Creation ownership

A creation operation retains company, original environment, run, request identity,
provider, and nonsecret configuration references. Its environment FK uses SET NULL;
company/run/task identifiers remain after those records are removed. One operation
owns each company/environment/run/request until it is resolved. A retry of an
attached operation returns its active lease. Pending or unresolved ownership never
authorizes another create. An attached operation resolves when its lease is proven
stopped, checked at the next creation with the same key: the closed lease must
carry the stop proof same-run recovery requires (`remoteExecutionHasStopped`), a
termination receipt for the sandbox this operation created, whether release, the
Runner `complete` operation, or a destroyed reusable successor supplied it. That
creation resolves the operation and records its replacement in one transaction,
so concurrent recoveries make one provider call. A recovered cleanup operation
resolves when its cleanup lease settles. Failed cleanup, success without a
receipt, a receipt for another sandbox, a retained lease, and pending cleanup keep
the operation and its key.
Normal success transfers operation ownership and the lease in one transaction.
Current company binding and run authority are checked again at attachment.
Declared secret-reference fields retain only their references and nonsecret value
hashes. Recovery refuses lookup under a changed credential value; it records manual
reconciliation instead of treating a missing resource in a new account as proof.
A missing, deleted, disabled, or archived saved secret, a missing or inactive saved version,
or an explicitly disabled/coming-soon provider vault also records manual
reconciliation before provider lookup. Admin-disabled credentials require operator
reconciliation; recovery does not reactivate or use them. Temporary secret-provider
or database failures retain the pending operation and its retry deadline.

Recovery never resumes partially prepared execution. It asks a capable provider to
inspect the stable creation identity, validates its ownership envelope, and transfers
one cleanup lease under the operation lock. The existing claimed cleanup worker
owns deletion and confirms resolution. Failed lookup/transfer records a bounded
retry and permits other operations to proceed. An attached operation cannot transfer
to cleanup. Pending creation blocks instance sleep until its obligation transfers.

A pending operation with no resource settles only after its saved
`creationSettleAt` materialization deadline. A successful inspect reporting
`destroyed` for that exact operation identity, without a creation lease or cleanup
envelope, is confirmed absence. Each such post-deadline observation increments
`metadata.creationRecoveryAttempts`; three confirmed absences resolve the operation
with `creationReconciliationReason: provider_absent_after_bounded_recovery`.
If the explicit `creationHeartbeatRunId` instead names a terminal or missing
same-company run, one confirmed post-deadline absence suffices. An agentless
correlation `runId` is not a missing heartbeat owner. Live/queued runs and
agentless intents use the three-observation budget. A successful lookup finding a
resource still transfers to `cleanup_pending`, regardless of prior absence.
A late successful create reply has the same obligation. Recording its exact
resource ID atomically restores `pending` and a due deadline when the operation
was resolved only by bounded absence and has no lease owner. Recovery can finish
the transfer even if the caller stops before queuing cleanup. If a newer attempt
already owns the same unresolved creation key, recording transfers the late
resource to its cleanup lease in that same transaction instead; the old operation
stays `resolved` with that lease ID, so it does not reclaim the replacement's key.
Direct late cleanup uses the same rule. The environment/admission lock and existing
operation lock serialize these paths, so concurrent positive replies create one cleanup lease.
A resolution after completed lease cleanup retains its lease ID and does not
reopen or create another owner.
Failed/unavailable lookups, null or unknown observations, foreign identities, and
pre-deadline absence do not spend that budget or resolve the operation. They retain
ownership and a saved backoff; an unknown resource is never treated as absent.
Unsupported or credential-invalidated generic providers retain their existing
operator-reconciliation behavior. Counter updates recheck pending state and deadline
under the operation lock, preserving concurrent ownership transfer. Resolution
removes the operation from the shared deadline query; no new timer is introduced.

Daytona version 0.1.10 declares creationOperationVersion 1. It uses the committed
operation UUID in its existing creation name and labels. Recovery uses an explicit
creationOperation request on the existing read-only inspect hook and strict failed-creation deletion path. Normal lease
inspection still uses its recorded resource ID; creationOperationId metadata is
provenance only. A missing name alone cannot prove a late allocation will never appear. Missing identity or an
unsupported provider records needs_reconciliation and an operation-scoped warning.
A deleted company also records manual reconciliation before credential lookup or
cleanup transfer. A company lock fences deletion during the transfer transaction.
That manual diagnostic has no automatic timer and does not prevent idle. The row
must be reconciled before retrying the same request. Other providers do not yet
claim automatic creation lookup. Generic plugin operations retain identity only, including a returned task resource
ID before expiry checks or lease attachment. A failed or ambiguous attachment keeps
that known ID for reconciliation; it does not authorize unconditional release.
These operations do not copy credentials, resolved configuration, or provider
payloads into the operation record. A lost provider reply can still leave the
resource ID unknown.

## Compatible changes on reusable sandboxes

Reusable sandbox scopes retain the full configuration fingerprint and a separate
allocation-identity fingerprint. Boot-source keys (`from`, `snapshot`, `image`,
`rootfs`) are identity fields: a change, including clearing a source, never reuses
an allocation created from the old source. Obsolete retained/released allocations
enter the existing durable stop-only cleanup path so their workspace/session
state stays recoverable while a new allocation uses the current source. This
also applies to pre-upgrade fingerprints that omitted boot sources from identity.
Only scalar sizing keys (`cpu`, `memory`, `disk`, `gpu`, `size`, `shape`),
explicit timing keys (`timeoutMs`, `bridgeRequestTimeoutMs`, `livenessTimeoutMs`,
`ttlMinutes`, `autoStopInterval`, `autoArchiveInterval`, `autoDeleteInterval`,
`runnerIdleTimeoutMs`), and scalar `resources.{cpu,memory,disk,gpu}` may drain to
the next allocation. Objects under these names, unknown fields, provider/plugin
identity, account, region, endpoints, mounts, environment and credential/secret
scope changes remain identity changes and keep the existing mismatch behavior.

A compatible sizing/timing change does not relabel the running allocation.
Reuse, provider resume, and the stored scope keep its admitted creation settings
while the owning run is nonterminal or its required checkpoint is unavailable.
An old valid backup is insufficient when later durable provider events exist.
Once the owner settles, workspace safety checks pass and native harness backup
verification covers the latest provider work, acquisition creates and attaches
the new-config lease with the backup and an explicit
`compatible_environment_change` replacement receipt **before** retiring the old
allocation. Failure to create the replacement leaves the source intact.
Existing cleanup claims/retries own a failed retirement; no new worker or timer
is introduced. Pre-upgrade full fingerprints are checked against reconstructed
admitted settings under the current security context, never accepted by a
compatible-key-only comparison.

The PostgreSQL runtime regression covers retained and released boot-source
changes, legacy scopes, stale lifecycle support, same-source reuse, and execution
on the newly acquired source. Compatible sizing coverage includes active and
released warm leases, old scope migration, absent/stale checkpoints, replacement
creation failure, eventual sizing adoption with F7 backup propagation, and
incompatible account/region/mount or object-valued creation-setting changes. This is local lifecycle proof with a controlled provider, not a live
Boat/Pi conversation acceptance result.

## Legacy deferred orphan buffers

Runtimes that hold an unwritten orphan register their flusher in a registry scoped
to the shared database handle. Registration wakes the worker without contacting
the database. A sweep flushes registered runtimes as well as its own startup spool;
this reaches a producer runtime's buffer even when it differs from the heartbeat's
runtime. The registry retains only runtimes with unresolved buffer ownership.

Unreadable directories, records, and malformed records retain a retry; a missing
spool directory is an empty spool. A spool read failure still allows other runtimes to flush their buffers and
persisted leases to clean up, then fails the sweep so recovery stays scheduled.
Each concrete cleanup pass reloads existing legacy spool entries, including entries
beyond buffer capacity. Normal acquisition and plugin task replacement do not append
new fallback files. Retained entries remain available for the separate cutover inventory.
No empty-spool filesystem or database polling is introduced. Existing limits on a simultaneous database,
spool, and buffer-capacity failure remain; this is not a new durable queue.

## Verification and boundaries

The PostgreSQL worker tests exercise quiet configured state and verified history,
real store activation, persisted backoff, failed teardown and restart, nested
commit/rollback, drain/resume, cross-runtime deferred work, failed spool reads,
shutdown joining, provider uncertainty, and historical pagination. Existing
runtime, reaper, Stop, custom-image, and workspace tests cover the underlying
cleanup authority and provider contracts.

The runtime fixture now gives each simulated instance its own DB handle and spool.
Its journal-write failure injection targets the transaction boundary rather than
the direct update that moved inside that transaction. Fake-clock worker tests wait
for PostgreSQL I/O and distinguish an executing sweep from a retained next wake.

This does not migrate discovery of orphaned active leases or legacy shutdown
workspace settlement from the broader run-recovery loop. Custom-image *active
session expiry* also remains on its existing tick; only historical verification
moves here. Other maintenance duties, external probes, and connected transports
still affect idle traffic. No Cloud alarm coverage or host-sleep exemption changes.
These tests prove the changed workers become quiet and recover; they do not prove
deployed suspension or fleet savings.

## Custom-image setup expiry

Setup expiry uses a separate `custom-image-expiry` worker. The custom-image
service owns the active-status predicate, the earliest saved `expiresAt`, and
provider cancellation. Startup registers the worker in the existing enabled
heartbeat housekeeping path; the maintenance tick no longer calls its sweep.

All supported setup producers live in `environment-custom-images.ts`: initial
creation, provider refresh, cancellation/failure status, and promotion. They
register intent in their owning transaction. A provider refresh can move the
deadline earlier; a terminal transition removes it. Historical verification
metadata does not change active expiry eligibility and does not need this signal.
Environment deletion can only remove obligations; an already scheduled pass
observes the removal. Independent SQL and other DB roots are outside the existing
process-local notification contract.

No active dated session means no recurring reads or provider calls. Overdue
batches and failures retain a bounded retry, while first writes and failed
reconciliation survive drain. A missing expiry retains the existing behavior
(no inferred expiration); sleep safety still treats unsupported live resources
conservatively. Provider cancellation, failure state, and historical resource
verification keep their existing semantics. No Cloud alarm coverage changes.

## Historical retry test observation

The historical verification worker intentionally does not delay server readiness.
Its provider sweep finishes before the following database pending-state read
registers a retry deadline. The regression test now waits for that future
deadline before inspecting it; sweep completion alone is not scheduler settlement.
The runtime worker, retry interval, and readiness contract are unchanged.

A controlled 150ms delay before the real pending-state query reproduced the
current CI failure: the immediate assertion observed a null deadline. The
corrected assertion passed with the same delay. The temporary delay was removed,
and all 14 cleanup tests passed against an isolated PostgreSQL database. The
existing external test-database hook is carried at the stack foundation so
intermediate branches can use this same verification path.

An initial attempt at the foundation could not start embedded PostgreSQL because
that earlier branch lacked the external fixture hook. A broader fixture wait for
all idle holds to clear then failed three cases that legitimately retain pending
cleanup obligations. That wait was removed. Only the historical deadline assertion
changed; its requirement is now a deadline strictly in the future. The complete
suite passes with the original readiness and idle-hold behavior preserved.
