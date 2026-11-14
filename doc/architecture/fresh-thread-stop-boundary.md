# Fresh-thread stop boundary

## Why this is a core seam, not a plugin

This is the fork's stricter admission policy for the closed impossible-reconciliation
family, not a bug against upstream's stated policy. At upstream
[`c1451814c`](https://github.com/paperclipai/paperclip/blob/c1451814c155adab79fd0181674a23b0dc2669e4/server/src/services/fresh-continuation-fallback.ts#L41-L49),
the generic fresh-continuation fallback explicitly needs no proof that the old
executor stopped: it isolates the workspace instead. That remains the default
for unrelated failures. Here, a replacement provider thread on the **same
conversation** requires positive evidence that its previous execution ended.
Workspace isolation and elapsed time do not establish executor exclusion.

The existing plugin environment contract can supply allocation-bound stop or
absence evidence. In particular, `onEnvironmentStopLease` / `environmentStopLease`
stops and retains an allocation, while inspect/release/destroy provide their own
lifecycle operations. See the [current provider capabilities](../plugins/SANDBOX_PROVIDER_CAPABILITIES.md#preserving-an-unexported-workspace)
and [SDK definition](../../packages/plugins/sdk/src/define-plugin.ts).
A plugin cannot atomically intercept `continueFreshInTransaction`, the provider
session boundary reader, or the run-completion classifier under core's existing
task/coordinator/run locks. A plugin event, a successful RPC or a UI callback is
not that transaction and cannot safely decide thread admission. Adding a second
plugin recovery loop would introduce a competing owner rather than this boundary.

The runner portion stays behind the existing harness-driver/backend contracts.
It carries structured prepare/recovery refusal codes; it does not decide task
ownership or mint a server-side conversation boundary. This follows the existing
[Runner adapter placement](../../.agents/skills/create-runner-adapter/SKILL.md).
No new plugin package, public plugin hook, permission or configuration flag is
introduced by the server policy.

## Contract and existing owners

* **Input/classification:** only the five exact codes in
  [`FRESH_THREAD_REFUSAL_CODES`](../../server/src/services/native-runtime/runner-reconciliation-refusal.ts).
  Structured codes and bounded error causes survive the runner boundary. Diagnostic
  prose never grants authority. Older rows may contain a whole reserved code in
  their generic error envelope; quoted/embedded diagnostic text is not accepted.
* **Decision owner:** `continueFreshInTransaction`, under the existing task,
  coordinator, run and recovery-record locks. It checks assignment, newer work,
  approvals, questions and the person's Stop before narrating or requesting
  anything. An earlier step finishing is not an answer to a refused follow-up.
* **Read seam:** `readFreshThreadStopProof` has only `select` and
  `selectDistinctOn` capabilities. `readFreshContinuationSessionBoundary` reads a
  durable settlement and revalidates that proof. Neither reader writes a notice,
  requests cleanup, or changes a lease. Already admitted input/process/session
  identity keeps its running thread; a late boundary belongs to the next turn.
* **Write seam:** `freshThreadStopGate` uses the same proof predicate inside the
  decision owner's transaction. It requests the existing stop-only cleanup owner
  and appends/supersedes the current history notice. It never contacts a provider
  from this transaction and creates no independent scheduler, queue or timer.
* **Evidence:** the exact company/run/lease/provider/allocation-bound stop or
  destruction receipt, with valid timestamps, exclusive holder and no cleanup in
  flight; or exact local process-owner proof. A missing local identity needs a
  successful current-host process-table read showing no attributed runner. A
  missing allocation ID, foreign-host/remote launch without its allocation proof,
  unreadable process table, void release, `stopping`, expiry or timeout is not proof.
* **Output/admission:** a fenced, durable `paperclip.fresh-continuation.v1`
  settlement records source, isolation, previous-execution-gone and notice reason.
  Existing delivery and Pi/Codex selection consume it once, loading saved history
  without asserting or replaying unknown earlier effects. Every consumer still
  checks newer answers, human gates and current ownership.
* **Unavailable proof:** a projection-only `paperclip.fresh-thread-stop.v1`
  receipt says `unavailable`; it grants no admission authority. The task ends
  `failed`, with one current truthful notice and Retry, not an indefinite promise
  that Paperclip is stopping something. Retry re-runs the canonical decision
  under the task lock. A deliberate authorized click may re-arm the same validated
  stop-only cleanup intent after its automatic budget; it cannot change the
  allocation identity, interrupt in-flight cleanup, renew an export-recovery
  budget, bypass proof, or create a generic isolated executor. Automatic restart
  hooks do not renew that budget. Repaired evidence allows the existing delivery
  owner to start exactly one fresh continuation. Repeated keys join the receipt.

## Other consumers and limits

The same read-only evidence seam is usable by Pi and Codex session selection,
explicit new-input admission, task Retry, interruption projection, and the
unanswered-person-message decision. The last returns a disposition request;
its transaction-owning caller registers work so one waiting task cannot abort
another conversation's unanswered-message notice. Other harnesses with a typed
instruction/launch-contract replacement could consume this boundary without
adding a provider-specific server recovery owner. Expansion beyond the closed
code family requires an explicit policy decision; this document does not enable it.

The provider plugin remains the consumer of the existing environment lifecycle
seam and the source of independently bound physical evidence. The server owns
conversation admission; the plugin owns its allocation operation. Those are
separate contracts, not two implementations of one recovery loop.

## Verification and acceptance boundary

The independent review's upstream source/history check found no equivalent strict
stop policy at `c1451814c`; this is a bounded comparison, not a claim to have searched
every upstream issue. The current SDK and host call sites above explain the precise
plugin limit. This documents an existing fork seam rather than proposing a new
public extension API. The register is [SEAMS.md](../../SEAMS.md).

Deterministic coverage lives in `fresh-continuation-fallback.test.ts`, runtime
selection, unanswered-message recovery, imported `judge-*.test.ts`, and Runner
recovery/protocol tests. Live allocation cleanup receipts and a real daily-work
Pi/Codex conversation still require deployment-level independent acceptance.
Fixture receipts or a green source suite do not establish that acceptance.
Design-pair acceptance must be linked by the owning lead; this bounded task does
not claim it ran or approved that review.
