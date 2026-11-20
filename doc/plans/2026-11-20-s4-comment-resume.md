# S4: overlap an existing Boat resume with comment admission

## Person case and seam

Paul comments on an existing agent task whose Boat sandbox is suspended. Start only that allocation's resume while the remaining admission work completes. This is not a new-chat shortcut, an execution grant, a provider-health cache, or a change to `task.prepare` scheduling.

The existing issue-comment route already calls `heartbeat.wakeup`; no second route or permission policy is needed. Its queue owns budget, pause, wake, issue-state, coalescing, responsible-user and execution-owner decisions. The new optional queue callback runs only after those decisions allow a new run. It is tracked by the existing heartbeat drain, but does not block the remaining admission transaction or start business execution. A failed or rolled-back admission leaves an unclaimed cleanup obligation.

`environment-runtime` owns selection and scope/config fingerprints. It accepts only a single matching Boat lease in the same company, environment, issue and provider scope, with a terminal prior run and no live peer owner. A released lease needs a bound stop receipt; a retained lease needs an exact fresh provider observation of `stopped`. It never provisions or replaces a sandbox here. The starter issues only `environmentResumeLease`; missing sandbox/config/eligibility is a no-op, not permission to create.

The normal acquisition reaches its original resume site after its own current checks. A database row lock/CAS either fences normal resume against late speculation or joins the exact reservation and configuration digest. The journal is not evidence that a provider is currently healthy. A mismatched, expired, failed or unsupported journal never skips a resume check or authorizes business execution. Existing failure/cleanup rules still apply. Independent runtime instances use the same persisted result; there is no process-local promise cache that can double-resume after restart.

## Paid-resource bound and observation

`PAPERCLIP_SPECULATIVE_RESUME_TTL_MS` defaults to **30,000 ms**, maximum 300,000 ms. Invalid, missing, nonpositive and fractional settings use the finite default. The lease reservation, allocation identity and absolute deadline commit before provider I/O. The provider RPC timeout cannot extend beyond that deadline, including time already spent recording the reservation.

The existing warm-expiry/deadline owner sees the journal and wakes at its deadline. It performs the existing stop-and-retain operation, not destruction. A merely preparing/running heartbeat does not count as a claim: only a matching `claimedBy` run or a live peer lease protects the allocation. Confirmed stop increments `speculativeResumeUnclaimedSuspensions` durably and logs `sandbox.speculative_resume.unclaimed_suspended` with `count: 1`. A failed/unconfirmed stop is **not counted**; it stays `pending_cleanup` for existing backoff/retry. Provider/control-plane outages can delay confirmation; the deadline is a cleanup-dispatch obligation, not a promise that an unreachable provider confirms stop on time.

The persisted deadline is reconstructed after controller restart. There is no new idle poller or timer owner. Started/claimed/unclaimed-suspended events correlate company, lease, reservation and comment; claimed also names the run. Before downgrading to code that does not understand this internal v1 journal, drain these obligations and independently confirm all unclaimed allocations stopped. Do not ignore pending cleanup during rollback.

## Local proof, not a production first-word claim

`server/src/services/speculative-sandbox-resume.test.ts` uses isolated real Postgres, real queue admission, real environment acquisition and real cleanup owners, with a controlled Boat RPC peer. Both base and head use the same 900 ms resume delay; the queue-path case additionally holds a successful admission transaction's commit for 900 ms **after eligibility**, rather than inventing a second admission policy.

The recorded local comparison was:

| Path | Base | Head | Difference |
| --- | ---: | ---: | ---: |
| Controlled acquisition: ingress to attach-ready | 1,862 ms | 964 ms | 898 ms |
| Real queue admission to attach-ready | 2,097 ms | 1,039 ms | 1,058 ms |

Base resume began after admission ended; head resume began before it ended. Each path asserts exactly one provider resume. The regression suite also checks unclaimed stop/count after reconstructing heartbeat ownership, simultaneous runtime instances, provider-auto-suspended retained leases, preparing-but-unclaimed runs, claimed live allocations, failed-stop retry accounting, no sandbox/foreign company, and six admission rejection/coalescing cases.

These are single controlled local timings, not live Boat latency or Paul-visible first text. Unsimulated queue overhead differs between samples; its difference must not be credited as an S4 live gain. Model time, provider-pack memoization and S0/S1/S2/S5–S8 are not changed or measured here.

## Authorized live gate: twenty matched samples and a money case

This task does not run the live gate: it authorizes no deploys, real-data changes or paid resources. The integrating lead must run it on real daily work with the normal observation/trace facilities and separately authorized operations.

1. Pin base/head commits and identical provider, image, provider pack, model, agent configuration and instrumentation. Use the same existing daily-work task/agent. Before every sample independently observe its existing Boat allocation suspended and record its ID; do not substitute a newly provisioned sandbox or test organization.
2. Collect ten base and ten head issue-comment turns in alternating matched order. Record comment acceptance, `comment.to_run_created`, provider resume start/end, attach-ready, `native.controller.resume` when applicable, and `task.time_to_first_token`/visible first text. Preserve the openable task/comment/run and trace links and provider allocation identity for each row. Record all samples, including failures; no cherry-picking or model-time subtraction.
3. Require resume to begin only after normal eligibility permits that comment to run, but before remaining admission ends. Verify exactly one resume and zero create calls per qualifying sample, and no speculation for an ineligible/coalesced comment or new chat. Compare all raw samples plus median/p90; do not infer a 0.89-second live gain from the local controlled peer.
4. Separately prevent an otherwise eligible speculative admission from being claimed using an authorized failure/cancellation gate. Record `startedAt`, `expiresAt`, the provider allocation and the cleanup deadline. Allow N plus provider/owner dispatch latency; independently confirm suspended state, retained workspace and no paid allocation still running. Require exactly one durable unclaimed-suspension increment and its event. Repeat with the controller restarted after reservation; do not merely inspect the DB status or a mocked worker response.
5. Keep the existing file rules, gate/runners-lead behaviors and preparation ordering intact. If another entrypoint remains slower, compare it against the same canonical turn, fix the redundant path or name it with trace evidence as blocked. The change removes no package or import edge: state **zero dependency edges removed**, rather than claiming cleanup that did not happen.
6. End by independently confirming all sample allocations suspended/stopped and preserving visible evidence. A missing link, unknown provider outcome, duplicate resume/create, unbounded paid resource, or an unclaimed allocation still running is a failed gate, not a latency win.
