# Unaddressable native lease custody

A box retained because its native harness copy is unverified is still a custody
obligation, regardless of lease policy. It remains visible in environment
management and prevents environment deletion, including consented teardown.

After five failed settlements, the existing retained-orphan owner emits
`custody_unpinned_alarm` with `boxId`, `providerLeaseId`, `companyId`, and
`alarm: "first"`. A durable per-box ledger suppresses repeats across sweeps and
holders. Existing capped rows without the ledger emit the alarm on their next
reconciliation.

Six hours after the obligation was recorded, that same owner schedules one
stop-and-keep attempt. The runtime resolves only the current environment provider
configuration, requires exactly one installed provider declaration, inspects the
exact provider lease, and checks the provider's own `boxId` against the recorded
box before stopping. It never acquires, resumes, releases, or destroys on this
path. Older plugins without inspection `boxId`, any mismatch or refusal, or an
indeterminate expired stop claim emit one `alarm: "manual_stop"` warning.
Neither successful stop nor manual escalation releases the retained lease or
its obligation: it remains counted and prevents environment deletion. Provider
calls run outside row/task locks. The existing owner registers the expiry
deadline; this adds no polling owner or timer.
