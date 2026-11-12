# Native child admission / S-1 lifecycle adapter

Public Pi 1.5.2 + pi-subagents 0.88.0 APIs only. No package-internal imports,
monkey-patches, executor, MCP client, tool-cap issuer, or tracing exporter.

## Parent composition (shared extension owner)

1. Connect `seam.ts`'s TEMP delegates to `../index.js`'s exact `announce`,
   `registerParkReadyContributor`, and `registerStopChildren` exports (or replace
   those three delegates with imports once shared code lands). Missing composition
   **denies** starts; contributor registration throws. `Origin.turnId` is required.
2. **Before pi-subagents' session_start handler runs**, create
   `createSubagentLifecycle({sessionId, events:pi.events, abortParent})`. The host
   may know the sessionId during factory initialization; otherwise register its
   session_start handler before the package's handler and use that context ID.
   `abortParent(signal)` must call/await Pi's parent abort, not just flip a flag.
   Dispose lifecycle/contributors on parent teardown. Host closes admission and
   revokes authority **before** stop_children; this adapter creates no authority.
3. Register `registerSubagentBridge({sessionId, childBridgePath})` using an admitted
   absolute entry path and dispose the returned public registration at teardown.
   Its static public import installs required extensions for **all** runners.
4. For every fresh leaf capture immutable parent `{epoch,runId,turnId,callId}`;
   create a scope with the actual parent `sessionId`, admitted Langfuse default
   factory entry and local `ChildBridgeSink`. Validate exact role-only bytes and
   physical model/level catalog, persist a fresh explicit Pareto/complexity/budget
   selection through `scope.prepare({roleText,selection,async}, catalog)`, then merge
   the supported `{model,async,options.extensionBindings}` fields without dropping
   other namespaces. Parent-origin defaults, stock role thinking, or omitted leaf
   selections are never admission. Installed role projections are another owner.

## F087 child start gate

In-process children consume a one-use process-global startup lease. Each native
child start calls `announce(toolCallId, capturedParentOrigin)` before the local
journal sink. The sink ACK is separately awaited. Pi can swallow notification
exceptions: `tool_call` independently blocks missing/failed/replayed ACKs.
Model/level readback, required tracing startup, revoked-origin completion, SDK
abort and observed `agent_settled` gates are preserved.

An explicit `async:true` preparation includes plain startup evidence in the
supported `extensionBindings` namespace, not a credential/capability. A separate
runner process consumes it once, requires `PAPERCLIP_PI_BIND_SOCKET`, verifies
actual SDK model/level, and sends schema-1 socket `announce` with a nonce, parent
sessionId, **native** toolCallId and the captured required Origin. It waits for
`{ack:true}` before tool dispatch. Refusal, absence, wrong correlation, timeout,
or cancellation denies the call. The parent owns the socket's private runtime
and active-origin authorization; no alternate socket is discovered or opened by
this lane. pi-subagents preserves this env in its real async launcher spawn.

The agreed socket seam does **not** allocate host child turns or journal child
ready/end receipts. Remote labels `native:<childSession>:<turnIndex>` are local
SDK correlation only, **not host-started turns**. In-process sinks retain their
host-owned child-turn contract. Any richer remote host ledger/trace correlation
requires shared-owner composition, not invented wire kinds here.

A reused/retained session with existing messages cannot claim fresh socket
startup admission; a settled bridge is closed. Missing/replayed local leases,
missing remote evidence, old Origin rejected by a new bind, and unknown previous
saved state stay blocked, with state intact. Loader-factory failures are kept as
an installed **permanently denying** extension rather than thrown away: real Pi
otherwise swallows the failure and can run tools without its gate.

## S-1 park / Stop

Install the documented pi-web liveness registry only when absent. Never overwrite
an existing host registry. For this session, a pi-subagents registration must be
seen and **every** registered provider must return exactly false. Missing,
opaque/replaced registries, thrown/nonboolean provider state, owed completion/wake
work, and prior stop uncertainty block park. The register-only public protocol
cannot inspect an existing foreign registry; coordinate its observation with its
host owner instead of guessing idle.

`stopAll(reason, signal)` subscribes first, awaits parent abort, uses the real
`subagents:rpc:v1:request`/reply envelope to get asyncSnapshot roots, and sends
`stop {id}` per root. It records exact runner-instance proof from targeted status,
then accepts only `subagent:process-terminal` observed for that same run/instance
or targeted `details.lifecycleStatus.processTerminal` observed. A changed runner
instance cannot be settled by an old observed event. Results, DTO status complete,
stop ACKs, missing PIDs and foreground display keys are never terminal proof.
After observations, session liveness must also be idle. Timeout/cancellation,
missing proof or incomplete status stays uncertain and keeps park blocked.

0.88.0's public status RPC has **no cursor/page parameter**. Omitted roots, nested
children or byte caps therefore remain explicit uncertainty (visible roots are
still stopped); no fabricated pagination or all-children-stopped claim. Targets
are handled independently so one unanswered status cannot hold back other stops.
Event notifications drive refresh; bounded timers exist only for an active RPC/Stop.
There is no idle polling. Disposal cancels active waits and releases subscriptions.

`scope.revoke()` only fences/aborts its **local** SDK handles. Async preparations
remain `unconfirmedAsyncSelections` and cannot turn an empty local child map into
settled success. Use the registered lifecycle Stop/park barrier for remote work;
host must also abort the original package tool signal and enforce epoch checks.

## Evidence scope

Default-on tests include the original four real-SDK synthetic-model canaries,
fake liveness/RPC failure-path tests with real envelope/event names, real UNIX
socket tests, five separate-process real-SDK socket canaries, and an actual
pi-subagents extension/SDK liveness + idle-status-RPC canary. Its public async
launcher deliberately writes only the bind-socket env and exits before runner
startup: it proves the real package's spawn environment, **not** a successful
package child/provider run. No real provider, credentials, Langfuse delivery,
durable host ledger or ordinary daily-work release acceptance is claimed here.
