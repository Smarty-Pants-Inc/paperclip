# Captured failing state

READER: testing-lead

Server: gate4; issue: 3e21230b-8b39-433c-86e4-b819b73cc70f; window: 2026-11-19T08:54:00+00:00 — 2026-11-19T09:00:30+00:00.

## What the screen showed (caller fills this in)

Testing-lead reported: a message sent just after the original run ended triggered a new run that failed native_run_failed, before a third run answered. The exporter did not re-observe the screen. Complete event sequences retained: 99ad41ce seq1–468; f5a19940 seq1–289; 038baba6 seq1–400. These three runs fall inside 08:54:00–09:00:30Z. The FK closure additionally requires an earlier cancelled run c56b9ac7; its outside-window events were not requested or captured.

This export contains current persisted rows selected by the window, plus forward FK closure. It does not reconstruct deleted rows or historical values.
