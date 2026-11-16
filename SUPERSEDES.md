# custody-e: recorded replacements, not relaxed expectations

Authority: `FINDINGS-CUSTODY-RFL.md`, RFL ruling 05:56Z 2026-11-16,
items 1–4, plus review-fleet-2's 05:54Z tightenings in both findings files.
Base: ee141ae2c9d83865b9abb310c1c3b83356ac7b31.
Continuation start: 80270c05f2596d290352af2765e8084feae5017b.

## 1. Reservation rule 4 (REPLACED, not augmented)

Old: another project's receipt-citing create always collides with S.
New: for receipt-citing creates on the same installation OR registration,
only owned rows decide the existing arbiter's exclusivity result. Each create
consumes ONLY its own exact S. The loser retains its source and unused receipt.
Ordinary non-receipt creates retain the existing source alias/reservation check.

`project-app-custody-consume.test.ts` RED 2 is replaced by the ordinary
non-receipt EXCLUSIVE arbiter check for BOTH projects, exact
`installation_not_exclusive`, no owned rows and no consumption activity.
Three new real-create races prove exclusive-first and both alias orders, one
EXCLUSIVE owner, exact collision code, unchanged losing S and one consumption.
The seven INT-A2/A3 drivers and their expect statements are UNCHANGED.

## 2. Nine admission zero-residue cases (REPLACED, exactly zero)

File: `server/src/__tests__/project-connections-admission.test.ts`.
Genuine setup uses C4's board-session config route, the source connection POST
and H's approval POST. First the fixture-only commit changes NO expect statement.
Then each case snapshots AFTER setup and BEFORE the action. Each original zero
row check below becomes an EXACT zero count delta (`toBe(0)`), never a bound.
`setupSnapshot` adds ONE exact assertion of connection IDs (S plus explicitly
seeded owned rows), sole unowned source S and exactly these activity actions:
`plugin.config.updated`, `tool_connection.created`,
`tool_connection.project_app_approved`. Extra setup rows fail this assertion.

| Named case | Old -> new |
| --- | --- |
| J19: another member's private primary and a mismatched responsible human cannot first-bind | company connections length 0 and activity length 0 -> connections delta 0 and activity delta 0 |
| A05/M02: primary changes during provider verification refuse before reach | installs length 0, profiles length 0, activity length 0 -> each table's post-setup delta 0 |
| A05/M02: lead changes during provider verification refuse before reach | same three zero counts -> each table's post-setup delta 0 |
| A05/M02: recipient changes during provider verification refuse before reach | same three zero counts -> each table's post-setup delta 0 |
| A05/M02: key changes during provider verification refuse before reach | same three zero counts -> each table's post-setup delta 0; fixture mutation is genuine current key version + 1 (3, not post-approval 2) |
| A05/M02: returned-repository changes during provider verification refuse before reach | same three zero counts -> each table's post-setup delta 0 |
| A05/M02: identity changes during provider verification refuse before reach | same three zero counts -> each table's post-setup delta 0 |
| J02/A05: preserveExistingAccess checks the final recipient union, not only the new worker | company activity length 0 -> activity delta 0; original exact retained-install assertion unchanged |
| J11/B-RF2-0036-integration: real running-work gate rolls back lead and every retained approval | company activity length 0 -> activity delta 0; original 409/code and retained-project/envelope assertions unchanged |

## 3. J19 exact refusal replacement

RFL expressly replaces ONLY the removed handoff code:
`project_connection_human_handoff_required` -> EXACTLY
`project_app_approval_required` in
`J19: missing trusted handoff refuses even H's real primary; installer labels are not proof`.
The original trigger remains no human approval; installer labels remain non-proof.
No key resolver/provider-scope call and no action-written row remain required.
The manager-only setup is a genuine C4 session write, with NO source and NO
receipt. Its sole `plugin.config.updated` activity is asserted exactly before
the action. The original zero connection assertion stays literal zero. Zero
NEW activity rows is asserted with `toHaveLength(0)`, AND full before/after
activity equality preserves every setup row. This is J19's separately granted
nothing-written replacement, not an additional admission delta supersede.

The other three admission codes and two provider local-denial codes are NOT
superseded: product guard order/catch scope restore the original exact codes.
No other existing expectation may change.
