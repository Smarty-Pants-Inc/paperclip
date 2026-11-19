# Synthetic capture-loader self-test

Exactly seven hand-written rows: one company, agent, issue, run, wake request,
run event, and recovery action. No capture was used to generate these rows.
There are no message bodies, users, credentials, real identities, or live-server
values. UUIDs are deliberately `00000000-0000-4000-8000-00000000000N`.
The run-event primary key is the integer `6` because its real database column is
`bigint`, not UUID.

The issue references the run and the run references the issue, exercising the
loader's nullable-cycle restoration with constraints enabled. Unspecified columns
use normal harness defaults. The SQL reselects precisely the hand-written columns
and IDs, then the loader compares each table as a JSONB multiset.

The MANIFEST schema metadata was queried from a fresh migrated embedded-PG
harness, not copied from a capture. Its fingerprint uses the loader's method:
order information_schema columns by table name and ordinal position, serialize
recursively with sorted object keys and compact JSON separators, then SHA-256 the
UTF-8 bytes. Table-file hashes cover exact bytes (including the final newline);
`sql_sha256` covers the exact SQL string. Schema metadata is larger than the seven
rows because the loader intentionally fingerprints every column of each table.
