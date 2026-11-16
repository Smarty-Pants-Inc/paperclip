# Company agent observability

Company Settings → General → Agent observability configures one company-owned
OTLP destination for Paperclip-managed Codex, Claude Code, native OpenCode and
native Pi (`paperclip_runner` / `pi_rpc`) executions. Export
is disabled by default. Choose Braintrust (US) or a custom HTTP(S) OTLP base URL;
use your own collector when you need fan-out. Braintrust EU and self-hosted
installations can use Custom OTLP with their required routing/authentication
headers. The receiver must be reachable from every execution environment;
`localhost` refers to the execution host, including a remote sandbox.

This is separate from Paperclip's first-party Telemetry and its content-free
[infrastructure tracing](observability.md). Configuring it does not change either data path.

## Capture and supported runtimes

The qualified versions are Codex 0.160.0 and Claude Code through ACP bridge
0.73.0 with Agent SDK 0.3.286. Both logs and traces use HTTP/protobuf. Prompts,
assistant responses and tool content default on. Additional tool details are a
Claude Code and native OpenCode control; Codex has no equivalent switch. Codex requests up to 64 KiB
of tool output (or zero when disabled); native event availability, truncation
and response caps still apply. Claude Code applies its own native limits.
Metrics, raw API bodies and Codex Guardian assessments are disabled.

Native OpenCode 1.18.34 uses a runner-owned HTTP/JSON exporter. Each completed,
failed or cancelled turn produces a trace with Paperclip company, agent, run and
turn IDs. Authenticated Paperclip tool dispatch outcomes, native tool outcomes and
message-level token/cost receipts are child spans;
repeated usage updates replace the same message receipt. Missing prices remain
unknown. This projection excludes hidden reasoning, raw provider payloads and
system instructions. Prompt, response, tool-detail and tool-content switches
apply before export. Content is bounded to 8 KiB per field and 64 tools plus 64
usage records per turn; truncation is marked. With both tool-detail and tool-content
capture enabled, Paperclip tool spans include `braintrust.input` diagnostics
(`paperclip.opencode.tool-diagnostics.v1`): the upstream `tools/call` method,
argument JSON type and types for a fixed list of envelope fields. These are
shape diagnostics, not a copy of the arguments. Arbitrary field names, argument
values, nested payloads and full model request bodies are not captured.
Authenticated schema rejections also produce failed tool spans without invoking
the controller handler. Conflicting request IDs produce separate failed items,
so a rejection cannot overwrite a previous dispatch outcome.
Paperclip tool spans use authenticated dispatch IDs and the name `tool <name>`.
Provider SSE records for those declared tools use `opencode tool <name>` and
remain available when failure occurs before dispatch, such as an oversized
request. These are separate observations, not correlated calls. The
`paperclip.tool.source` attribute distinguishes dispatch and provider records.
Native tools retain their provider spans without submitted-argument diagnostics. OpenCode's performance-only OTLP sink stays separate.

The exporter sends once at turn completion with a three-second deadline, at most
four requests in flight and no idle polling or persistent queue. Closing drains
pending requests and marks an unfinished turn failed. Export failures emit a
sanitized diagnostic and do not change task outcomes. Abrupt process termination
can lose an unexported turn. Recovered in-flight turns without a new submission
are not replayed just to produce an observability record.

