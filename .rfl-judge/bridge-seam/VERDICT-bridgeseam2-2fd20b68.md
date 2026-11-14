VERDICT: NOT OK — v2 fixes the caller boundary and timer overflow, but its advertised 5000 ms maximum can still turn an otherwise successful callback into a non-retryable 504.

# Independent RFL judgment — bridge poll seam v2

- **Candidate:** [`2fd20b68c97eee9810be573ee0fdc67dc6318bd7`](https://github.com/Smarty-Pants-Inc/paperclip/commit/2fd20b68c97eee9810be573ee0fdc67dc6318bd7), `cl/bridge-poll-seam-v2`.
- **Requested baseline:** M1.2 [`4bb64997b15b8f0bf7ffb68cd30742c56a8b08a5`](https://github.com/Smarty-Pants-Inc/paperclip/commit/4bb64997b15b8f0bf7ffb68cd30742c56a8b08a5), **not C8**. Immediate parent `42f0d7870e37eeff464ef0277b048017cea856eb` adds only the previous judgment and judge test.
- **Host/time:** verified `ryzen3`; started **2026-11-14 09:05:28 UTC**; first verdict written **09:20:49 UTC**, before **09:30:28 UTC** (start + 25 minutes).
- **Scope:** bounded configuration seam only. No idle-backoff, lifecycle redesign, unrelated C9 work, production access, credentials, builder contact, other agents, pushes or GitHub writes. All executions completed; cleanup is recorded separately.
- **Approval:** do not ship the configurable 100–5000 range as qualified. With this variable **unset**, the delta retains the baseline's 100 ms behavior and adds no warning. That compatibility is not approval of the advertised configured range, nor proof of C8/C9 production readiness.

## 0. Home and cardinal rule — design first

**Home: (c), the narrowly approved caller-side configuration seam, using upstream's existing adapter-utils option.** It is not a new plugin-owned scheduler and not a demonstrated Paperclip core bug under (d). The generic adapter utility remains the owner; no provider-specific adapter protocol is added to server core.

Five-line design assessment:
1. The implemented plugin/runner contract does not give a sandbox-provider plugin a parameter for the host-owned callback worker's sleep interval; changing plugin environment cannot configure the host timer.
2. Upstream already exposes `startSandboxCallbackBridgeWorker({ pollIntervalMs? })`, with a 100 ms default; there is no missing worker option to invent.
3. `execution-target.ts` is the production construction site. Read and validate the one host setting there, then pass that existing option. V2 now does this.
4. Leave scheduling, request authorization, finalization, cancellation and ownership in their existing modules; do not read this environment variable inside the shared worker. V2 follows this boundary.
5. Other consumers are exec-backed `queue_v1` targets, including SSH and sandbox providers: the trade-off is provider listing cost versus callback latency, not new run/lease ownership.

**Upstream intent:** original bridge commit [`a4ac6ff133fbe8bdb82f4046fda85f7cb372b6a9` / #4801](https://github.com/paperclipai/paperclip/commit/a4ac6ff133fbe8bdb82f4046fda85f7cb372b6a9) states that remote agents need to post progress/comments/status through the bridge and adapter launch owns its lifecycle. [Retained original commit](upstream-original-bridge-commit.txt). The existing optional interval, normalization, caller and watchdog implementation are linked with exact line excerpts in [source-evidence.md](source-evidence.md).

**Fresh upstream check:** fetched `paperclipai/paperclip` master **`009c8884a4fee1ef7e406ea03fdadd4ac7c40d08`**. Current source still has the option but no host-variable pass-through. Interval-related history identifies the original bridge and transient-recovery/transport changes, **not a merged fix for this configuration seam**. [Master receipt](upstream-head.txt), [history](upstream-poll-history.txt), [source search](upstream-interval-search.txt).

- [Upstream #18635](https://github.com/paperclipai/paperclip/issues/18635) is still an open report of the missing pass-through, not an implemented fix.
- [Upstream PR #15696](https://github.com/paperclipai/paperclip/pull/15696), head `c41f9b168f0cad1b5e2f1a27c0c350b758d2beeb`, is still **open/unmerged**. It proposes remote long-polling plus timeout/lifecycle changes, not an already-merged commit to adopt for this bounded caller-only item. [Fresh public GET evidence](upstream-related.json).

### Binding rules 1–3 / upstream skills

- **Rule 1:** the existing source option is reused. No pre-existing documented host environment setting was found; v2 adds its deploy-doc row rather than pretending a new transport mechanism is needed.
- **Rule 2:** upstream [`paperclip-create-plugin`](https://github.com/paperclipai/paperclip/blob/009c8884a4fee1ef7e406ea03fdadd4ac7c40d08/.agents/skills/paperclip-create-plugin/SKILL.md#L10-L18) governs the plugin-first check. The SDK lacks this host-worker control; there is no available plugin configuration path being bypassed. The supplied round-1 design ruling explicitly permits this narrow caller seam. [`create-runner-adapter`](https://github.com/paperclipai/paperclip/blob/009c8884a4fee1ef7e406ea03fdadd4ac7c40d08/.agents/skills/create-runner-adapter/SKILL.md#L10-L14) covers new native harness integrations, which this is not.
- **Rule 3:** assess under that explicit seam exception, not an invented claim that Paperclip promised a deploy variable. The substantive boundary now matches the approved shape. The commit has a rationale, docs, tests and the required upstream co-author trailer. Actual builder execution of `prepare-paperclip-pr` / `verify-paperclip`, a separate design-pair run, and a seam-register update are **not evidenced**; `SEAMS.md` is absent. I do not claim those procedures occurred. No new design process is manufactured here, and no additional core functionality is approved.

## 1. Independent RED/GREEN and preserved assertions

Node **24.19.0**, pnpm **9.15.4** through `corepack pnpm`, Vitest **5.0.3**. Frozen-lockfile dependency installation succeeded in the task-owned clone. The focused configuration retains ordinary Vitest defaults, selects adapter-utils, and limits concurrency to one worker. Commands and target details: [REPRODUCE.md](REPRODUCE.md).

| Check | Observed result | Evidence |
|---|---|---|
| Six candidate suites: new poll-interval test, three execution-target suites, bridge and bridge-body suites | **356/356 PASS**, exit 0 | [head-tests.log](head-tests.log) |
| Candidate adapter-utils typecheck | **PASS**, exit 0 | [typecheck.log](typecheck.log) |
| Builder's new test overlaid on M1.2 runtime source | **10/10 FAIL** because the newly exported resolver does not exist | [builder-base.log](builder-base.log) |
| Independent real caller → local command-managed queue → gateway → local HTTP callback, M1.2 runtime source | **RED:** four queue listings in 350 ms, expected at most one with setting 1000; callback itself completes exactly once | [v2-caller-base-detailed.log](v2-caller-base-detailed.log) |
| Same caller-flow test on exact candidate runtime source | **GREEN:** configured cadence and exactly one successful callback | [v2-caller-head-detailed.log](v2-caller-head-detailed.log), [test](judge-v2-caller.test.ts) |
| Staged prior judge, unchanged assertions and import path already valid after placement beside worker | **10 PASS / 1 FAIL**; all four formerly failing safety cases are green | [staged-judge-detailed.log](staged-judge-detailed.log) |
| Independent caller-resolved values passed to real worker: `2147483648`, `1e12`, `0.5`, `60000` | **4/4 PASS**, safe idle cadence, exactly one 200, no watchdog during 25 s continued operation | [v2-watchdog-cooperative.log](v2-watchdog-cooperative.log) |
| Combined-budget regressions in same worker suite | **100 ms: 3/3 PASS; 5000 ms: 3/3 FAIL**. Overall suite **7 PASS / 3 FAIL** | [v2-watchdog-cooperative.log](v2-watchdog-cooperative.log), [test](judge-v2-worker.test.ts) |
| Real-clock confirmation, actual worker with controlled queue/handler latency | **100 ms → 200 at 18,116 ms; 5000 ms → non-retryable 504 at 20,064 ms**, failed worker span | [real-clock.log](real-clock.log), [script](judge-v2-real-clock.ts) |
| Assertion preservation | Existing test files unchanged; only new test files added, **no deleted/weakened assertions** | [test diff](test-diff.patch), [audit](test-assertion-audit.txt) |

The builder's absent-symbol RED is not by itself behavioral proof. The independent caller-flow RED/GREEN supplies that proof. Baseline execution replaced only `execution-target.ts` with its exact M1.2 bytes: this is the sole changed production source file, so the runtime source is the stated base; candidate tests remain overlaid. The original head file was restored and hashes retained.

**Do not report the staged prior judge as 11/11.** Its remaining test directly sets the environment then calls the generic worker, expecting the old implicit environment behavior. V2 correctly removes that behavior; the worker polls at its upstream 100 ms default. The four old safety cases pass there partly because this environment variable no longer reaches that worker directly. I preserved this RED, did not weaken its assertions or silently rewrite its import to a wrapper, and separately tested the correct caller boundary and resolved-option behavior.

## 2. Required finding

### F1 — A 5000 ms sleep consumes watchdog budget; comparing it with each timeout separately is insufficient

**Required for v2: YES. Likelihood 2 × impact 4 = 8. Source step: configuration safety design and its tests.**

The [new constants/comment and resolver](https://github.com/Smarty-Pants-Inc/paperclip/blob/2fd20b68c97eee9810be573ee0fdc67dc6318bd7/packages/adapter-utils/src/execution-target.ts#L99-L126) justify 5000 because it is below the 10,000 ms per-operation timeout and leaves 15 s before the 20,000 ms watchdog. Both numerical constants are real, but the safety conclusion does not follow.

The existing worker starts the next list **after** its idle sleep. A successful list that finds work does **not** refresh `lastSuccessfulIterationAt` before processing that request. The watchdog measures elapsed time since the earlier successful iteration. Thus the relevant budget can be **sleep + list + request**, not merely one of those terms. See [source excerpts](source-evidence.md): sleep L1566, list L1527–1531, request timeout and progress update L1585–1597, watchdog L1495–1508.

Deterministic reproduction with otherwise successful, individually sub-10-second operations:

| Stage | Baseline interval 100 ms | Allowed interval 5000 ms |
|---|---:|---:|
| Idle queue successfully observed | 0 | 0 |
| Request queued just after idle observation | 1 ms | 1 ms |
| Next list starts, then takes 9 s | 100 ms | 5000 ms |
| Handler starts, would take 9 s | 9100 ms | 14,000 ms |
| Successful completion without watchdog interference | **18,100 ms** | **23,000 ms** |
| Actual cooperative-handler outcome | **200**, no error | **504 at 20,000 ms**, failed `sandbox.callbackBridge.workerFailed` span |

A handler ignoring abort still returns 200 at 23 s, but the watchdog has already emitted the false-unresponsive error at 20 s. A cooperative handler (like the production forwarder, which receives the signal) aborts and returns an **indeterminate, non-retryable 504**. The real-clock rerun confirms this is not a fake-timer artifact. It used no service credentials or real company data.

Upstream intentionally treats a long period with no completed iteration as unhealthy; v2 does not change that policy. It **does** spend an additional 4.9 s of the same budget and exposes a new false-failure window for a sequence that succeeds at the default. This is not evidence that present Boat calls take 9 s, and I make no production-incidence claim. It is a counterexample to qualification of the advertised maximum.

**Required correction:** re-evaluate the supported interval using the combined budget and retain this regression at the configuration/worker boundary. A narrower maximum removes this demonstrated window only if justified against the intended operating budget; simply replacing one comparison with `5000 < 10000 < 20000` is not sufficient. Do not silently broaden this caller-only item into watchdog/lifecycle changes, increase deadlines, or loosen the RED assertion. Any necessary broader timing change needs the lead's scope/design decision. No such corrected candidate is available in this review, so **NOT OK**, not a promise that fixes will land before the cut.

## 3. Other checks and lower-priority findings

### Caller/default/warnings — acceptable

- Regex admits unsigned decimal digit strings; unsafe/non-integer representations fall back to 100. Safe integers clamp to **100–5000**. `2147483648` clamps to 5000, while `1e12` and `0.5` fall back to 100. No timer overflow or zero-delay storm remains in the tested cases.
- The resolver runs **once per `startAdapterExecutionTargetPaperclipBridge` invocation that reaches `queue_v1` construction**, usually once per run start/fallback. It is not in the poll loop. An HTTP/2-success return bypasses it. Invalid values therefore emit one warning per such construction, not one per poll; repeated run starts repeat the warning. Acceptable for a persistent operator configuration error. [Resolver call sites](resolver-callers.txt), [factory call sites](bridge-factory-callers.txt).
- Unset returns 100 without warning; valid and clamped numeric inputs also emit no warning. The worker is **byte-identical** to M1.2, and explicit 100 normalizes identically to the former omitted option. [Base hash](base-worker.sha256), [head hash](head-worker.sha256). This is behavioral equivalence for unset configuration, not a claim that `execution-target.ts` itself is byte-identical.
- A callback arriving during the idle sleep waits at most the remainder of that sleep **before the next list begins**. Actual pickup/response includes list/read/handler/write time and existing backlog; it is not an end-to-end ≤5000 ms guarantee.

### F2 — Commit wording/evidence needs precision

**Required for v2: NO; v3. Likelihood 2 × impact 2 = 4. Source step: commit/evidence authoring.**

The [commit message](commit.txt) is present and now states the existing option, caller/plugin limit, broader provider benefit and Boat numbers. This fixes the missing rationale from round 1. But:

- “unset or invalid -> 100 with one warning” is imprecise: **unset does not warn**, correctly preserving default behavior; numeric clamping also does not warn.
- Claimed Boat measurements (~120 listings/minute per idle warm box; 966 listings/35 retained boxes/120 s) have **no raw measurement receipt supplied here**. The prior verdict also called them unverified. I checked source and behavior, not those field counts. They must not be represented as independently verified by this judgment.

Correct the wording and attach the measurement source when making a performance claim. The unsupported counts are not the basis of F1 or of a cost-saving estimate in this verdict.

### F3 — Invalid-value warning echoes arbitrary operator input

**Required for v2: NO; v3. Likelihood 1 × impact 3 = 3. Source step: diagnostic logging.**

The new warnings interpolate `JSON.stringify(rawValue)`. This setting is a non-secret numeric configuration, not a credential source; no credentials were accessed or disclosed here. Nevertheless, a secret mistakenly pasted into it would be echoed into logs. Prefer naming the invalid setting and fallback without its raw contents. Existing request/auth/redaction behavior is untouched; the unrelated password/API-key redaction regression suite was not run and is not claimed green.

### Prior round disposition

| Prior finding | V2 disposition |
|---|---|
| F1: overflow/fractional/60000 safety | Original four cases **fixed**; overall configured-range qualification **incomplete**, new combined-budget F1 above |
| F2: implicit environment read in worker; caller unchanged | **Fixed**: caller parses and passes existing option; worker unchanged |
| F3: absent commit justification | **Substantively fixed**: three design points now present; wording/field-measurement limitations recorded above |

### Requested risk predicates / multi-process door

| Risk | Result for this delta |
|---|---|
| False notice/error or duplicate | **Reproduced false unresponsive run-error and 504**, F1. No issue-comment/notice creation added. |
| Stale restore or rewind | No restore, backup, workspace-state or persistence predicate changed. |
| Reuse of another live owner | No owner/reuse/probe path changed; no stopped/archived-age or stop-receipt shortcut introduced. |
| Secret leakage / narrower redaction | Existing authorization/redaction unchanged; new raw diagnostic caveat is F3. No claims about unrelated redactor tests. |
| Double Paperclip-side effect | No new replay/claim/finalization path. Nominal callback tests observe exactly one handler result; watchdog returns existing non-retryable/indeterminate 504 for an aborted started handler. No duplicate side effect reproduced. |
| Multi-process door | **PASS for introduced changes**: no new durable run/lease/wake/claim state, process-local ownership map, claim authority or DB bypass. Existing transport-local state remains unchanged. Not a general multi-server qualification. |

## 4. Scope, shippable range and separability

- **Full range `4bb64997..2fd20b68`: five files.** Exactly `execution-target.ts`, its new test, the deploy-doc row, and **two tracked `.rfl-judge/bridge-seam/` files**. No gateway changes. [Full range](full-range-files.txt), [patch](range.patch).
- **Shipping delta `42f0d787..2fd20b68` / single commit `2fd20b68`: three files**, **no `.rfl-judge` files**. [Commit files](ship-commit-files.txt), [patch](delta.patch).
- **Required delivery condition:** if the lead takes the whole branch range from M1.2, the judge files **would ship**. Do not do that. Cherry-pick only the product commit (once F1 is resolved) or construct a clean product-only range; keep `42f0d787` out of shipping history. This is a delivery distinction, not an accusation that `2fd20b68` itself adds those files.
- Actually ran **`git cherry-pick --no-commit 2fd20b68…` onto exact C8 `ad2371a7c96d13b5a5c353d899264370cf0221fa`**: **exit 0, conflict count 0**, only the same three product files. [Receipt](c8-cherry-pick.log). No other C9 item is required for applying this delta. This is application/separability proof, not C8 runtime qualification.

## 5. Acceptance ledger and evidence limits

| Requested check | Judgment |
|---|---|
| 1. Only caller + test + docs; judge files excluded from shipping | Correct product commit; full branch range includes judge files and must not be shipped wholesale |
| 2. Staged four safety failures green | **Yes**; full old suite retains one obsolete-boundary RED. Independent resolved-option safety cases also green |
| 3. 5000 ms safe against actual timeouts | **FAIL — F1**, real-clock and deterministic counterexamples |
| 4. Warning frequency acceptable | **PASS**, once per queue-bridge construction, no poll-loop spam |
| 5. Unset behavior unchanged | **PASS** for this delta, same worker bytes and 100 ms cadence, no warning |
| 6. Commit message present and true | Present; technical boundary claims supported; blanket safety not supported, warning wording imprecise, Boat counts unverified |

No production run, real Boat daily-work proof, published-image check, broad CI or unrelated C9 qualification was performed or claimed. Unit tests here have a trust-boundary/recorded-regression keep reason; the local caller-flow test uses real shell commands, files, gateway and HTTP, but a local sandbox runner, **not Boat**.

Deliverables remain under the task artifacts directory: this verdict, [REPRODUCE.md](REPRODUCE.md), source/commit/range receipts, original staged judge and prior verdict, added judge tests and real-clock script, logs with exit codes, reap stop receipts, and [cleanup receipt](cleanup.txt). No build tree is a deliverable.
