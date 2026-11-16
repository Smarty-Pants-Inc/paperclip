# Merge-down chat follow-up resolutions — 2026-11-16

This is the tracked follow-up register for the merge of upstream `29903bed59b16a20e1b65f38cd99743e7309cae9` into fork base `a763d193f89d9e25abe3e06edb86b411f04951f4`. No `MERGE-RESOLUTIONS.md` was tracked at starting chat head `03658c43eacc50655be3c89355d752ba6449e5ca`; this location is the fallback required by `RFL-ADD.md`. It supplements, rather than silently edits, the supplied merge-resolution register.

## RFL-authorized supersedes

| Area / file | Previous resolution | Superseding ruling | Exact disposition |
|---|---|---|---|
| B — `server/src/__tests__/chat-channels.integration.test.ts`, six saved-work Retry matrix rows | Follow-up `8a4f97683b5fc3f76a106b64fc172b53a973e163` replayed the stale c2 `NATIVE_CONTINUATION_REFUSED_ACTION` expectation after fork Cut B `928c3f8021a780e0a7c6b89a1d36a353e40d4517` had removed that nextAction gate. | **RFL 12:53Z 2026-11-16 additions, exact replacement authorized in `RFL-B.md` (recorded 12:55Z): YES, equally strict.** Supersedes that stale replay; upstream `a65644d1e17ea359e0fdf2cb6ac7503baabbe6d9` / #21080 and the base already expect recovered-work guidance. | Replace only the matrix's `nextAction` with `"Saved work recovered."`; keep `canRetry: false`, `workspaceRecovery: { message: "Saved work recovered." }` and every later Retry assertion. Rows: `person`, `person_with_input_before_stop`, `person_after_held_admission`, `person_paused_after_accept`, `restart_recovery`, `restart_recovery_joined_by_person`. Remove the now-unused import. No product gate is reintroduced and no product code changes. Full-file verification is required; its receipt belongs with the task evidence, not an assumed green claim in this register. |
