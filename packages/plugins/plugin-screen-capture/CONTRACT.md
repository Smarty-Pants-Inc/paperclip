# Screen capture: accepted read-view + atomic claim contract

This consumer uses the existing plugin DB seam, **not a new host claim API**. It supersedes the earlier draft `screenCaptureClaims` port. Source baseline: `af35d75bcff2023be2cc68d56c18aea541e3da55`. Paperclip-lead owns the reads spec and later image forwarding. Hosts-lead owns this consumer. RFL's 14:16Z conditions supersede the original same-transaction requirement, although the claim below repeats the reads in its own one-statement transaction.

## Adopted/documented surface

`doc/plugins/PLUGIN_AUTHORING_GUIDE.md:294-314`, “Plugin database declarations”, explicitly permits migrations to reference whitelisted public core tables for read-only views and permits namespace-local runtime INSERT/UPDATE/DELETE. `server/src/services/plugin-database.ts:204-242` validates that migration path; :245-272 restricts query to SELECT; :274-302 permits own-namespace writes; :555-570 executes each runtime statement separately. No BEGIN/COMMIT, public INSERT, raw credential, private server import, migration backfill at runtime or validator bypass is used.

The native SDK tool handler gets host ToolRunContext. It cannot accept a run/user/message as a tool argument: forged extra arguments are REFUSED with `invalid_arguments`, not silently ignored; they never replace trusted identity. BOARD-set instance config pins companyId, principalUserId, primaryAgentId; there are no production defaults or inferred IDs. The package has no Mac host/issuer/token configuration or activation flag. Test IDs are synthetic fixtures only.

## Exact DDL, statement and index set

Executable DDL: [migrations/001_screen_capture.sql](migrations/001_screen_capture.sql).
Executable statements: [sql.mjs](sql.mjs), `CLAIM` and its verbatim `eligibility` expression.

- `capture_facts`: body-free view over agents, issues, issue_comments, heartbeat_runs. Every join and correlated comment read includes the run's company_id. It projects IDs, author IDs/kind, deletion flag, message creation time, ownership/status, newer-person/later-agent booleans and the three wake audit labels. It never exposes comment bodies, whole context_snapshot/presentation, names or credentials.
- `capture_claims`: wake_comment_id PRIMARY KEY is the once-per-message authority; attempt_id UNIQUE ties a result to the one winning invocation. Stores company/run/agent/comment/author/conversation, checked_newest_unanswered=true, read_at, expires_at (read_at +120s), wake labels, outcome/reason, in_flight, frame_sha256 (null in stub).
- Unique partial `(company_id, run_id) WHERE in_flight` prevents two different message claims in flight in one run. Finishing never removes the message PK reservation.
- `capture_log`: separate per-attempt journal, indexed by company/run/time, including refusals. A pre-claim refusal never inserts a claim or burns a message.

`CLAIM` is ONE `INSERT INTO <own namespace>.capture_claims SELECT ... FROM <own namespace>.capture_facts ... WHERE ... ON CONFLICT DO NOTHING`. It evaluates ALL accepted read checks fresh in that statement and explicitly predicates f.company_id = $1. PostgreSQL's statement transaction + PK/index conflict resolution is the authority, not a JS pre-read. Only rowCount=1 is a winning claim. No GO token is minted in this build.

Parameters $1 company, $2 run, $3 agent come ONLY from trusted context; $4 principal, $5 primary, $6 configured company come ONLY from BOARD-set config; $7 is a locally generated attempt UUID, not an identity UUID.

## Reads / wake rule

R1-R3: company/run/agent bindings, primary pin, principal responsible user, running state, same primary-principal conversation, wakeCommentId exists in that conversation, structured author_user_id matches principal, no agent author, not deleted.

R4: no later non-deleted person comment and no later non-deleted agent comment in Paperclip's total `(created_at, id)` order (`server/src/services/issues.ts`, comment listing/latest cursor). Both checks use `(candidate.created_at, candidate.id) > (wake.created_at, wake.id)`: at equal timestamps, a higher ID invalidates the wake; a lower ID precedes it. `author_type='system'` or `presentation->>'kind'='system_notice'` is a system note, not an answer. No natural-language body parsing. invocation_source, wakeReason and wakeSource (fallback source) are **logged, NOT eligibility gates**. A continuation/retry with the same still-unanswered person witness may qualify; an answered stale witness is refused.

## Refusal and zero-row contract

All handler refusals return exactly:

> Only Paul can ask me to look at his screen, from his own conversation.

Before claiming, a read of the same view yields a precise failure code, written to capture_log. If the INSERT returns zero rows, the consumer performs ONE fresh read-only classification, never retries or dispatches:

