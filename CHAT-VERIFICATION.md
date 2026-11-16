# Full chat integration receipt

Item 4 of the bounded mergedown-fix brief. No chat assertions or chat production code were changed by this task. Full per-test comparison and untruncated failures are in the kept task artifacts, not omitted for brevity.

- Base: `a763d193f89d9e25abe3e06edb86b411f04951f4`: 2,043/2,047 passed, 4 failed, 0 pending.
- Tested merged production head: `c75d4d482bbf98b3ad83a1cdcf92d20741583605`: 2,036/2,054 passed, 18 failed, 0 pending.
- Exactly one file per Vitest call; `--maxWorkers=2`; no name filter; isolated embedded PostgreSQL and the suite's fake provider dependencies; not live chat-provider qualification.
- Observed name/status classification: 13 pass→fail; 3 fail on both; 1 fail→pass; 13 new rows (2 failing); 6 old names absent; 2,024 unchanged passes. Name absence is not a waiver or a test deletion made by this task.
- These are observed status differences, not proven causal attribution to #20806. No retries overwrite the full-file receipts. The candidate is NOT a green release qualification.

## Kept evidence

- `/srv/scratch/paul/tasks/direct/mergedown-fix/artifacts/CHAT-PER-TEST.md` (SHA-256 `9c69cf41829e17e2d3315f0bd59894b7b22f5ee727e8a3d4555bda4c91df2fa9`).
- `/srv/scratch/paul/tasks/direct/mergedown-fix/artifacts/CHAT-PER-TEST.tsv` (SHA-256 `0359707896a8c087bb393916124fd56f27bb1ac2ba41869186fd6230f261dfd8`).
- Raw complete reports, logs, command/revision/exit receipts: `/srv/scratch/paul/tasks/direct/mergedown-fix/artifacts/tests/chat-base/` and `/srv/scratch/paul/tasks/direct/mergedown-fix/artifacts/tests/chat-head/`.

## Candidate-only failures (base passed)

- chat channel control-plane integration reconciled chat retry delivery ownership keeps one exact chat delivery owner through concurrent reconciliation
- chat channel control-plane integration reconciled chat retry delivery ownership keeps one exact chat delivery owner through lost_scheduler_receipt reconciliation
- chat channel control-plane integration reconciled chat retry delivery ownership retains the sole owner but refuses its deferred dispatch after revoked_principal
- chat channel control-plane integration reconciled chat retry delivery ownership retains the sole owner but refuses its deferred dispatch after closed_conversation
- chat channel control-plane integration reconciled chat retry delivery ownership does not resolve or mint a substitute owner for revoked_principal
- chat channel control-plane integration reconciled chat retry delivery ownership does not resolve or mint a substitute owner for closed_conversation
- chat channel control-plane integration reconciled chat retry delivery ownership does not resolve or mint a substitute owner for missing_source
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: person
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: person_with_input_before_stop
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: person_after_held_admission
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: person_paused_after_accept
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: restart_recovery
- chat channel control-plane integration continues an accepted GitHub task Retry from recovered saved work when its chat replay is refused after the click: restart_recovery_joined_by_person

## Failing new tests

- chat channel control-plane integration GitHub agent review workflow resolves only the secrets a current signed GitHub webhook delivery uses
- chat channel control-plane integration GitHub agent review workflow resolves only the secrets a invalid_signature signed GitHub webhook delivery uses

The subsequent Stop-test typing-only follow-up changes no chat or production input. Final verification separately reruns the changed Stop rows. The remaining differences need lead triage; this bounded task was asked to run and report the full file, not to replace or weaken those assertions.
