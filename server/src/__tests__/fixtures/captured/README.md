# Private captures load by path

Captured data, even redacted, must never be committed to this public fork.
Captures load by path from R1 or an approved private store; no capture data lives here.

Run `captured-fixture-postgres.test.ts` with either:

- `PAPERCLIP_CAPTURE_DIRS=/private/take-a,/private/take-b` (comma-separated capture directories), or
- `PAPERCLIP_CAPTURE_ROOT=/private/captures` (every immediate subdirectory containing `MANIFEST.json`).

`PAPERCLIP_CAPTURE_DIRS` takes precedence when both variables are set. Invalid,
empty, or unreadable configured paths fail rather than silently skip. With neither
variable set, captured cases skip with a message naming both variables. The default
run loads only the hand-written seven-row fixture at `../synthetic/capture-loader/`
through the real migrated embedded-PostgreSQL harness.

`CAPTURE_DEMO_RED=1` retains the opt-in failing invariant for gate2 captures; it
is failure-state evidence, not a product fix. Only use trusted private manifests:
the round-trip helper executes their SQL in the disposable harness.

Private store: `Smarty-Pants-Inc/smarty-agent-files`, under `captures/<name>/`,
with a `MANIFEST.sha256` per capture (factory-lead follow-up; replaces
"private store: TBD by factory-lead (org 09:46Z)"). Only the seven explicitly
approved GATE captures are stored there; never publish fresh captures there.
This forward-only removal does not remove data from earlier commits; no history
rewrite is performed.
