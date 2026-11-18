# Fork seam register

This register records fork-owned boundaries, not extra public SDK promises.
Each entry names the existing upstream owner, the plugin limit and the consumers.
It is not a statement that deployment or design acceptance has passed.

| Seam | Existing owner / why not an external plugin | Contract and consumers | Acceptance |
| --- | --- | --- | --- |
| Import people attribution (existing portability and bulk-writer seams) | Core owns bundle parsing, preview and atomic task/comment writes. An external plugin cannot validate full-bundle people before those writes or supply these batch columns. No new public plugin hook is added. | Optional `userCommentAuthorEmail` and complete `taskPeople` inputs share one preview/apply preflight. Existing-company users require active target membership; new-company users need only an unambiguous instance identity. Missing options preserve legacy attribution. | Real PostgreSQL regressions cover rejected identities, explicit nulls, read-only preview and relay metadata. Live migration and release acceptance remain lead-owned. |
