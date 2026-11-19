# Captured gate states — real PostgreSQL only

READER: testing-lead and builders consuming the captured P0 states.

These fixtures contain persisted gate rows, not invented state. Their source issues,
windows, snapshot times, schema fingerprints, exact SQL and hashes are in each
`MANIFEST.json`. Each take's README distinguishes the reported screen state from
what the exporter actually observed. This is test support, not a product fix.

| Fixture | Gate | Total rows | Run events | Runs |
| --- | --- | ---: | ---: | ---: |
| `gate2-p0-before` | 2 | 1,121 | 1,043 | 3 |
| `gate2-p0-repeat` | 2 | 1,121 | 1,044 | 3 |
| `gate4-steer-hand-v1` | 4 | 356 | 328 | 2 |
| `gate4-after-end-fail-v1` | 4 | 1,231 | 1,157 | 4 |

The gate4 steering fixture preserves every seq260–320 event, including ack265,
userMessage271, agentMessage296 and final310. The after-end fixture preserves
all 468 + 289 + 400 events of the three requested runs. Forward FK closure can
also require other runs outside the window; those are not misrepresented as
additional whole-event captures. Empty JSON arrays mean zero selected rows,
not missing exports. Held-comment state lives in `agent_wakeup_requests.payload`
(`executionWait` / `queuedCommentInterrupt`); `decision_queue_items` is also
exported and has zero rows in these takes. Leases are `environment_leases` and
`execution_workspace_runtime_leases`.

## Run

Use the repository's Node >=24.11.0 and normal pnpm workspace setup. From the repo root:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/captured-fixture-postgres.test.ts --reporter=verbose
CAPTURE_DEMO_RED=1 pnpm --filter @paperclipai/server exec vitest run src/__tests__/captured-fixture-postgres.test.ts --reporter=verbose
```

The first command must pass all applicable checks; deliberately failing product
invariants are opt-in. The second must fail exactly the two gate2 no-reconciliation
invariants (`expected 0, received 1`) while the round-trips and captured-state checks
pass. Gate4 steering/after-end assertions are not that gate2 product invariant.
Unsupported real PostgreSQL is a failure, not a skip or a mock fallback.

## Load into your own red

```ts
import { loadCapturedFixture, assertCapturedRoundTrip } from "./helpers/load-captured-fixture.js";
// db comes from the existing helpers/embedded-postgres.ts harness + normal migrations.
await loadCapturedFixture(db, fixtureDir);
await assertCapturedRoundTrip(db, fixtureDir);
// Your real-boundary red starts here. No fake executor/queue/DB substitutes.
```

Use a **fresh test database only**, never a live DB. The loader verifies file hashes
and the ordered-column schema fingerprint, plans row-level FK order, inserts exact
IDs, NULLs only nullable non-PK edges that actually form cycles, then restores their
exact values inside the same transaction. Constraints and triggers stay enabled;
nothing is deferred, disabled or altered. Missing closure, collisions, failed CHECKs
or an unbreakable NOT NULL cycle roll back rather than rewrite the evidence. A
NOT NULL cycle reports its FK name and edge before the first INSERT.

Schema skew is refused unless `columnMapping` pins both `sourceFingerprint` and
`targetFingerprint`, with explicit `tables` entries for every changed table. A
column maps to a target name or `null` (deliberate omission); captured primary keys
cannot be omitted. This is not an unrestricted bypass. The original-SQL round-trip
is for the original matching schema, not an automatic migration of captured SQL.
That check executes the byte-identical original WITH…SELECT in a real read-only
transaction and compares JSONB multisets per table (including duplicates), with no
JavaScript-number precision loss. A separate event-sequence assertion checks order.
The local re-export has a 60-second budget; live export routes retain their fixed
15-second limit. One earlier local 15-second timeout is retained in the R1 report.

## Privacy and load-only identity fields

No message text is retained. Unknown strings are recursively replaced with
`<redacted:N chars>` **inside PostgreSQL, before crossing the gate connection**.
Issue comment bodies, run-event text, prompt bodies, wake-message text, other
human labels and free text are placeholders. IDs, machine states/codes, timestamps
and the event structure/ordering survive. Secret/token/password/credential/API-key
columns and secret-named JSON subtrees are omitted; credential tables are not
exported. A required credential reference causes refusal instead of a broken
closure. MANIFEST `redactions` and `excluded_columns` enumerate the actual paths.

`user.json` contains IDs only. Harness rows get `captured-user-<id8>` and
`captured-<id8>@capture.invalid`; `email_verified` comes from PostgreSQL DEFAULT
false. The installed schema has no defaults for its NOT NULL `created_at` and
`updated_at`, so the load-only fallback is deterministic `1970-01-01T00:00:00Z`.
All five fields are explicitly labeled **synthesized for load, not captured** in
the MANIFEST redaction list; the loader refuses undocumented user synthesis.
The original selection SQL re-exports only the user ID, never those placeholders.
No other identity-only table required synthesis in these takes.

These captures are current persisted evidence selected by a time window plus
forward FK closure. They cannot reconstruct deleted rows or historical versions.
The exporter did not re-observe a browser screen. Installed-image metadata was
not available through the authorized database-only route, so it is explicitly
unprobed rather than guessed. The supplied installed-line commit is the branch
base, not a claim that deployment metadata was independently verified.
