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
- Each failed write is logged without its raw SQL/provider error and retried
  once immediately. A second failure retains the whole batch, propagates from
  explicit flush, and establishes a new one-second recovery deadline. Records
  are removed from memory only after confirmed insertion. There is no sampling
  or maximum-count truncation; a prolonged database outage can grow the queue.
- Usage timestamps are advisory. A process-wide per-DB debounce queues no more
  than one touch per secret per hour. The eventual conditional UPDATE also
  requires `last_resolved_at IS NULL` or a value older than one hour, including
  across processes. It does **not** change `updated_at`. No usage UPDATE or
  audit INSERT is awaited by ordinary runtime resolution.
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
not row locks. Cache hits do not re-resolve or create another resolution audit;
one fill produces one event. A failed fill is evicted, and a stale failure
cannot evict a newer revision. Secret material is held only in the server heap
and is never added to keys, logs or persisted configs.

## Regression evidence

`secrets-warm-resolution.test.ts` uses real PostgreSQL locks and the normal local
encrypted provider to prove 20 resolves complete while the secret row is locked,
and that a locked audit table does not delay resolution. After explicit flush it
requires exactly 20 distinct audit records, one usage UPDATE across the debounce
window, and unchanged `updatedAt`. The same suite exercises the real sandbox
config resolver 100 times concurrently, requires one provider resolution, then
checks rotation, config/metadata invalidation and binding revocation.

The queue and cache suites cover TTL, failure eviction, ambiguous-commit retry,
retained counts after both write attempts fail, records arriving during flush,
shutdown recovery, caller-owned transaction rollback, one-second/100-event
batching and quiet settled state.
These are data-safety and recorded warm-turn row-contention regressions. They
are not a claim of a deployed Boat wake-to-start latency improvement; that must
be measured on the real company after the candidate is integrated.
