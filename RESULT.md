# Chat-gap round 13 result — BLOCKED

**Candidate:** `ad/m1-chatgap-r12` at `711d96f66` (base `0058c6da`, on `63b13363`). The test-only RED commit (including F5 title fixes) precedes the production fix commit. No push or GitHub writes.

## Change

- The shared predicate is `server/src/services/recovery/review-path-recovery-escalation.ts:30`; the run-completion wrapper locks/rechecks the issue at lines 75–88, and exhausted escalation calls the same predicate under its existing issue row lock at line 112. Run completion calls the wrapper at `server/src/services/heartbeat/run-lifecycle.ts:2155`; the stranded sweep reaches escalation at `server/src/services/recovery/service.ts:4881`. The round-12 local predicate was removed from `run-lifecycle.ts`, leaving one implementation of the answer rule.
- The predicate requires a non-deleted comment by the current assignee and a matching `chat_publications` row joined to the issue's channel conversation, with `state = 'published'` and a non-null `provider_message_id`. A candidate reply must follow a person message and have no newer person message, ordered by `(created_at, id)`.
- “Person” follows upstream settlement at `slack-conversation-lifecycle.ts:79–84`: `author_agent_id IS NULL`; `coalesce(author_type, 'user') <> 'system'`, or a `chat_message_links` row for that comment and the publication's conversation with `direction = 'inbound'`. This handles legacy null author types and system-typed inbound messages without guessing from metadata.
- Existing settlement was inspected but not used. `settleExternalConversation` / `readSettlement` at `slack-conversation-lifecycle.ts:14–50` only settles an active bound conversation while the issue is `in_progress`; this escalation runs on an `in_review` issue, so settlement returns no eligible disposition. The new check stays under the existing row lock instead.
- The five-line seam explanation is present both above the predicate and in the fix commit message, citing `run-lifecycle.ts:2155`, `service.ts:4881`, `issues.ts:14143–14147`, and upstream settlement/publication evidence.

## Tests and builds

| Check | Result |
|---|---|
| RFL attack + sweep files on unmodified round-12 production source, with corrected fixtures | **71 passed, 6 failed / 77**. Failures: stranded repair-run sweep (F1), A1c, A11, A12, A12b, A13. The r12 sweep still fails its repair-run case. |
| Same attack + sweep files on round 13 | **75 passed, 2 failed / 77**. The sweep file passes **3/3**, including F1. The two attack assertions still expect A9 (no run) and A10 (no presentation decision) to skip. F3 requires no skip without a successful publication record, so the implementation rejects those false positives. The 10:04Z ruling forbids assertion edits; the two failures remain visible rather than weakening F3 or changing RFL assertions. |
| Required RFL/regression group: r4, gate-evidence, r2/r3, judge-chatgap, r7/r8, r2 e2e, review-path, disposition and sweep suites | **252 passed, 1 failed / 253 across 19 files.** The one failure is RFL r4 `unanswered in_review channel-null still receives one real reply via registered recovery`: its fixture has no successful channel publication record, but F3 now correctly does not treat an internal comment as a channel answer. RFL r4 test bytes were not changed (blob `23582b98217b5db3a3f2bd6b4f3954d88200b457`, SHA-256 `803f644595e27646abbcfdb772094d86fb7a96bcd6c0a001376ee1f361152e9a`). |
| Server typecheck (`pnpm --filter @paperclipai/server typecheck`) | **Exit 0** |
| UI typecheck (`pnpm --filter @paperclipai/ui typecheck`) | **Exit 0** |
| Full workspace build (`pnpm build`) | **Exit 0** |
| `git diff --check` | **Pass** |

The single test-only RED commit keeps fixture updates in the adopted attack and sweep files: provider publication rows for fixtures representing published replies (including the sweep repair reply and A12b), plus inbound `chat_message_links` rows for the system-typed A12/A12b messages. No assertions changed; F5 title renames are in that same RED commit. The RFL r4 failure cannot be repaired without changing its byte-identical fixture to add a publication record, which the 10:04Z ruling does not authorize. The A9/A10 assertions also contradict binding F3, while the ruling prohibits assertion changes. Therefore the implementation is delivered, but the full requested verification set cannot be green without crossing those constraints: **BLOCKED** pending an RFL decision on the unchanged assertions/fixture.

## Remaining v3 items

- **F6 (v3):** the round-9 extra assigned-work matrix row is still absent from this branch; the verdict reports 53/53 with that row ported.
- **F7 (v3):** document the basis for the `37289d07` assigned-work source-label special case.
- **F8 (v3):** continue independent RED evidence beyond the adopted attack and sweep regressions; this round adds the real sweep call-site check, while the broader verdict item remains tracked for v3.
- **F5:** fixed in the test commit by renaming the four r2 titles to describe their no-continuation assertions.

## Evidence files

All logs and the patch are kept under `/srv/scratch/paul/tasks/direct/adopt-m1-chatgap13b/artifacts/`. Key files: `r12-fixed-fixtures-red-final.log`, `r13-attack-sweep-final.log`, `regression-suites.log`, `final-build.log`, `server-typecheck-final.log`, `ui-typecheck-final.log`, `adopted-fixture-diff.patch`, and `chatgap-r13.patch`.
