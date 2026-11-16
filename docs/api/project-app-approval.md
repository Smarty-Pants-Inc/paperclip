# Project GitHub App approval

This fork-owned seam records the current responsible human's approval of a
provider-verified project App tuple. It is **approval**, not a claim that the
human historically created the App or clicked GitHub Install.

The ordinary custom App setup remains the provider owner:
[`doc/connections/GITHUB-APP.md`, Setup steps 1–5](../../doc/connections/GITHUB-APP.md#setup).
That feature verifies the App/key/installation/repositories but does not record
this project approval. The protected writer and internal reader below are the
judged option-B custody seam; no new database table or plugin credential API is
introduced.

## Approve or revoke

```http
POST /api/companies/:companyId/tools/connections/:connectionId/project-app-approval
Origin: <the configured trusted Paperclip browser origin>
Content-Type: application/json

{"action":"approve","projectId":"<project-uuid>"}
```

Use `"action":"revoke"` on the same endpoint to revoke the saved receipt.

Requirements:

- A real authenticated board **session**, not a board API key, agent token,
  delegated responsible-user ID, plugin tool, or local implicit actor.
- A present trusted browser Origin. A foreign Origin is not rescued by Referer.
- Company access and the current `companies.defaultResponsibleUserId` user,
  with an active owner/admin membership. Another administrator cannot approve.
  H is **one human per company**, approving every project's App. A per-project
  designee is a known future extension, not current behavior.
- An active project and an unowned shared GitHub App source TOOL connection in
  that company, with its exact company-vault private-key reference and one active
  organization grant. Draft source connections are permitted.
- The existing row-12 installer is ready/enabled, its native config contains a
  valid numeric `managerAppId` and `managerKeyAnchorProjectId`, and its dedicated
  `github-manager-key` anchor has the active W1 plugin-owned instance secret.

Approval verifies the App with its own JWT, the installation's canonical App
identity and suspension state, and the exact selected repository IDs using the
existing GitHub App client and a restricted installation token. Neither the PEM,
JWT nor provider token is returned. The receipt and IDs-only activity row commit
in **one transaction**, after rechecking current H, source/grant/key state,
project and manager classification. A failed activity insert rolls back the
receipt. Repeating the same live approval returns its existing receipt without
another provider token mint, receipt or activity row.

Successful approval/revocation returns HTTP 200 with the value-free receipt:

```json
{
  "version": 1,
  "id": "<receipt-uuid>",
  "companyId": "<company-uuid>",
  "humanUserId": "<current-H-user-id>",
  "projectId": "<project-uuid>",
  "appId": "123",
  "installationId": "456",
  "repositoryIds": [101],
  "secretRef": {"secretId":"<secret-uuid>","configPath":"credentials.privateKey"},
  "verifiedAt": "2026-11-16T00:00:00.000Z",
  "revokedAt": null
}
```

Revocation sets `revokedAt`; it never deletes the audit history. H's same
session authority may revoke a consumed, archived source S. This records one
IDs-only `tool_connection.project_app_revoked` activity row, without un-archiving
S, reopening a reservation or deleting any source/consumer/binding. A repeated
revoke is idempotent. Approve cannot resurrect a consumed source. The next AND
every later credential release or forced refresh is refused with
`project_app_approval_required` (the existing revoked-receipt refusal).

Generic create,
PATCH, config replacement, gallery/import or plugin connection writers cannot
mint or alter `config.projectAppApproval` or its protected source pointer.

## First bind and use

After H approves the source, H's current primary uses the existing reference-only
`POST /api/companies/:companyId/tools/connections` route with `projectId`, the
same App/installation/configured repository subset and exact
`credentialSecretRefs`. Do not submit a receipt or `projectScope` in the request.
The server finds the one exact live approval, verifies the provider identity
before reservation, writes the protected project scope and source pointer, and
creates the organization grant and ordinary take activity atomically. The
approved lead finishes that saved candidate through the existing finish route.
The gallery's raw-key form is not a reference-only project create surface.

A receipt-citing create archives and links ONLY its own approval source S, in
one transaction with its owned connection, grant, take and consumption activity.
No source is deleted. Failure leaves S live and its receipt unused; replay is
refused. Under RFL's 05:56Z replacement, receipt-citing creates for the same
installation OR App registration arbitrate on owned rows. Exactly one EXCLUSIVE
create wins; the loser's source remains live, unconsumed and readable, with its
receipt unchanged. Ordinary non-receipt writers still see source reservations
under the existing alias/exclusivity checks. A receipt never consumes another
project's approval.

Only project-owned connections (`projectId` non-null) require this receipt:
one internal fact-only reader checks the saved source at first bind, finish,
management/re-scope admission and credential release. Agent, personal, shared
and delegated non-project connections do not require a project approval. Changing H, revoking or
archiving the source, disabling its organization grant, changing the tuple or
losing classification refuses the old receipt. A new H must approve again;
old primary/lead scope is not silently rewritten. Board-human removal authority
remains available through the existing authorized removal path.

Git/gh and MCP use the existing credential owners. Project provider verdicts
are cached for at most **60 seconds**, isolated by company/connection/grant,
configuration and key version. Local receipt mutations and already-authenticated
installation/repository webhooks invalidate cached verdicts. Revocation and H
are read from the database on every release, including cache hits. A suspended
installation, changed stable repository IDs or mismatched verified App identity
refuses release. A token minted BEFORE local revocation remains valid until
its provider expiry: a GitHub App installation token lasts at most **60 minutes**.
The local off switch blocks later releases and refresh/mints; it does not recall
an already-exported provider token.

The classified manager reference is refused before key resolution and its
verified numeric App ID after provider verification, including Client-ID aliases
and ordinary/non-project App connection creation. Native row-12 config
replacement is session-only when it writes, preserves or removes `managerAppId`
or the key anchor field; board keys cannot change or erase the classification.

An instance/company with no C4 manager configuration and no retained W1 manager
key/anchor has no manager App to exclude: ordinary non-project App setup and
credential release retain their existing behavior. A configured but unreadable,
malformed, disabled or incomplete manager classification fails closed on every
path, including non-project paths. Removing C4 config while retaining W1 custody
does not turn that state into “not configured.” Project approval/first binding
still requires ready C4/W1 custody; absence never substitutes for a receipt.

## Named failures

| Code | HTTP | Meaning |
| --- | --- | --- |
| `project_app_board_session_required` | 403 | Not a board session |
| `project_app_browser_origin_required` | 403 | Missing or foreign browser Origin |
| `project_app_approver_not_responsible_human` | 403 | Actor is not current H |
| `project_app_receipt_protected` | 403 | Generic writer attempted a protected field write/erase |
| `project_app_approval_required` | 403 | Missing/revoked/mismatched/old-H receipt |
| `project_app_manager_forbidden` | 403 | Manager reference or canonical App identity |
| `project_app_manager_classification_unavailable` | 403 | Configured native classification unreadable/ineligible, or required project C4/W1 custody missing |
| `project_app_manager_config_session_required` | 403 | Board-key manager config replacement |
| `project_app_approval_state_changed` | 409 | Source/authority/key changed during verification or a wait |
| `project_app_verification_unavailable` | 503 | Provider verification unavailable; no project credential released |

Provider response bodies, tokens and keys are never included. Malformed input
uses the existing API validation error contract. Tests with controlled GitHub
HTTP and real PostgreSQL/vault prove server behavior only; they are not live
provider, production rollout or real daily-work qualification.
