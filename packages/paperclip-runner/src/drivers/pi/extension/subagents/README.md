# In-process native Pi child gates

Build lane for F085, F087, F084. Uses Pi 1.5.2 and **public**
`pi-subagents/required-child-extensions` from 0.88.0. No package internals,
factory replacement, Boat placement, executor, MCP client, tool capability
issuer, or tracing exporter.

## Host composition (not installed by this lane)

1. On parent `session_start`, call `registerSubagentBridge` with the real parent
   `ctx.sessionManager.getSessionId()` and the admitted absolute **file** path of
   `child-bridge.js`. Dispose the registration on shutdown/reload.
2. After the host has verified the committed origin and outer native subagent
   call, create a scope with `{ origin: { epoch, runId, turnId, callId }, closure,
   sink }`. Do not derive origin from tool input or a live "current run" getter.
3. Resolve the actual role bytes and an explicit selection for **each** leaf
   (direct, review, fan-out, nested, retry). Call `scope.prepare` before package
   dispatch. Merge its `model`, `async: false`, and `options.extensionBindings`
   into that leaf's supported public package fields. Keep other binding
   namespaces. Do not send the unshipped `executionMetadata` option.
4. A selection includes `selectionId`, `roleId`, exact-byte SHA-256 `roleDigest`,
   `paretoRevision`, `paretoChoice`, `complexity`, `rationale`, JSON `budget`, and
   explicit `model: "provider/id:level"`. The host-supplied catalog must resolve
   the physical child family and supported levels. Unknown physical routing is
   refused; effective-Claude `max` is refused, never clamped. The parent's
   environment, model, effort, and role runtime defaults cannot fill omissions.
5. The one-use startup binding associates an SDK child with an already-captured
   scope across Pi's extension-cache resets. It is **not** a tool grant or reusable
   provider credential. Missing, replayed, old-process, or revoked bindings fail
   required-extension startup. This is trusted in-process extension code, not an
   isolation boundary against arbitrary code in that process.
6. Supply `closure.langfuseExtensionPath` as the admitted importable extension
   **entry file** under the snapshot's `/opt/pi-packages/langfuse-pi`, not a guessed
   directory import. The bridge imports and invokes its existing default factory
   before `session_start` so its startup hooks run. No claim of trace delivery
   follows merely from successful loading.
7. SDK ACK reads `ctx.model`, `pi.getThinkingLevel()`, and the child's session ID;
   it compares them to the admitted selection. There is no child RPC connection
   or invented `get_state` response. RPC parents still use the existing
   `admitPiRpcSession`; its RPC command port does not apply to SDK children.
8. Implement `ChildBridgeSink` on code-lead's private fd-3 host channel. Persist
   selection and readiness, allocate/journal a host-started child turn, and ACK
   each raw child `tool_execution_start` before resolving `true`. The child's
   native call ID is not the outer subagent call ID. Grant/owner/generation,
   authorization, durable replay, body-read epoch checks, and settlement remain
   host-owned. A parent progress/result payload is not a child announcement.
   Sink failure must never mean success. Because Pi notification exceptions can
   be swallowed, a separate `tool_call` gate refuses a missing/failed ACK.
9. On Stop/rebind/settlement, revoke host authority first, call `scope.revoke()`
   for all associated descendant scopes, and abort the original package tool via
   its existing signal. The attached bridge also uses public child `ctx.abort()`
   (the SDK abort underlying package child abort). A void abort request is not
   terminal proof: `stopReceipt()` retains unconfirmed sessions until
   `agent_settled`, or an idle startup shutdown. Active shutdown alone is not
   confirmation; abort errors remain `uncertain`. Late events retain their old
   immutable origin and last known child turn. They cannot spend a new scope.

## Deliberate limits / previous-state story

Only attached foreground, in-process children are prepared here. Detached or
retained launches cannot acquire a process-local startup binding; they fail
closed before a child prompt, with a named `pi_child_binding_missing` error.
No per-child placement or upstream hook is introduced to make them work.
Process restart likewise refuses old one-use bindings rather than recovering
new authority from a saved run. The host must provide any future detached
channel/selection integration; do not silently enable async or retained resume.

`validateRoleTemplate` validates without rewriting bytes. Stock 0.88.0
`agents/worker.md` contains `thinking: high` and is **not compliant**. Native-home
must install role-only templates separately; this lane does not edit upstream
package files.

Tests use controlled child objects and actual Pi SDK sessions with synthetic
offline streams, including native nested tools and a cancellation nonce oracle.
They do not run the actual package's foreground factory, a real model, the
fd-3 host ledger, real Langfuse delivery, HQ, or Boat. Those are integration
acceptance requirements, not local passes. No timer or background worker is
created by these modules; lifecycle is driven by host calls and SDK events.