1. Current view failure, e.g. not_paul, not_this_conversation, not_newest_unanswered, deleted, missing_message, cross_company, not_primary, no_person_message.
2. If still eligible and the same company/message PK exists: already_used.
3. Otherwise a current active-run witness: capture_in_flight.
4. If the conflicting state disappeared before classification: claim_not_acquired. This is the exact observed fact (zero rows without a current disqualifier); no guessed historical reason is asserted.

Each is logged with the actual structured author/responsible IDs when visible in this company, run/message/conversation, time, wake labels, outcome/reason and null frame SHA. Cross-company/missing witnesses remain null, never fetched from another company just to classify. An initial durable audit failure refuses without claiming/using a recorder; the SDK logger emits audit-unavailable, and we do NOT pretend a DB log row exists. Unexpected backend details/credentials are not reflected into the reply or logger.

## Recheck at use / deletion race

Immediately before `recorder.use`, re-read the same view and ensure the SAME claimed comment still exists, is not deleted, and remains eligible; check expiry. Failure at use produces no token/capture. Its existing claim stays as failed evidence, in_flight becomes false, and the message is NEVER reopened for automatic retry (hosts-lead accepted this caveat). A lost/unknown external outcome must likewise never automatically issue a second GO. This build has only the no-effect stub.

The check-before-use does not claim to make a DB deletion and a future remote recorder atomic. Future Mac integration must preserve this recheck directly at the dispatch boundary, no intervening unrelated work, and retain uncertainty honestly.

## Stub/result/visibility boundary

The runtime worker wires ONLY stubRecorder. It has no subprocess, SSH, HTTP, local media, token mint or capture activation option. Successful policy qualification returns “No screen was captured and no image was stored. The recorder is a stub.” followed by the explicitly labelled real-capture policy warning. Journal outcome is not_captured; frame SHA remains null. GREEN below always means stub policy qualification, never a minted GO, stored image or capture proof.

The future stored-image success text lives in the single `DISCLOSURE` constant, also used in the tool description: “A capture is stored in this chat's history AND sent to our Langfuse tracing (EU); don't ask while client data is on screen.” The stub shares that constant in its actual returned reply, prefixed “Real-capture policy (not performed here):”; its preceding no-capture statement remains explicit. Refusals stay the one immutable plain line. No tracing settings are changed.

SDK tools are automatically plugin-namespaced (`smarty.screen-capture:screen.capture` before host adapter name encoding), not a shadowing global core tool. The SDK defaults plugin tools to all agents. Existing Tools & Access governance, configured by the operator as below, supplies primary-only agent discovery/execution. No runtime visibility API or gating is invented. A non-primary caller that reaches this handler is still explicitly refused and logged `not_primary` (defence in depth). Board inventory visibility is not an agent authorization claim.

## OPERATOR runbook: primary-only availability (not performed by this task)

Apply only on the GATE TEST company at the coordinated proof time, after M1.4a. Use BOARD authority and the actual configured primary's structured ID. The consumer never changes grants/profiles. Adopted docs: `doc/MCP-ACCESS-GOVERNANCE.md:225-265,458-460`, `doc/agent-configuration-yaml.md:129-170`; the actual entry field is `toolName`, NOT the guide's generic `selectorValue` example. Schemas: `packages/shared/src/validators/tool-access.ts:570-615`. Baseline af35d75b route definitions: `server/src/routes/tool-access.ts:2340,2359,2457,2506`; fork4d30b7f1 equivalents: :2409-2422,2526-2539,2574-2594.

1. `POST /api/companies/<companyId>/tools/profiles`:

   ```json
   {"profileKey":"smarty.screen-capture.primary","name":"Primary screen capture","status":"active","defaultAction":"deny","entries":[{"selectorType":"tool_name","toolName":"smarty.screen-capture:screen.capture","effect":"include"}]}
   ```

2. Bind the returned profile ID ONLY to the configured primary with `POST /api/companies/<companyId>/tools/profiles/<profileId>/bind`:

   ```json
   {"targetType":"agent","targetId":"<primaryAgentId>","priority":100}
   ```

   Alternatively add the exact entry above to an existing dedicated primary profile using `POST /api/tool-profiles/<profileId>/entries` (no profileId field in the entry body). Do not edit a shared profile without reviewing its other bindings.

3. Remove broad admitting paths for every nonprimary. Standard agents get broad `tools:use` by default (`doc/agent-permission-defaults.md:12`). If that broad grant admits this tool, review and preserve their intended access through positive profiles, then BOARD may use `PATCH /api/agents/<nonPrimaryAgentId>/permission-grants` with:

   ```json
   {"permissionKey":"tools:use","enabled":false}
   ```

   See `server/src/routes/agent-permission-grants.ts:16-21,48-50,74-80`. Other allow-all profiles and allow/trust/approval policies can also admit discovery. An exclude in one profile does NOT override another allow path; a company-wide block beats the primary allow, so it is NOT an exception strategy. Explicit nonprimary tool-targeted block policies are an alternative supported governance mechanism, not an invented negative-agent selector. Handle new-agent default grants before admitting future hires; blocking only today's finite roster is not sufficient forever. Do not blindly revoke unrelated intended tool access.

