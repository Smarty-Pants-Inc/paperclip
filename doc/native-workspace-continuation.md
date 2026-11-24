# Settled Pi workspace continuation (0343)

For native Pi with `sessionContinuity: continuous`, a newly admitted **local**
workspace can continue the same normalized/provider session. Workspace admission
still owns access and settlement. Checkpoint rebind keeps all task, agent,
provider, schema, home and tool-contract checks, and sets the recovered cwd to
the admitted directory. An unfinished goal is not portable through this seam.

The executor verifies the exact recorded prior execution and its terminal,
suspended owner, then reuses the existing atomic state-root rename. The same
admitted source is recognized if a launch retries after the rename. Missing or
unverifiable source state is not claimed; normal fresh-session recovery and the
existing fresh-start marker remain responsible for fallback. Active-owner and
target-conflict fences remain in force. Other modes retain their stock path.

The separately built integration-owned Pi driver must carry the matching 0343
delta: change only the JSONL header cwd before spawning Pi, preserve the session
ID and remaining bytes, and include one directory-change notice on the next
accepted prompt. Its identity cwd is acknowledged only after `started`.

Remote/different-machine relocation is not qualified by this local first build;
it needs its own take and the source-execution backup-manifest restore path.
No installed daily-work take or product-owner acceptance is claimed here.
