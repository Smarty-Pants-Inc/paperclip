VERDICT: NOT OK — the cross-run credential leak is closed on the file queue only: the same straddle still returns run-B credentials over the real HTTP/2 duplex bridge on 252222ce; 252222ce also breaks server typecheck, makes release/activate throw when the box cannot be written, and ships no test

Judge: independent RFL item judge, ryzen3, 2026-11-14 10:23Z–10:42Z (first full verdict written 10:38:54Z). Source: Smarty-Pants-Inc/paperclip `cl/bridge-pause` = 252222ce3883e3f75f69199fddf7a6cb1536f79b (chain f8c99ce4 → 138eba7e → bf984a4d → 252222ce on 4bb64997). All runs are mine; logs are in `logs/`. Builder RESULT-crossrun.md was not reachable and not used.

## What I ran (leak first)

| # | Check | Result | Log |
|---|---|---|---|
| 1 | Staged `judge-gateway-cross-run.test.ts` UNCHANGED (sha256 6f69a8ff…ad08c83f) on **4bb64997** | **LEAK**: status 200, `resolvedRuns ["run-B"]`, exit 1 | `logs/leak-4bb64997.log` |
| 1 | Same file on **252222ce** | status 403, `resolvedRuns []`, exit 0 | `logs/leak-252222ce.log`, `logs/attack-252222ce.log` (last JSON line) |
| 2 | `judge-attack.test.ts` (5 cases, real gateway + worker + broker) on 252222ce | 5/5 pass, details below | `logs/attack-252222ce.log` |
| 2 | **`judge-http2-cross-run.test.ts`: the staged straddle over the REAL HTTP/2 duplex bridge (mode `http2_v1` asserted; real in-box gateway, host HTTP/2 server, broker) on 252222ce** | **LEAK: status 200, `resolvedRuns ["run-B"]`, `responseAuthority "run-B"`, exit 1** | `logs/http2-cross-run-252222ce.log` |
| 2 | Same HTTP/2 test on the 138eba7e tree (server code identical to 4bb64997) | same leak, so unfixed rather than new | `logs/http2-cross-run-4bb64997-server.log` |
| 2 | `judge-http2-path.test.ts` (broker fed the HTTP/2 forward shape directly) on 252222ce | 200, `resolved ["run-B"]` | `logs/http2-path-252222ce.log` |
| 4 | Builder RED on 138eba7e tree | 1 failed (`pause` undefined), 89 pass | `logs/pause-red-138eba7e.log` |
| 4 | Staged `judge-baseline.test.ts` on 138eba7e | 240 list calls / 120 s | same log |
| 4 | `judge-pause.test.ts` on 252222ce | pass (numbers below) | `logs/pause-252222ce.log` |
| 4 | ORIGINAL 138eba7e test file, unedited, on 252222ce | pass (90 tests) | `logs/pause-252222ce.log` |
| 4 | `judge-release-failure*.test.ts` on 252222ce | **FAIL: release and activate REJECT; hung write never returns** | `logs/release-failure-252222ce.log`, `logs/release-failure-broker-252222ce.log` |
| 5 | Builder suites on 252222ce (bridge, poll-interval, native-github-access, github-operation-credentials) | 4 files, 145/145 pass | `logs/suites-252222ce.log` |
| 5 | adapter-utils `tsc --noEmit` on 252222ce | exit 0 | `logs/tsc-adapter-utils-252222ce.log` |
| 5 | **server typecheck** on 252222ce vs 4bb64997 | **1 NEW error in shipped source** (plus 4 old test-file errors present on both) | `logs/tsc-server-252222ce.log`, `logs/tsc-server-4bb64997.log` |
| 3 | `git cherry-pick --no-commit` of the 4 commits onto C8 ad2371a7 | 0 conflicts each | `logs/separability-on-c8.log` |
| 0 | Upstream paperclipai/paperclip master aaec67b8 (11-14 10:15Z) | no pause / run-state / generation there; nothing to adopt | `logs/upstream-check.log` |

Attack results on 252222ce (queue_v1, real gateway):
- Accepted under A → 200 run-A. Between runs → 503 "run is detached", marker `paused`. Accepted under B → 200 run-B. Generations are fresh UUIDs per activate.
- Body straddles A→B (staged test) → 403. Body straddles A→B→C (two hops) → 403; a fresh request under C → 200 run-C.
- Queue entry written by a box process with NO generation → 403 "has no run generation". With A's generation replayed under B → 403. With a random UUID → 403. With the generation passed as a forged header instead of the field → 403. With a forged `x-paperclip-bridge-transport` header → still treated as queue_v1 → 403.
- Box process rewrites `run-state.json` to `attached:<genA>` while paused, then posts through the gateway → nothing resolved while paused; quarantined with 503 on B's attach; never handled as B. Rewrites it to bare `attached` during B → 403.
- **The marker is NOT a secret and NOT bound to a connection.** `run-state.json` is a plain file (mode 664) in the box queue dir. A box process that re-reads it after B attaches and stamps its own queue entry gets 200 run-B (case 3). See finding 5.

