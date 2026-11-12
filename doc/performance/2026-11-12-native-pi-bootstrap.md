# Native Pi bootstrap: compare runtime-context contents before upload

This is an implementation handoff, **not a claim that the cold-start target is met**. The 2026-11-12 22:12Z builder brief gives 9.3 s overall, `runner.transport.ready` 4.4 s, `runner.prp.authenticate` 1.25 s, runtime-context staging 2.9 s and `runner.ingress.wait_for_process` 3.1 s. Those spans are nested/overlapping, not independent costs to add or subtract.

## (a) Runtime-context content comparison

`server/src/services/native-runtime/remote-launch-assets.ts` collects instruction bundles, each selected skill bundle and `runtime-context.json`. `remote-runtime-assets.ts` computes local SHA-256 fingerprints and obtains all remote fingerprints in **one command invocation**, independent of the number of bundles/files. Only mismatching assets go through the existing upload callbacks.

Local filesystem reads are asynchronous and sequential within the hash walk, avoiding synchronous filesystem work on the server event loop and keeping only one file's bytes per walk. The remote walk runs synchronously in its dedicated command process. Fingerprints cover actual contents, relative paths, empty directories and executable bits. A standalone context file also has to retain its explicit private mapping mode. Archive-normalized directory/write modes do not cause permanent false misses. A symlink, absent/changed file, invalid result or unavailable hash command is not a cache hit. If local hashing is unsupported or remote comparison fails, the existing upload path remains authoritative.

Authentication/configuration files, CA material, writable provider homes and Codex's isolated discovery projection are deliberately **not** put in this cache. They retain their existing staging and cleanup contracts. The existing concurrent sandbox staging path remains available; its test observes actual context-transfer entry rather than assuming hashing completes in one event-loop turn.

Expected after, conditional on a retained exact copy: one remote hash invocation plus local/remote hashing and uploads of just the changed assets; unchanged bundles upload zero bytes. There is no measured remote duration in this task. An empty first-use filesystem still needs the full upload and pays one comparison command: this change alone cannot establish a <=5 s truly empty cold start.

The real-filesystem tests in `remote-runtime-assets.test.ts` and `remote-launch-assets.test.ts` cover missing/unchanged/changed copies, missing files after a previous hit, paths, empty directories, executable bits, private context permissions, symlinks, probe failures and both SSH/sandbox staging paths. They do not establish real daily-work latency or replace required CI and live qualification. Transport/auth overlap and exact process readiness are separate spans, not claimed as implemented by this asset-staging change.
