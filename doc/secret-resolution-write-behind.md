# Runtime secret resolution: deferred bookkeeping

Secret resolution checks the company, binding, active secret and selected version
before asking the existing provider for its value. Usage bookkeeping must not
make a warm runtime turn wait for a lock on the parent secret row.

The existing custody contract is unchanged: [Secrets Management, Custody
Boundaries](../docs/deploy/secrets.md#custody-boundaries) requires one non-sensitive
audit event per resolution. `secret_access_events` has no aggregation/count
column, so this implementation batches individual rows, never samples them.
It is a fix to the owning secret/environment runtime modules, not a plugin
policy or a new provider/extension contract. There is no documented operator
setting that removes these awaited bookkeeping writes or caches environment
provider credentials.

## Writes and lifecycle

- The normal pool-based resolver queues value-free success/failure audit rows.
  Every queued row receives its own UUID and resolution-time `createdAt`.
- The first enqueue establishes a one-second deadline on the existing work
  scheduler. A batch of 100 events advances it to now. A flush sends at most
  100 rows per INSERT and uses `ON CONFLICT (id) DO NOTHING`, so a retry after an
  uncertain commit cannot duplicate an audit event.
- A foreign-key violation retries the batch in a transaction that nulls missing
  optional secret, user-secret definition, issue, run and plugin references.
  Existing reference rows are key-share locked through insertion, so concurrent
  deletion cannot reopen the check/write gap. Every event keeps its original UUID,
  timestamp and non-reference metadata, including unrelated healthy handoffs.
  Required company scope is never nulled or reassigned; a missing company remains
  an explicit persistence failure. Agent and environment identities are not
  foreign keys in this audit table. Recovery adds no queries to successful batches.
- Each failed write is logged without its raw SQL/provider error and retried
  once immediately. A second failure retains the whole batch, propagates from
  explicit flush, and establishes a new one-second recovery deadline. Records
  are removed from memory only after confirmed insertion. Events plus advisory
  touches (including in-flight writes) share a 10,000-record per-DB capacity.
  At capacity, enqueuers await space released by successful writes and recheck
  capacity before admitting a record; failures retain the backlog and existing
  recovery deadline. There is no sampling, truncation or dropping on overload.
  Waiting producers retain their obligations and cannot finish resolution until
  admitted; this bounds the queue, not the number of upstream requests.
- Usage timestamps are advisory. A process-wide per-DB debounce queues no more
  than one touch per secret per hour. The eventual conditional UPDATE also
  requires `last_resolved_at IS NULL` or a value older than one hour, including
  across processes. It does **not** change `updated_at`. No usage UPDATE or
  audit INSERT is awaited below capacity; overloaded resolution waits for space.
- Pending writes hold the existing idle-work admission blocker. No pending
  writes means no deadline, SQL or network activity. Server shutdown stops its
  producers first, then awaits the queue before closing DB clients. The drain
  keeps only the pending retry deadline alive. If the database stays unavailable,
  orderly shutdown waits for recovery instead of silently discarding audits.
- An explicit `listAccessEvents` flushes pending writes for read-your-writes.
  Caller-owned Drizzle transactions retain their existing synchronous audit
  INSERT, because a queued callback cannot safely use a transaction after it
  closes; they do not perform the advisory usage touch. Read-only environment
  inspection still emits no tenant writes and bypasses the runtime cache.

This is an in-process queue, not a durable outbox. SIGKILL, host loss or an
external shutdown deadline that kills the process can lose unflushed events.
The accepted trade-off is normally up to about one second of rows; backpressure
bounds their count, not their age during a database outage.
Deployments requiring crash-durable audit delivery need a durable outbox;
this change does not claim that property.

## Environment provider credential cache

Schema-declared provider secret references are resolved at
`environment-config.ts:resolveConfigSecretRefsForRuntime`, reached through
`resolveEnvironmentDriverConfigForRuntime` by sandbox runtime operations and
execution-target provider calls. Only those resolved credentials are cached;
prepared run config, custom-image selection and SSH credentials are not.

The cache has a 60-second TTL, a per-DB bound of 1,024 entries, and single-flight
fills. The key includes company, environment, config path and secret ID. Each
call uses the existing metadata-only `resolveSecretVersionIdentity` to recheck
the live binding, secret status and version revocation. Its revision also
includes the secret's `updatedAt`, complete stored provider config, schema and
current provider-vault metadata. Thus rotation, secret metadata/status changes,
provider-vault changes, binding revocation and environment config changes
invalidate without waiting for TTL,
even when the write happened in another process. These are ordinary SELECTs,
not row locks. Cache hits do not re-resolve the provider but every handoff,
including every waiter on a shared fill, queues its own access event with that
call's environment, config path, issue/run and actor context. Validation and
provider failures likewise queue one failure event per caller. The owning
secret service keeps validation, cache access and audit in one boundary; shared
fills emit no additional event. Caller-owned transactions bypass this cache and
retain synchronous atomic auditing. A failed fill is evicted, and a stale failure
cannot evict a newer revision. Secret material is held only in the server heap
and is never added to keys, logs or persisted configs.

## Regression evidence

`secrets-warm-resolution.test.ts` uses real PostgreSQL locks and the normal local
encrypted provider to prove 20 resolves complete while the secret row is locked,
and that a locked audit table does not delay resolution. After explicit flush it
requires exactly 20 distinct audit records, one usage UPDATE across the debounce
window, and unchanged `updatedAt`. The same suite exercises the real sandbox
config resolver 100 times concurrently, requires one provider resolution and
100 events with distinct run contexts, then checks rotation, config/metadata
invalidation, version revocation and binding revocation with failure auditing.

The queue and cache suites cover TTL, failure eviction, ambiguous-commit retry,
retained counts after both write attempts fail, records arriving during flush,
shutdown recovery, caller-owned transaction rollback, one-second/100-event
batching and quiet settled state. Stalled and failed INSERT tests hold 10,050
producers at 10,000 admitted records, then require all unique events on recovery;
a mixed touch/audit test proves the shared capacity also bounds usage metadata.
`secret-resolution-deletion.test.ts` resolves through the real secret service,
removes an issue through `issueService.remove`, then requires both that handoff
(with a null issue reference) and an unrelated healthy handoff to persist and drain.
It also deletes each other nullable FK target and all targets together, preserving
live references. A recovery-commit/connection-loss case requires retry without
duplicates. These tests cover data safety at the real PostgreSQL persistence boundary.

These are data-safety and recorded warm-turn row-contention regressions. They
are not a claim of a deployed Boat wake-to-start latency improvement; that must
be measured on the real company after the candidate is integrated.