Pause results on 252222ce (worker level, fake clock, 500 ms interval): start paused → 0 box calls in 120 s; attached → 10 list calls in 5 s; after release → **0 box calls of any kind in 10 min**; a late run-A entry is answered 503 on B's attach and never reaches the handler; a B entry is handled 500 ms after attach (one interval); double pause → 0 calls. Stop while paused makes 2 box calls (marker write + list).
Not run: a real server restart re-attach, and two real server processes. Those two are judged by reading only (below).

## Home (plugin-first) and cardinal rule 0
- Home = **(d) core fix**. All touched source files are upstream Paperclip files (present at upstream master aaec67b8): `packages/adapter-utils/src/sandbox-callback-bridge.ts`, `execution-target.ts`, `server/src/services/native-runtime/native-github-access.ts`, `native-session-executor.ts`.
- Stated intent the leak breaks: `native-github-access.ts:17-19` "A process-lifetime transport, with authority only while its controller owns a run" and `:81` "Bind at receipt; body/headers cannot select a run or responsible user". A request received under A that resolves as B is a genuine bug against that. (d) holds for the leak fix.
- A plugin cannot do it: the worker is host-owned (`execution-target.ts:5020-5021` "not configurable from a sandbox-provider plugin").
- It extends Paperclip's own worker handle and the broker's own bind-at-receipt check; no parallel owner. One exception: it adds a second "no run" answer (gateway 503 from `run-state.json`) beside the broker's own 403 "No active GitHub run" (finding 6).
- Rules 1–3: no documented feature covers this; no upstream fix exists to adopt; rule 3 (shaped to upstream, prepare-paperclip-pr) is NOT met yet: finding 6. `idleBackoffMaxMs` is not smallest-possible (finding 7).

## Findings

1. **Server typecheck is broken by 252222ce.** `server/src/services/native-runtime/native-github-access.ts(166,32): error TS2554: Expected 0 arguments, but got 1.` The handle type still says `resume?(): Promise<void>` (`execution-target.ts:434`) while the caller passes the generation. Not on 4bb64997. The builder ran only adapter-utils tsc. Fix: `resume?(generation?: string)`. **Required for v2: yes.** L5 × I4 = 20.

2. **Release and activate now do box I/O that can throw or hang, inside the executor's `finally`.** `pause()` awaits `writeTextFile(run-state.json)` with no catch and no timeout (`sandbox-callback-bridge.ts:1704-1708`); `resume()` the same (`:1733`); release awaits it (`native-github-access.ts:170-175`); the executor awaits release in a `finally` with no catch (`native-session-executor.ts:14282`). Measured: with the box exec failing, `release()` → REJECTED "sandbox is stopped", next `activate()` → REJECTED; with a hung write, `pause()` is still pending after 600 s (only the queue client's own exec timeout bounds it). Before this item release was synchronous and could not fail. By reading (not reproduced in the full executor): a throw there (i) skips `githubAccess.stop()` at `:14283-14285`, (ii) replaces the outcome of a turn that already succeeded with a failure (retry can repeat a Paperclip-side effect), (iii) replaces `NativeRunnerOwnershipUnverifiedError` thrown one line earlier at `:14274`, which the comment at `:14272-14273` says nothing may displace because heartbeat would then release the retained process (the "another live owner" door), (iv) a hung write holds `settlingNativeSessionScopes` (`:14281`), which a follow-up's admission waits on — the SMAA-501 class. The box being unwritable at run end is exactly when the run is already failing. Authority is safe in this path: `active` is cleared and `paused` is set before the write, and I measured 0 list calls after a failed pause. Fix: after clearing authority, make pause best-effort (catch, bound by the iteration timeout); decide whether a failed attach write fails the run or marks GitHub not ready. **Required for v2: yes.** L3 × I5 = 15.

