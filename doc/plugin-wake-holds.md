# Plugin wake hold deadline

A deferred `plugin_wakeup` can wait for a plugin in `installed` or
`upgrade_pending` for at most 30 minutes from entry into that status. The
shared constant is `PLUGIN_WAKE_HOLD_MS` in
`server/src/services/plugin-status-transitions.ts`.

The plugin registry records each actual status change in `plugin_logs`, in the
same transaction as the write. The record is instance-level (`companyId: null`),
level `info`, message `status → <to>`, with metadata
`{ kind: "status_transition", from, to }`. An install starts with `from: null`.
Unchanged status writes and failed conditional writes do not add a transition.
Reinstallation and soft uninstallation use the same recording path.

Release admission and the existing deferred-receipt deadline owner read the
latest transition whose `to` matches the plugin's current status. If none exists
(for example, after upgrading an old installation or log retention), they use
`plugins.updated_at` and persist a backfilled transition with that timestamp and
`backfilled: true`. A plugin-row lock serializes this fallback with other readers
and registry status changes. Later unrelated updates cannot move a retained
transition's deadline. The existing seven-day plugin-log retention is unchanged;
if the transition is pruned, the same fallback applies again.

The `deferred` worker includes plugin wakes in its existing receipt selection.
Both startup/event reconstruction and pre-dispatch checking use the saved hold
start plus 30 minutes when the plugin is pending and not disabled for that
company; otherwise the receipt is immediately eligible for normal recovery.
The existing shared scheduler owns the deadline. There is no additional sweep,
timer, table, column, or migration. A due receipt calls the existing scoped
`resumeDeferredExecutionReceipts`, then normal release admission; company,
execution, identity, and Stop/recovery gates remain in force.

In `findNextDeferredWake`, an unexpired plugin receipt is skipped so an ordinary
assignment behind it can still proceed. At or after the deadline, admission
compare-and-sets the receipt from `deferred_issue_execution` to `cancelled` with
`plugin_wakeup_hold_expired`. Only a winning update writes a system notice on
that issue, in the same transaction, guarded by `NOT EXISTS` on
`authorizationReason = plugin_wake_hold_expired:<wakeId>`. The notice names the
plugin, gives elapsed whole minutes, and links to its instance settings.

The notice has `authorType: system`, no author agent or user, no source run, and
`presentation.kind: system_notice`. It is inserted directly, not sent through
the comment route's wake-producing path; it creates no `issue_commented` wake
and is excluded from conversation answer/unread-message counts. Disabled or
unavailable plugins retain `plugin_wakeup_origin_unavailable`, without this
timeout notice. A ready plugin goes through ordinary promotion instead.

## Focused verification

From the repository root, after preparing dependencies:

```sh
pnpm -C server exec vitest run src/services/heartbeat/plugin-wake-hold.test.ts
```

These embedded-PostgreSQL tests exercise the deadline owner's real `load` and
`check` callbacks, queue recovery, run control, release admission, and persisted
effects. Provider dispatch is held. They cover expiry, stable deadlines,
legacy backfill, ready/disabled behavior, ordinary wake fairness, system-note
idempotency, concurrent writes, and transaction rollback. This is not live
provider or deployed-product acceptance evidence.
