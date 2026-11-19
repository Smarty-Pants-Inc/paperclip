# Saved-message wait copy: RFL 03:34Z

Record: **SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119**. This follows the earlier
one-line wait and bounded remote-cleanup changes; it does not replace their
01:31Z remote-cleanup words or ten-minute bound.

| Stored wait reason | Person-facing message (byte-exact) |
| --- | --- |
| `agent.not_invokable` when paused | Your message is saved. This agent is paused, so it starts when the agent is resumed. |
| `execution_recovery` | Your message is saved. It's waiting until the previous run is recovered. |
| `execution_active` (E3.04) | Your message is saved. It's waiting for the current run to finish. |

Each message has one production constant in `server/src/services/deferred-execution-wait.ts`.
Admission stores these words on the saved receipt. The invokability error and
HTTP refusal remain `Agent is not invokable in its current state`; only the
stored panel copy changes. Both the initial pause deferral and reconsideration
of a previously saved receipt use the paused constant. Recovery writers share
one constant so another producer cannot restore the older words.

## Reproduction and fixture custody

From `server/`, run:

```sh
M10_CAPTURE_DIR=/tmp/m10c-rows pnpm exec vitest run src/__tests__/execution-wait-one-line-routes.test.ts --maxWorkers=1
```

From `ui/`, render those actual GET bodies without a browser:

```sh
M10_ROW_INPUT=/tmp/m10c-rows/real-route-rows.json pnpm exec vitest run src/components/task-chat/TaskChatExecutionWait.real-route.test.tsx --maxWorkers=1
```

The server rows use real comment, Stop, pause, Resume and Delete routes.
Historical executions and the missing/provider stop response are explicitly
**planted** preconditions. The cleanup receipt normalizer, lease-release
producer, continuation consumer and queue admission produce the observed waits;
the paused row no longer calls the low-level wait writer with fixture text.
The E3.04 holder is a planted pre-selection queued run (legacy runtime, matching
real queued admission), cancelled through the real route. Admission replaces
its wait while M remains queued and unstarted behind the other task.

The Resume row calls the real lifecycle driver and saved-receipt/dispatch
producers. A controlled process actually runs and succeeds once. Its reply and
task completion use the real agent comment and task PATCH routes; stdout alone
is not an authored task reply. A second dispatch pass must not run M again.
The checked-in UI fixture is freshly generated from these route responses, not
hand-edited state. Existing non-generated recovery pins change by string only.
The UI renders the real thread and queued panel at 1440 and 390 widths in jsdom;
this is not browser, screenshot, model, deployed-org or visual-layout evidence.

Mutation check: replace each of the three constants, one at a time, with its
old text and run this same route file filtered by the reason. Each mutation
must fail the independent literal assertion for both task and chat; restore the
constant before the next mutation. The original invokability error assertion
must remain green.
