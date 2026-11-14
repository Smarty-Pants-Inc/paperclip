# Fork seam register

This register records fork-owned boundaries, not extra public SDK promises.
Each entry names the existing upstream owner, the plugin limit and the consumers.
It is not a statement that deployment or design acceptance has passed.

| Seam | Existing owner / why not an external plugin | Contract and consumers | Acceptance |
| --- | --- | --- | --- |
| Strict fresh-provider-thread stop boundary (D10; existing internal seam, no new public hook) | Extends core's `continueFreshInTransaction` / session-boundary read. Environment plugins can provide bound physical stop evidence but cannot interpose an atomic admission decision under core's task/coordinator/run locks. Upstream `c1451814c` deliberately permits generic isolation without old-executor stop proof; this fork's closed family deliberately does not. | [Read/write/proof contract, typed family, Retry and other consumers](doc/architecture/fresh-thread-stop-boundary.md). Pi/Codex selection, explicit input, task Retry and unanswered-message recovery reuse the one existing continuation and cleanup owners. | Deterministic regression coverage in source; live provider/daily-work proof and lead-owned design-pair acceptance must be linked before release. No approval is implied here. |
