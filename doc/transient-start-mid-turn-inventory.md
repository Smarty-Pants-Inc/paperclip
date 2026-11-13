# Inventory only: transient model-provider errors after tool work

No mid-turn retry code or settings change is included in this work. These errors
are **not** computer-start failures and must not spend the startup wait lane or
replay the person's original tools in a new session without reconciliation.

## Existing feature first: Pi's own retry policy

C8 pins `@earendil-works/pi-coding-agent` **1.5.2** in
[`packages/paperclip-runner/package.json`](../packages/paperclip-runner/package.json).
Its existing [Settings Reference, Network and retries](https://unpkg.com/@earendil-works/pi-coding-agent@1.5.2/docs/settings.md)
(lines 128–136 in the installed artifact) documents:

- `retry.enabled: true`, `retry.maxRetries: 3`, `retry.baseDelayMs: 2000`,
  `retry.maxAgentDelayMs: 60000`: **agent-level** retries inside the admitted Pi
  prompt/session, normally 2/4/8-second delays for its three retries.
- `retry.provider.timeoutMs` defaults to `httpIdleTimeoutMs` (300000).
- `retry.provider.maxRetries: 0`: **request-level** retries default OFF.
- `retry.provider.maxRetryDelayMs: 60000`: server-requested delay cap;
  zero disables the cap. This is not an agent retry-count setting.
- Pi explicitly recommends leaving provider retries at zero unless required,
  because they can delay quota/usage-limit handling. Do not multiply the two
  policies indiscriminately.

These are Pi settings, not Paperclip adapter fields. Actual managed-home/project
settings may override them; no deployed settings or credentials were inspected.
[Paperclip's managed compaction setup](../packages/paperclip-runner/src/drivers/pi/pi-managed-settings.ts)
only changes compaction and preserves the rest. The installed Pi artifacts used
for this inventory are copied with hashes in the task's `pi-1.5.2-evidence/`.

## Mid-turn inventory row (C8 behavior → existing owner)

| Failure after native Pi already did tool work | What C8 actually does | Which existing lane should own retry; remaining gap |
|---|---|---|
| Gateway **400 / unknown provider during reload**, ordinary 429 throttling, transient 500/502/503/504 | Pi's `isRetryableAssistantError` examines the failed assistant's text, excludes quota/billing exhaustion, and retries recognized transient failures **inside the same admitted prompt**. 429 and the listed 5xx are recognized; a bare `400 unknown provider` is **not**. A 400 wrapper containing `Provider returned error` *is* recognized by the existing broader text pattern, so the complete normalized error matters. Paperclip's Pi driver captures `auto_retry_start/end`, keeps the original turn binding, lets a genuine later successful receipt supersede the transient failure, and emits `pi_provider_error` on final failed `agent_settled`. It does **not** itself enqueue a new prompt for every retry event. | First use Pi's **agent-level auto-retry** for recognized transient provider errors, retaining the admitted session and completed tool history. If request-level retry is needed, Pi already has `retry.provider.*`; its OpenAI/Anthropic wrapper retries network errors/408/409/429/≥500 (subject to `x-should-retry`), not ordinary 400, and defaults to zero retries. A bare reload-only unknown-provider 400 remains an inventory gap: distinguish it at the gateway/provider boundary (for example a typed temporary-service failure or supported retry guidance), rather than treating every 4xx as transient or using the computer-start lane. After Pi exhausts retries, preserve the failed run/checkpoint and use native failure reconciliation; automatic fresh replacement is not implied by this inventory. |

The distinction is observable in the installed classifier: bare `400 unknown
provider` → false; 429 and 500/502/503/504 → true;
`429 insufficient_quota` and `400 invalid_request_error` → false;
`400 Provider returned error: unknown provider` → true. The executable local
classification check and exact input strings are in `pi-retry-classification.log`.
This is a classifier check, **not** a live gateway-reload or post-tool replay test.

## Do not confuse this with the narrow Codex capacity lane

C8 already has [native-provider-capacity-retry.ts](../server/src/services/native-runtime/native-provider-capacity-retry.ts)
and [native-provider-failure.ts](../server/src/services/native-runtime/native-provider-failure.ts).
They recognize a committed **Codex** `serverOverloaded` failed turn, consume the
ordinary failure-retry budget, schedule at most two successor retries at 60/120
seconds, and force a fresh session while removing consumed wake inputs. That is
not a generic Pi/gateway 400/429/5xx policy. Extending it indiscriminately would
change tool/session replay and paid-work semantics; this task does not do that.

## Source anchors

- Pi 1.5.2 `dist/core/agent-session.js:3142–3228`: classifier delegation,
  retry settings, failed-attempt omission from model projection, abortable delay.
- Pi AI 1.5.2 `dist/utils/retry.js:1–124,208–216`: explicit non-retryable limit
  exclusions and transient text allowlist. Generic **all 5xx** is not promised;
  status words/patterns and the enumerated statuses control this layer.
- Pi AI 1.5.2 `dist/utils/provider-retry.js:1–21,72–99`: request-level policy.
- [C8 Pi driver](https://github.com/Smarty-Pants-Inc/paperclip/blob/ad2371a7c96d13b5a5c353d899264370cf0221fa/packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.ts#L1515-L1578): retry/failure observation and final settlement.
- [C8 transcript test](https://github.com/Smarty-Pants-Inc/paperclip/blob/ad2371a7c96d13b5a5c353d899264370cf0221fa/packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.test.ts#L488-L510): recorded Pi 1.5.2 retry stays inside the admitted prompt.
- [C8 native Codex capacity scheduler](https://github.com/Smarty-Pants-Inc/paperclip/blob/ad2371a7c96d13b5a5c353d899264370cf0221fa/server/src/services/native-runtime/native-provider-capacity-retry.ts#L21-L72): separate, bounded successor lane.
