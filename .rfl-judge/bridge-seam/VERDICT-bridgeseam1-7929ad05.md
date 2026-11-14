VERDICT: NOT OK — unsafe interval values cause poll storms or false callback failures; the implementation also misses the agreed caller-threaded seam and design write-up.

# RFL: callback-bridge poll seam, part 1

- **Judged:** [`7929ad05820f05ecdb1cd02c450f365aadef4a06`](https://github.com/Smarty-Pants-Inc/paperclip/commit/7929ad05820f05ecdb1cd02c450f365aadef4a06), branch `cl/bridge-poll-seam`, exactly one commit on **M1.2 [`4bb64997b15b8f0bf7ffb68cd30742c56a8b08a5`](https://github.com/Smarty-Pants-Inc/paperclip/commit/4bb64997b15b8f0bf7ffb68cd30742c56a8b08a5)**. C8 is only the separate cherry-pick check, not the RED baseline.
- **Host/time:** ryzen3; started 2026-11-14 08:40:09 UTC; verdict written before the 09:10:09 UTC deadline.
- **Scope:** part 1 only. No idle-backoff, stop-with-run, unrelated C9 changes, or production qualification demanded. No builder contact, agents, credentials, GitHub writes, or production access.
- **Ship alone?** **Not approved as submitted.** With the new variable guaranteed **unset**, this is behaviorally safe relative to its stated parent: the same 100 ms default, loop, gateway, and explicit-option behavior remain. It needs no part-2 behavior to operate. That conditional default compatibility does **not** waive unsafe documented configuration or the seam terms. This is not a claim that C8's existing failure modes are safe.

## 0. Home and cardinal rule — design first

**Home: (c), a minimal seam/configuration pass-through using an existing adapter-utils contract. Not (d): lack of an operator knob alone is not a demonstrated violation of Paperclip's stated behavior.** There is no new provider/harness integration warranting provider-specific code in core.

Five-line design assessment:
1. Plugin workers run in a separate process; the current plugin SDK exposes no control of the host callback worker's poll interval. Changing plugin environment or delaying provider execs cannot safely configure that host timer.
2. Upstream already owns the needed mechanism: `startSandboxCallbackBridgeWorker({ pollIntervalMs? })`, default 100 ms. Its sole production caller is `execution-target.ts`.
3. The smallest acceptable change reads and safely bounds ONE documented host setting at that caller, then passes the existing optional parameter; absent configuration preserves the existing call behavior.
4. Keep transport scheduling in adapter-utils; do not add a scheduler, plugin-owned run state, gateway setting, provider-specific policy, or parallel callback path.
5. Other users are any exec-backed `queue_v1` deployment, including SSH and Docker-backed sandbox providers, where polling cost must be traded against tool-callback latency.

**Upstream basis exists, but the submitted write-up does not state it adequately.** Paperclip's original bridge commit [`a4ac6ff133fbe8bdb82f4046fda85f7cb372b6a9` / #4801](https://github.com/paperclipai/paperclip/commit/a4ac6ff133fbe8bdb82f4046fda85f7cb372b6a9) explains that remote agents use this bridge to call Paperclip and that adapter launch owns its lifecycle. Current upstream [optional parameter, L818–829](https://github.com/paperclipai/paperclip/blob/f452b449fd1893a0d46e6a63c5d54ccba6ef2e6e/packages/adapter-utils/src/sandbox-callback-bridge.ts#L818-L829), [normalization, L864](https://github.com/paperclipai/paperclip/blob/f452b449fd1893a0d46e6a63c5d54ccba6ef2e6e/packages/adapter-utils/src/sandbox-callback-bridge.ts#L864), and [caller, L4984–4995](https://github.com/paperclipai/paperclip/blob/f452b449fd1893a0d46e6a63c5d54ccba6ef2e6e/packages/adapter-utils/src/execution-target.ts#L4984-L4995) establish the intended extension point. The patch uses that loop, not a parallel mechanism, but fails the prescribed configuration boundary; see F2/F3.

Fetched **upstream master `f452b449fd1893a0d46e6a63c5d54ccba6ef2e6e`**. No merged upstream commit implementing this host environment setting was found in current source or the interval-related history. Public search found:
- [Issue #18635](https://github.com/paperclipai/paperclip/issues/18635): explicitly identifies the existing option and missing `execution-target.ts` pass-through. It is a report, not an implemented fix or authoritative guarantee.
- [PR #15696](https://github.com/paperclipai/paperclip/pull/15696), head `c41f9b168f0cad1b5e2f1a27c0c350b758d2beeb`: **open/unmerged**, adds remote long-polling and changes idle/stop behavior. It is relevant prior work, not a master fix to cherry-pick and not an in-scope substitute for this bounded part 1. Its description also explicitly bounds waits below the watchdog threshold.

Evidence: [source excerpts](source-evidence.md), [original upstream intent](upstream-original-bridge-commit.txt), [master receipt](upstream-head.txt), [interval history](upstream-poll-history.txt), [public searches](upstream-search.json), [related issue/PR](upstream-related.json).

### Rules 1–3 / upstream skills

- **Rule 1:** No documented deploy variable or SDK hook reaching this host interval was found. The existing source option must be reused; a new optional bridge parameter is unnecessary.
- **Rule 2:** [`paperclip-create-plugin`](https://github.com/Smarty-Pants-Inc/paperclip/blob/7929ad05820f05ecdb1cd02c450f365aadef4a06/.agents/skills/paperclip-create-plugin/SKILL.md#L10-L18) applies to the plugin-first decision. A plugin cannot configure this host-owned worker through the implemented boundary. Thus a narrowly approved seam is legitimate; this is **not** a finding that an available plugin feature was bypassed. [`create-runner-adapter`](https://github.com/Smarty-Pants-Inc/paperclip/blob/7929ad05820f05ecdb1cd02c450f365aadef4a06/.agents/skills/create-runner-adapter/SKILL.md#L10-L14) is not the implementation recipe for this generic host utility change.
- **Rule 3:** Evaluate under the task's explicit seam exception, not an invented core-bug justification. `prepare-paperclip-pr` / `verify-paperclip` are relevant to upstream-shaped delivery and truthful checking. No builder evidence demonstrates these skills, the required design review, or a seam-register entry were used; `SEAMS.md` is absent at this revision. The commit does contain tests, a deploy-doc entry and the upstream co-author trailer, but those do not establish design compliance. F2/F3 are required before v2 acceptance.

## 1. Independent RED/GREEN and assertions

Commands, exact setup and limitations are in [REPRODUCE.md](REPRODUCE.md). Node **24.19.0**, pnpm **9.15.4**, Vitest **5.0.3**. Dependencies were installed from the frozen lockfile in a disposable checkout. Adapter-utils has no package Vitest configuration; the retained focused config uses normal Vitest defaults and one worker, without unrelated workspace config imports.

| Check | Actual result | Evidence |
|---|---|---|
| Candidate's complete bridge test file overlaid onto **M1.2 base** | **90 passed, 1 failed / 91**, exit 1. New configured-cadence test expected one listing at 999 ms, got **10**. | [base-tests.log](base-tests.log) |
| Candidate bridge + body + three execution-target suites | **348 passed / 348, 5 files**, exit 0. Includes the 91-test bridge file. | [head-tests.log](head-tests.log) |
| Candidate adapter-utils typecheck | **PASS**, exit 0, `tsc --noEmit`. | [typecheck.log](typecheck.log) |
| Independent safety/callback tests on candidate | **7 passed, 4 failed / 11**, exit 1. | [adversarial-tests.log](adversarial-tests.log) |
| The nine independent unsafe-input checks with base worker implementation | **9 passed**, 2 deliberately unselected behavior tests, exit 0. Unsafe env behavior is newly exposed by this commit. | [adversarial-base-tests.log](adversarial-base-tests.log) |
| Real Node timers, actual worker, in-memory queue client | Unset: 2 lists/119 ms; 1000: 1/121 ms; oversized: **109/120 ms**; 0.5: **112/119 ms**. | [real-timer.log](real-timer.log) |
| Test assertion preservation | Sole changed test file adds **86 lines, deletes 0**; every base line remains in order. No removed or weakened assertion. | [audit](test-assertion-audit.txt), [full diff](change.patch) |

The second added test is the RED regression; the other added test deliberately confirms unchanged default behavior and is already green on base. The brief's “+2” is correct, but they are default cadence and a combined configured-cadence/request-pickup test, not two independently red regressions. My additional callback test queues immediately **after** a poll, exercises nearly the whole 1000 ms wait, and verifies one handler invocation and one 200 response.

## 2. Findings and safety

### F1 — Unbounded environment values defeat safety (required for v2: **yes**; likelihood **3** × impact **4** = **12**)

At [L867–873](https://github.com/Smarty-Pants-Inc/paperclip/blob/7929ad05820f05ecdb1cd02c450f365aadef4a06/packages/adapter-utils/src/sandbox-callback-bridge.ts#L867-L873), `Number(env)` feeds the existing [normalizer, L332–334](https://github.com/Smarty-Pants-Inc/paperclip/blob/7929ad05820f05ecdb1cd02c450f365aadef4a06/packages/adapter-utils/src/sandbox-callback-bridge.ts#L332-L334). Its predicate is finite and positive **before** truncation, with no upper bound.

- `0`, `-1`, nonnumeric text, infinity and empty text safely fall back to 100 ms.
- `0.5` is positive, then truncates to **0**. Real Node schedules effectively 1 ms, not a safe default.
- `2147483648` / `1e12` survive normalization but overflow Node's signed-32-bit timer range. Node explicitly warns **“Timeout duration was set to 1.”** This creates an exec storm instead of reducing calls.
- A finite non-overflow value such as `60000` sleeps past the unchanged **20 s watchdog**. With a healthy queued request, the actual watchdog emits a false “connection is unresponsive” error and writes **503 at 20 s**, with **zero handler calls**. This also exceeds the normal 30 s gateway response budget.

**Fix at the configuration boundary:** reject/fallback or clamp to a documented finite integer range whose lower bound cannot truncate to zero and whose upper bound leaves ample room below watchdog/response budgets. Keep the shared generic timeout helper unchanged unless independently justified: changing it globally would exceed this seam. Add invalid/overflow/fractional/boundary and healthy-wait regressions. No idle-backoff or stop redesign is needed.

### F2 — Wrong seam boundary (required for v2: **yes**; likelihood **5** × impact **2** = **10**)

The agreed shape is an optional parameter threaded from the sole caller. The parameter **already exists**. The patch instead makes the generic utility read `process.env` implicitly; **`execution-target.ts` is not changed**. Every other consumer omitting the argument now inherits host-environment policy. Explicit numeric options still take precedence, but that does not satisfy term (a).

**Fix:** parse/validate the single setting at the production construction site and pass the existing `pollIntervalMs` option. Restore the utility's previous environment-independent default. Test the caller wiring, not just direct calls to the utility. Evidence: [diff](change.patch), [caller excerpt](source-evidence.md).

### F3 — Required seam justification is missing (required for v2: **yes**; likelihood **5** × impact **2** = **10**)

The [commit message](commit.txt) gives a claimed measurement, names the unchanged caller/default and the env name. It does **not** supply the required five-line explanation of plugin impossibility, upstream intent/contract and broader consumers, nor show the agreed caller-threaded design. The statement about lacking an operator knob is supported; an absent argument must not be mistaken for an absent upstream optional parameter. No staged measurement/design evidence exists, so the Boat rates and prior skill/design-review use remain **unverified**, not independently established facts.

**Fix:** record the actual five-line design, cite the existing option/caller and upstream work above, and provide the lead's required design/seam record. Do not claim these records already exist. This is a required design gate, not a demand to expand runtime scope.

### Requested risk predicates

| Risk | Review result |
|---|---|
| False notice or duplicate | **Concrete false run-error/503 under long intervals**, F1. No user-comment/notice creation is added. |
| Stale restore or rewind | No backup/restore predicate, persisted session state or workspace content changes in the diff. No new path identified. |
| Reuse of another live owner's runner | No owner/reuse/probe predicate changes. No stopped/archived age or stop receipt is introduced as proof. |
| Secret disclosure / redaction | No credential, request-authorization or redaction changes. No narrower masks introduced. The named password/API-key redaction cases are outside this diff; I did not claim to rerun the unrelated redactor suite. |
| Double Paperclip side effect | No new request replay/finalization path. Existing per-request guards remain untouched; the added worst-phase callback check observes exactly one mutation handler. The reproduced watchdog 503 is before handler execution, not evidence of a duplicate mutation. |
| Multi-process door | **PASS for this delta.** No new durable run/lease/wake/claim state or owner map. Existing per-run transport loop/guards remain transport-local; no Postgres-owned authority is moved into the process. This is not a general multi-server qualification. |

## 3. Separability

- Exactly one commit on stated M1.2 parent; no other C9 item is required by the changed code.
- Executed **`git cherry-pick --no-commit 7929ad05…` onto C8 `ad2371a7c96d13b5a5c353d899264370cf0221fa`** in a separate disposable clone: **exit 0, conflict count 0**, same three-file diff. [Receipt](c8-cherry-pick.log).
- The first shared-clone attempt lacked lazy-fetched C8 blobs; it was not a semantic conflict. Preserved [initial failure](c8-cherry-pick-initial-missing-blobs.log), configured public promisor fetching, reset to exact C8, then reran successfully. No code conflict resolution was applied.
- Clean application is not C8 runtime qualification; tests above are on the requested M1.2 base/head.

## 4. Terms (a)–(e), range and cut line

| Term | Result |
|---|---|
| (a) Optional option from sole caller; default unchanged | **FAIL boundary / PASS default compatibility** — F2. |
| (b) One documented env name; invalid values safe | **PASS naming/doc / FAIL safety** — F1. |
| (c) Present, true design write-up | **FAIL completeness** — F3; field measurements unverified. |
| (d) Smallest change; no unrelated behavior | Three files only; gateway code and its `PAPERCLIP_BRIDGE_POLL_INTERVAL_MS` unchanged. No idle-backoff or stop-with-run added. Boundary needs correction, not broader work. |
| (e) Multi-process door | **PASS for introduced changes.** |

**Sane operating range:** recommend **100–1000 ms**, initially **500 ms** if reduction is needed. This is an engineering recommendation, not a measured Boat optimum. At idle, a newly queued callback adds nominal waiting of up to one host interval (about half an interval on average for uniformly timed arrivals), **plus** provider list/read/write, gateway polling and handler latency. Sequential callbacks accumulate this cost. Keep the default at 100 ms. Do not configure tens of seconds; a numerical timer maximum is not a protocol-safe maximum.

The configured worker's period is sleep **plus remote-call time**, so `100 ms` does not by itself establish the brief's observed polls/minute or actual savings. No production cost or conversation-completion claim is made. All F1–F3 are required for v2; none is deferred to v3. The local changes are small, but there is no evidence of their delivery or a pre-cut commitment, so this is **NOT OK**, not “OK WITH FIXES.”

Retained deliverables: this verdict, [reproduction instructions](REPRODUCE.md), source/test patches and test files, upstream/search evidence, command logs/exit files and cleanup receipt. No build tree is a deliverable.
