# Late-abort lock and source cleanup are different lifecycles

At `44a82e6e`, `agent-directory-working-copies.ts`'s `serial()` releases its
PostgreSQL session advisory lock in `finally`, through `releaseOperationLock`.
A too-late abort keeps that operation joined while the canonical write is
landing/being recorded. Once the operation settles, explicit unlock runs on the
same dedicated session. If unlock cannot be proven within 2 seconds, that
session is ended rather than cached while holding the lock.

The comment in `collectStopped()` saying the cleanup worker releases a saved
copy refers to source-directory cleanup, not to releasing this advisory lock.
`registerDirectoryCleanupWork()` in `agent-instruction-working-copies.ts` uses
`registerScopedDeadlineWork()` to reconstruct eligible receipts and invoke
`directories.release()`. That operation acquires its own advisory lock before
cleaning the source. It cannot be the owner that releases a previous operation's
session lock.

The cleanup worker has no fixed sweep period: it responds to committed
notifications and persisted deadlines. Its generic failure/admission retry is
30 seconds; its default minimum pass spacing is 1 second. Neither is a maximum
cleanup period. Tests must not call them a sweep period.

The late-abort test file exercises real collection, apply, persistence and
PostgreSQL, with lock observations through an independent pool. The R9 rows
measure from the real apply settling to a successful independent lock probe,
before admitting cleanup. They then run the real cleanup worker normally, or
leave its boot admission retry scheduled for 30 seconds before allowing it.
Real timers are used; there is no direct call to release or worker.run, and no
replacement scheduling implementation. Source cleanup and lock acquisition are
observed separately. The observation slack is 500 ms on top of the real 2-second
unlock timeout, not an invented worker period.

The object store is an in-memory stand-in; sandbox commands are real local
child processes. These rows are local source-checkout evidence, not a deployed
provider or production-agent verification. The evidence includes PostgreSQL's
reported version and distinct collector-pool/observer-pool backend PIDs.

The release mutations distinguish the two lifecycles: skipping the real cleanup
worker's release only for too-late-abort copies fails source removal/receipt
assertions, but the independent lock probe still succeeds. Skipping the
collector's own unlock fails the independent lock probe/timing assertions.
A red source-cleanup mutation is not evidence that this worker owns the
collector's PostgreSQL session lock.
