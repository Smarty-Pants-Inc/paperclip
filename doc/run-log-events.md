# Run-Log Events

Run-log events are rows in the `heartbeat_run_events` table
(`packages/db/src/schema/heartbeat_run_events.ts`). They stay in the instance
database. They are not Paperclip Telemetry events and not OpenTelemetry
exports, and they need no operator endpoint. See `rules/data-paths.mdc` for how
the three data paths differ.

This file does not list events or their payloads. Each event is defined where
it is written: search for the event name as a quoted string under `server/src`
and `packages` to find its producer and payload. Payload limits are defined in
`server/src/services/heartbeat/run-log.ts`; the storage codec lives in
`packages/db/src/run-event-payload.ts`. The server appends events through
`appendRunEvent` in `server/src/services/heartbeat.ts`.

## Saved native conversations

The conversation event view retains assistant items, visible reasoning lifecycles,
ordinary tool calls/results, canonical tool execution updates, and workspace change
boundaries. It is a display projection, not a replacement for the full inspector.
Successful Plan-write receipts still omit their document bodies. Native saved turns
must hydrate this projection rather than substitute a saved reply body for tool rows.

`get_task_history` uses the same persisted native stream alongside its comment page.
A linked saved agent reply has `visibleTurn` with composed `text`, ordered `rows`
(`text`, `tool`, or `activity`), run/turn/session IDs, and `fromSeq`/`throughSeq` event
references. Tool rows carry a name, status and short summary; tool input/result JSON
and reasoning bodies are not copied into agent context. Unfinished tools at a settled
reply boundary are interrupted, not successful. Non-native comments and unrelated
agent notes keep their comment-only representation. Source-trust quarantine applies
to the stream as well as the saved body; promoting one comment does not promote its
raw run transcript.

Pages select up to `limit` newest comments (default 50, maximum 200) and return them
chronologically. Pass `nextCursor` as `cursor` for the next older page, until `hasMore`
is false. The cursor is scoped to the active task and company. A saved reply's
continuous item/comment identity selects its exact segment, so later replies in a
held run cannot replace earlier tool rows.

## Payload storage

Structured events remain in `heartbeat_run_events`. When the instance's existing
file storage uses S3, new stdout/stderr NDJSON logs use the same stack bucket
and configured prefix under `run-logs/`, with existing run references in
Postgres. Local-disk instances remain local. Raw provider traces have their own
restricted, encrypted object path. See
[run evidence storage](run-evidence-storage.md) for batching, durability,
configuration, migration, retention, and qualification boundaries.
