# SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119 — qualification

The three person-facing words and real-route proof are in the companion record.
This is a qualification report, **not an all-green or deployment-acceptance claim**.

- Comparison base: `98ea9cee1513f676eea8b1aa8aeef56faed6e8b2`.
- Tested source commit: `ce335779446d078de680c6e05e2375a9d600a6f9`.
- 47 file rows: 45 baseline commands and 47 head commands, each file alone with one Vitest worker.
- 40 base-green/head-green; two new head-only green files; three base-red/head-red files; one optional S3 file skipped at both revisions.
- One base-green/head-red: `server/src/__tests__/issue-recovery-assignments.test.ts`, case `starts the agent's queued task when its run ends and frees the agent`. Its teardown expected no coordinator errors but received two entries. The JSON reporter does not serialize their values; the underlying cause is unverified. This red remains a finding, not waived or called a copy regression.
- The three baseline-red files are `issue-recovery-conversations`, `issue-recovery-dependencies`, and `issue-recovery-pass-reads`. See the separate per-case reasons in the evidence handoff.
- Later red files use `--bail=1`; later unexecuted cases may be absent from reporter totals and are never counted as passing. Green files execute every non-skipped case.
- The S3 skip is the existing `PAPERCLIP_TEST_S3_ENDPOINT` prerequisite, not a passing migration proof; no endpoint or credentials were fabricated.
- Separate base/head transformed-module caches reuse compilation only, not test results, DBs or process state.
- End-only UI typecheck passed (18.41 seconds). Full server typecheck failed with 38 diagnostics, including the newly added route test's unsupported `spawnSync` option `detached` at line 71. That diagnostic is not waived or called pre-existing; the other diagnostics were not baseline-typechecked.
- **BLOCKED: memory-budget violation.** The full server typecheck's sampled owned process-tree RSS peaked at 6,534,828,032 bytes, above the binding 4 GB budget despite the intended Node/Go limits. No host-cause claim is made. The regression peak was 3,651,047,424 bytes and UI typecheck peak was 3,930,497,024 bytes. No further heavy job was started after measuring the violation.
- The evidence handoff contains `regression.tsv`, `regression-findings.md`, per-command JSON/stdout/stderr/cleanup receipts, and end-only server/UI typecheck receipts. All owned job groups were stopped. The initial server typecheck attempt failed before checking because nested `pnpm` was missing; a private scratch PATH shim resolved that setup error before the full attempt.
- Local controlled route/producer rows and jsdom renders are not live daily-work-org, external-provider, deployed-instance or browser-layout acceptance.

The final qualification commit adds only this record; production code and test inputs remain those of the tested source commit.
