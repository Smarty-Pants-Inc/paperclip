# Screen capture: accepted read-view + atomic claim contract

This consumer uses the existing plugin DB seam, **not a new host claim API**. It supersedes the earlier draft `screenCaptureClaims` port. Source baseline: `af35d75bcff2023be2cc68d56c18aea541e3da55`. Paperclip-lead owns the reads spec and later image forwarding. Hosts-lead owns this consumer. RFL's 14:16Z conditions supersede the original same-transaction requirement, although the claim below repeats the reads in its own one-statement transaction.

## Adopted/documented surface

`doc/plugins/PLUGIN_AUTHORING_GUIDE.md:294-314`, “Plugin database declarations”, explicitly permits migrations to reference whitelisted public core tables for read-only views and permits namespace-local runtime INSERT/UPDATE/DELETE. `server/src/services/plugin-database.ts:204-242` validates that migration path; :245-272 restricts query to SELECT; :274-302 permits own-namespace writes; :555-570 executes each runtime statement separately. No BEGIN/COMMIT, public INSERT, raw credential, private server import, migration backfill at runtime or validator bypass is used.

The native SDK tool handler gets host ToolRunContext. It cannot accept a run/user/message as a tool argument. BOARD-set instance config pins companyId, principalUserId, primaryAgentId; there are no production defaults or inferred IDs. The package has no Mac host/issuer/token configuration or activation flag. Test IDs are synthetic fixtures only.

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

R4: no later non-deleted person comment and no later non-deleted agent comment (strict created_at > wake message created_at, per accepted spec). `author_type='system'` or `presentation->>'kind'='system_notice'` is a system note, not an answer. No natural-language body parsing. invocation_source, wakeReason and wakeSource (fallback source) are **logged, NOT eligibility gates**. A continuation/retry with the same still-unanswered person witness may qualify; an answered stale witness is refused.

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

The runtime worker wires ONLY stubRecorder. It has no subprocess, SSH, HTTP, local media, token mint or capture activation option. Successful policy qualification returns “No screen was captured and no image was stored. The recorder is a stub.” Journal outcome is not_captured; frame SHA remains null. Never present this as capture proof.

SDK tools are automatically plugin-namespaced (`smarty.screen-capture:screen.capture` before host adapter name encoding), not a shadowing global core tool. Operators must restrict availability to the primary on the intended company; the server checks still refuse a hire/ops/task that reaches the handler. The current SDK defaults plugin tools to all agents; this package does not invent an availability API. Exact runtime alias/display and availability restriction need owner verification on the move image before readiness can be claimed.

## Required regression proofs

[test/capture.test.mjs](test/capture.test.mjs) uses an owned disposable REAL PostgreSQL, not an in-memory uniqueness imitation. REDs include stale-retry, newer-person, ops/agent authors, other issue, hire/task, no-witness scheduled/self, deleted/hard-deleted message, cross-company, forged identity args, repeat claim, two genuinely concurrent different-run claims for one message (exactly one winner; loser already_used logged), eligibility change between pre-read/INSERT, and delete-between-claim/use. Also verifies body-free view and audit failure.

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