The native runner and legacy local adapters receive transient launch material.
Native Codex writes a private managed config.toml; legacy exec uses a unique
invocation profile, preserving a selected source profile. Its profile injection
requires the qualified executable version. Codex ACPX writes its isolated home.
The legacy ACPX adapter keeps export configuration in a private home per agent
and settings compatibility key, and shares conversation files with its stable managed home;
export changes do not change its logical conversation fingerprint.
Codex receives authentication through `OTEL_EXPORTER_OTLP_LOGS_HEADERS` and
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` in its process environment. Its managed
configuration and invocation profiles contain empty header maps, so exporting
does not save the ingestion credential in those files. The bundled Rust OTLP
exporter percent-decodes environment header values; launch material encodes
them once to preserve literal percent sequences. Credentials remain literal
values in the company secret; config-file environment interpolation is not used.
A caller-owned/preconfigured Codex home cannot be automatically configured in
this version: its files remain untouched and execution emits a diagnostic.
Legacy OpenCode, other harnesses, personal Codex desktop sessions and hosted claude_managed are
outside this feature.

## Native Pi (fork)

Pi uses the same runner-owned HTTP/JSON trace exporter, selected by launch kind
`pi` and `PAPERCLIP_OBSERVABILITY_PI`. The ingestion header stays in the runner;
all reserved observability entries are removed before preparing Pi's child env
or configuration. Company export remains OFF by default, with the same four
capture switches (all ON when enabled). This does not configure the Pi plugin.

Before export, Pi protects the configured task-environment values, agent private
identity key, admitted provider and runner credentials, assigned-MCP token, and
private bind/tool socket paths. The same list builder used by OpenCode includes
literal, JSON-escaped and multiline/PEM-body forms. Initial and rotated provider
broker capabilities join the live redaction list before binding; retired values
remain protected if a later turn echoes them. Redaction precedes field truncation
and covers captured prompts, answers, tool output (including errors) and projected
command names. After exact-value redaction, the shared Pi/OpenCode exporter also
replaces recognizable unknown secret shapes with `[REDACTED:<kind>]`: private-key
PEM blocks (including escaped newlines, space-joined, rewrapped and orphan framing
with adjacent base64), GitHub, OpenAI/Anthropic, Langfuse, Slack and AWS access-key
shapes, JWTs, bearer credentials, and shell/JSON assignments whose names contain
KEY, TOKEN, SECRET, PASSWORD, PRIVATE or CREDENTIAL. Assignment names and existing
redaction marks are retained. Ordinary prose, identifiers, UUIDs and bare git SHAs
are not secret shapes. The same pure pass runs after registered-value redaction
at the server's existing recursive native API/run-log redaction boundary, after
API payload hashing and before native event persistence; it does not modify
provider inputs or raw Pi session files. Secret-name matching bounds the runs on
each side of the keyword to 64 characters to keep adversarial output scans
bounded. PEM matching also recognizes an identity redactor's `***REDACTED***`
marker adjacent to base64 material (at least one 32-character body run), including
escaped-slash JSON and partially masked bodies. This keeps short rewrapped lines
protected even when identity redaction has already erased BEGIN/END framing;
standalone redaction marks are left unchanged. It does not reorder API hashing,
identity delta processing, or native event replay.

These are conservative output heuristics, not a guarantee against all secret
encodings. Arbitrary base64 re-encoding without recognizable framing, secret
shapes split across separate streaming receipts, and formats outside this table
are not recognized. Secret-named assignments can redact nonsecret code values;
orphan PEM framing can consume adjacent base64-looking text. Choose capture
settings accordingly.

The image-N event adapter is **our code**: Pi's sink emits `turn.started` and
per-receipt `usage.reported`, not the exporter's submission/usage layout. It is
confined to the observability feed; public run receipts do not change. One
synthetic submission opens each turn; later consumed user messages (including
steers) append to that prompt with a blank line. No unconsumed input is exported.
Only available per-receipt `runDelta` contributes usage, never paired cumulative
usage items. Missing deltas are skipped, not reported as zero-token generations.
Unknown/pending subagent accounting marks the aggregate incomplete, so it does
not claim exact run totals. This is not a reconstruction of nested subagent spans.

Pi dual-emits `langfuse.observation.input` / `langfuse.observation.output` beside
`braintrust.input` / `braintrust.output`: these explicit keys populate Langfuse's
I/O panes without changing existing consumers. Spans carry native Pi `session.id`
and Paperclip company, agent, run, task (when available), and turn IDs. Known cost
also uses `gen_ai.usage.cost`; `costProvenance` distinguishes `provider_reported`
from `catalog_estimate` (or `mixed` on overflow). Estimates are not billing.

The content limit is **8 KiB UTF-8 per field**, after redaction, as in native
OpenCode. The Pi session JSONL and its custody copies remain the full record.
The first 64 tool and 64 usage spans retain detail. ONE overflow span holds the
remaining measured token/cache/cost sums and tool/usage counts; truncation and
incomplete accounting are explicit. Summing detailed usage and overflow gives
known run usage exactly once. Missing costs remain unknown and suppress the
aggregate's `totals_exact` claim. A body over 1 MiB is split on span boundaries,
keeping trace and parent IDs; each request is at most 1 MiB. Up to four turn jobs
are admitted without a turn queue; each streams its chunks sequentially under
one three-second deadline, so at most four requests are in flight. Saturation or
receiver failure gives a sanitized diagnostic, not a task failure. Terminal
receipt delivery never awaits export; session shutdown drains bounded jobs.

`@langfuse/pi-observability-plugin` and its admission remain unchanged and run
side by side until R7: a real daily task's two traces are judged, with subagent
session-file custody checked. Plugin removal requires accepted parity or Paul's
acceptance of named losses (per-call I/O, TTFT, tool arguments, subagent nesting).
This local projection is not evidence of a rendered Langfuse parity trace.

## Changes and process lifetime

Paperclip reads settings once when an execution begins preparation. That
snapshot governs instruction reservation, compatibility and launch. Already
preparing or running work retains its configuration. A changed settings
revision or resolved credential version retires an idle incompatible warm
process using existing ownership checks. Conversation compatibility is
separate, so a safe replacement can resume the saved conversation. Recovery
never replays an uncertain turn merely to apply new export settings.

Missing, disabled, invalid or unavailable configuration runs without company
export and reports a sanitized availability diagnostic where relevant. Native
export rejection/timeouts do not determine task success; exporter deadlines
are three seconds. OpenCode starts its bounded asynchronous request when the terminal event is
observed; event delivery and task settlement do not wait for the receiver.

## Credentials and access

Only board users with Manage connections permission can read or change this
configuration. Agents cannot retrieve it through the settings API. The destination stores no credential
values. Authentication headers live in one encrypted Paperclip-managed company
secret, bound to the system consumer company-observability. Updates rotate that
secret; removal uses the secret service to retire it. Braintrust project
routing is derived from the current project ID, independently of the API key.

Reads return configured status and header names. Blank existing custom header
values retain the saved secret at the same HTTP origin; a change of scheme, host,
or port requires every retained header value to be entered again. New/renamed headers require values. Removing a
row removes that header. API-key replacement is explicit, and Cancel clears
entered secrets. Revisions prevent another administrator's edit being silently
overwritten. Credential values are excluded from task environment manifests,
run/config snapshots, argv, activity records, recovery configuration and query
cache data. OpenCode and native Pi keep exporter credentials in the runner wrapper and exclude them
from its child environment and config. Codex and Claude Code receive headers through their
process environment, which their tools can inherit or inspect.
This feature does not isolate export credentials from agent code. Use a credential
limited to telemetry ingestion for the selected destination; do not supply a broad
organization administration key. A user-operated collector can hold upstream
credentials when a deployment requires a separate trust boundary.

## Connection tests

Saving never contacts the destination. Test saved settings sends one synthetic
root span and a correlated log with a unique marker from the control plane,
even when agent export is disabled. The receiver receives no production task
content. Both requests share a ten-second deadline, cannot redirect, and use
the deployment's guarded HTTP policy with DNS pinning and response-size limits.
Receipts contain sanitized HTTP/signal results and no receiver body text.
A receipt is retained only for the revision that was tested.

“Test payload accepted” means the server's synthetic payload was accepted. It
does not prove agent export, remote network reachability, downstream indexing,
or that a provider UI rendered the records. Harness exporters use their own
network clients under the execution environment's policy; the server's DNS
pinning applies only to the explicit control-plane test. Verify real tasks and
the destination's records before relying on a deployment.

## Verification

The focused suites cover schema bounds, concurrent saves, secret/header
lifecycle, authorization, protobuf transport and rejection, private-network
policy, timeout, revision fencing, environment projections, private native
configuration, warm compatibility, and UI conflict/company-switch behavior.
Storybook IDs agent-observability-01-settings, agent-observability-02-states and
agent-observability-03-journey use fake credentials and production components.
Real local/remote native export evidence must be reported separately from
these automated and synthetic checks.
