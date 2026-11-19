# Captured take

READER: testing-lead

Server: gate4; issue: 0c8b537d-5135-4a01-8510-1e777a997cee.
Window: 2026-11-19T08:33:00+00:00 — 2026-11-19T08:40:00+00:00.

## Reported screen/take context

Testing-lead reported: first real steered-message take. Run fcdf9174-b883-404d-85fa-46f9b22d2895 retains steering_acknowledgement at seq265, userMessage at seq271, agentMessage at seq296 and final channel at seq310. Every event seq260–320 is retained in ascending order. Steered comment ID: 1d278747-bf32-469d-b649-e2ae977a1a74.

The exporter did not re-observe the screen. It captured current persisted DB rows selected by this window plus full declared forward FK closure. Closure may include rows outside the window; no deleted rows or earlier versions are reconstructed. Message text is never retained. The MANIFEST lists every redacted path and all load-only synthesized user fields.