3. **The leak is NOT fixed on the HTTP/2 duplex bridge (never-OK class).** Proven end to end on 252222ce with the staged straddle run over the real `http2_v1` transport: status 200, `resolvedRuns ["run-B"]`, `responseAuthority "run-B"`. Why: the HTTP/2 handle has no `pause`/`resume` (`execution-target.ts:4984-5004`), so activate/release do nothing to it; `http2ForwardRequest` sends no generation and no transport marker (`:4889-4904`); the host HTTP/2 server forwards only after it has buffered the whole body (`http2-bridge-server.ts:928`, `:1246`); and the broker demands a generation only when `x-paperclip-bridge-transport: queue_v1` is present (`native-github-access.ts:69-73, :77`). The source calls HTTP/2 "the preferred transport" and queue_v1 "the soft-deprecated fallback" (`execution-target.ts:4456`). It is selected when the instance setting `enableSandboxDuplexBridge` is on and the provider grants `duplexCommandStream`; I did not read any prod setting, so I do not know whether a live instance uses it. Fix: capture `activeGeneration` when the host accepts the stream HEADERS (the host owns that server, so this can be a true per-connection binding) and have the broker refuse every bridged request whose captured generation is not the active one. **Required for v2: yes.** If the lead can show the setting is off on every v2 instance, the minimum is a code-level refusal of managed GitHub over HTTP/2 until bound; a note alone is not enough for this class. L2 (unknown setting) × I5 = 10.

4. **The never-OK fix ships with no test.** 252222ce changes 3 source files and 0 test files. The only test that fails on the leak is the judge's staged file, outside the tree. Land `judge-gateway-cross-run.test.ts` and attack cases 2, 4, 5 with the fix. **Required for v2: yes.** L5 × I3 = 15.

5. **What the binding does not do (state it; not a regression).** It fences requests by when the gateway accepted them. It does not fence a run-A PROCESS that is still alive in the box when B attaches: that process can open a new request, or read `attached:<genB>` from `run-state.json` and stamp its own queue entry (case 3 → 200 run-B). The bridge token is also the same for A and B (`native-github-access.ts:30`, one token per session). This is the same on 4bb64997 and the item does not claim otherwise. Today no box spans two responsible users, so L1 × I5 = 5. **Required for v2: no for this item; required before any box is shared across responsible users.** The control for that is killing run-A processes at release or a per-run bridge token, not this marker.

6. **Conflicts with upstream's newest change to the same file.** Upstream b7922570e (#21537, 2026-11-13) adds a startup probe that sends this same POST through the bridge with no run active and requires `403` + `No active GitHub run`, else "GitHub session transport verification failed". With `startPaused: true` the gateway answers 503 "run is detached" first (tests here were changed from 403 to 503 to match). At the next upstream sync the probe fails on queue_v1 and the session continues without managed GitHub access. Also a text conflict in `native-github-access.ts`. **Required for v2: no (not in M1.x); must be on the sync ticket and fixed before an upstream PR.** L4 × I4 = 16 at sync time.

7. **Unused new knob in core.** `idleBackoffMaxMs` (`sandbox-callback-bridge.ts:827, :874, :1625`) has no production caller; only the builder's test sets it. Remove it or name its caller. The RED test was edited in the GREEN commit (env var → option, 800 → 2,000 ms advance, one assertion tightened to `status 503`); the original 138eba7e file passes unedited on 252222ce, so nothing was loosened. **Required for v2: no.** L2 × I1 = 2 (v3 / cut).

8. **Stop touches the box.** `stop()` while paused writes the marker and lists once (2 calls); the write is caught but not time-bounded. The list at stop is old behaviour. **Required for v2: no.** L2 × I2 = 4 (v3).

## Multi-process door
No breach found. No run, lease, wake or claim state moved out of Postgres; nothing new is durable. The generation sits beside the binding that was already per-process (`native-github-access.ts:17`, `:32-33`). Each server process makes its own token (`:30`), its own session id and so its own queue dir and gateway (`:31`), and its own fresh UUID per attach, so a second process cannot accept another process's stale generation: any value other than its own current one is refused (attack case 2, random UUID → 403). After a restart the new process starts its bridge paused and attaches with a new generation; the old gateway's queue is polled by nobody. This is by reading plus case 2; I did not run two server processes.

## Separability and scope
The four commits apply on C8 ad2371a7 with 0 conflicts (not built or tested there). 252222ce needs bf984a4d (marker file, `resume`); bf984a4d needs f8c99ce4 only for the interval. No other C9 item is needed.

## What would make this OK
Fix 1, 2, 3 and 4, then rerun the files in this directory (REPRODUCE.md): `judge-http2-cross-run`, `judge-release-failure*` and the server typecheck must go green, the rest must stay green. 5 and 6 need a written line, not code, for this cut.
