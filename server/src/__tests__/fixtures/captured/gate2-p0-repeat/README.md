# Captured take

READER: testing-lead

Server: gate2; issue: 82decabe-17a4-4d40-b4d0-8248be214186.
Window: 2026-11-19T07:40:00+00:00 — 2026-11-19T07:53:00+00:00.

## Reported screen/take context

Testing-lead reported: Interrupt cancelled the original run; a native_continuation_requires_reconciliation action followed; the two queued follow-up comments were split over separate successor runs. This is preserved failure evidence, not a product fix.

The exporter did not re-observe the screen. It captured current persisted DB rows selected by this window plus full declared forward FK closure. Closure may include rows outside the window; no deleted rows or earlier versions are reconstructed. Message text is never retained. The MANIFEST lists every redacted path and all load-only synthesized user fields.