4. Read back `GET /api/companies/<companyId>/tools/profiles/effective/agents/<agentId>` for the primary AND each ops/hire/nonprimary; retain the effective-profile evidence. Then verify governed agent `GET /api/plugins/tools` discovery under each real caller's bound authority: primary sees the exact plugin tool; nonprimary does not. Attempt a denied direct call as nonprimary too. Board inventory is not this proof. The gateway, not the raw in-process dispatcher, enforces discovery/execution governance (`server/src/routes/plugins.ts`, `server/src/services/tool-gateway.ts`; existing regression `server/src/__tests__/tool-gateway.test.ts`, exact-name agent-bound profile test). Cache/session refresh must follow the existing gateway runbook; do not infer current visibility from a stale tool list.

5. Separately exercise the consumer's real nonprimary refusal/audit path in the controlled stub proof before final audience restriction, or via the owners' supported harness. A governance-denied call need not reach the consumer, so do not claim it created a capture_log row. Retain BOTH gateway denial evidence and consumer plain-line + `not_primary` journal evidence. No token, Mac or capture is used.

## Required regression proofs

[test/capture.test.mjs](test/capture.test.mjs) uses an owned disposable REAL PostgreSQL, not an in-memory uniqueness imitation. REDs include stale-retry, newer-person, ops/agent authors, other issue, hire/task, no-witness scheduled/self, deleted/hard-deleted message, cross-company, forged identity args, repeat claim, two genuinely concurrent different-run claims for one message (exactly one winner; loser already_used logged), eligibility change between pre-read/INSERT, and delete-between-claim/use. Also verifies body-free view and audit failure. RFL's person/agent timestamp-tie probes are permanent RED regressions: they check core tuple order, zero rows from the actual atomic INSERT, fresh eligibility and the handler's refusal/audit. Lower-ID tied comments remain eligible.

Scope exception: RFL granted the test-only exception for `server/src/__tests__/screen-capture-plugin.test.ts` in the hosts-lead follow-up brief (2026-11-14, `hl-screencap-fix1-1114/BRIEF.md`). It is the only allowed file outside this package and the existing lockfile importer; no runtime file outside the package is permitted or changed.

Permanent host/SDK coverage: `server/src/__tests__/screen-capture-plugin.test.ts` runs in the existing server Vitest lane. It imports the actual host SQL validators, validates the exact migration/statement strings and manifest, and registers the actual worker through the SDK harness, including logged non-primary and forged-argument refusals. Its DB adapter is mocked; it is NOT a substitute for the focused real-PostgreSQL concurrency receipt. The package's native PostgreSQL suite is not automatically selected by the root Vitest projects list.

The host validator conservatively scans SQL qualified references. Parenthesizing the column expression in `IS DISTINCT FROM (f.conversation_id)` preserves PostgreSQL null-safe comparison semantics and avoids misreading `FROM f.conversation_id` as a schema reference. The real host validator test reproduces and covers this compatibility constraint; no host validator is changed or bypassed.

Negative controls supported by the fixture: `SCREEN_CAPTURE_TEST_MUTANT=stale` removes unanswered protection; `...=double` removes the message PK. The corresponding focused test must FAIL, then pass without mutation. These are regression-detection demonstrations, not changes to deployed source.

Run on an admitted work host with Node24 and PostgreSQL18:

```sh
SCREEN_CAPTURE_TEST_EVIDENCE=/absolute/retained/evidence \
  bash test/run-postgres-tests.sh
```

The runner creates a private 0700 cluster/socket (peer auth, TCP disabled), stops only that cluster and removes its synthetic DB data. Init/start/server/cleanup logs are retained outside the disposable directory. No agent trace is deleted. Official commands: https://www.postgresql.org/docs/18/app-initdb.html and https://www.postgresql.org/docs/18/app-pg-ctl.html .

## Remaining acceptance, explicitly NOT done here

No deployment or live GATE proof by this task. After M1.4a, testing-lead coordinates TEST company 09c3c41e-3b10-4a12-a9bf-cc4fa9c6c8f4 through hosts-lead, stand-in principal from gate-ops@smartypants.invalid's structured ID (not this name). Ops/hire asks must be refused, no token minted, and capture_log rows checked through the actual tool path; independent/video evidence per docs/video-proof.md. Do not write Paul's company before his read.

No m4, no grant request, no capture rehearsal. m5's first actual capture is Paul's own ask after the move. Capture transport, approved HQ issuer class, ledger token link, one actual image result (not base64 text), deletion of run.mov/outdir and truthful stored-image reply remain a later integration. The recorder issuer patch is a separate owners-only PROPOSAL, not applied by this package. No Ryzen1 production dependency is added.
