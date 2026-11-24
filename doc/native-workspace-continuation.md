# Settled Pi workspace continuation (0343)

For native Pi with `sessionContinuity: continuous`, a newly admitted **local**
workspace can continue the same normalized/provider session. Workspace admission
still owns access and settlement. Checkpoint rebind keeps all task, agent,
provider, schema and home checks, and sets the recovered cwd to the admitted
directory. 0342's O4 whole runtime-context waiver remains authoritative for
continuous Pi; this seam does not narrow it. An unfinished goal is not portable.

The executor verifies the exact recorded prior execution and its terminal,
suspended owner, then reuses the existing atomic state-root rename. The same
admitted source is recognized if a launch retries after the rename. Missing or
unverifiable source state is not claimed: the existing typed
`native_provider_state_incompatible` failure stops the run visibly. Retry starts
a fresh task session through the existing recovery door and fresh-start marker. Active-owner and
target-conflict fences remain in force. Other modes retain their stock path.

The integration-owned Pi driver (code-lead's pkg107) owns the header-cwd rewrite
and one directory-change notice on the next accepted prompt. No driver change
belongs to this product seam. Uncommitted files in old workspace X stay in X;
the agent is told only that the directory changed.

Remote/different-machine relocation is not qualified by this local first build;
it needs its own take and the source-execution backup-manifest restore path.
No installed daily-work take or product-owner acceptance is claimed here.
