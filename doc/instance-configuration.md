# Instance configuration switches

Environment switches and startup configuration that are not part of everyday local development.

## Internal Connection Token Brokers

Paperclip Cloud connector identities support `development`, `test`, `staging`,
and `production`. To enroll a self-hosted instance against the test broker, set
`PAPERCLIP_CLOUD_CONNECTOR_BASE_URL=https://test.paperclip.app`; its environment
is inferred as `test`. Managed instances also receive
`PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT=test`. Standard Cloud broker hosts reject
identities for another environment, and enrollment keys remain local to the
selected broker.

Connection token exchanges carry a resolved parent credential, so their URLs
are public-only by default even in local/private deployments. To intentionally
use an internal broker, configure an exact hostname allowlist:

```sh
PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS=broker.internal.example,10.0.0.42
```

Entries are comma- or whitespace-separated exact hostnames (no wildcards). The
host configured by `PAPERCLIP_PAGES_API_URL` is included automatically. Every
broker hostname is resolved once and the request is pinned to the approved
address; IPv4 and IPv6 link-local destinations remain denied even when their
host is allowlisted.

## HTTP Adapter Private Endpoints

HTTP adapters can call public HTTP(S) endpoints by default. Requests use the
same DNS-pinning guard as remote connections, do not follow redirects, and
reject loopback, RFC1918/private, and link-local or cloud-metadata destinations.

Server owners can opt a trusted private service in with a comma-separated list
of exact origins:

```sh
PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST=http://hooks.internal.example:8080,https://10.0.0.42
```

Each entry must contain only a scheme, hostname, and optional port. Paths,
credentials, query strings, fragments, and wildcards are ignored. Matching is
by exact normalized origin, so allowing one port does not allow another.
Link-local destinations remain denied even when explicitly listed.

## Private defect-report destination

Instance admins may set the optional `defectReportDestination` in the existing
`PATCH /api/instance/settings/general` body:

```json
{"defectReportDestination":{"label":"Private instance support","url":"/issues/private-support"}}
```

The place must be private on this instance: run links and task titles are
private content. Use the real private task or report place your instance
maintainers have chosen, not the example path above. URLs must be root-relative;
absolute URLs, protocol-relative URLs, backslashes and whitespace are rejected.
Labels are bounded to 200 characters and accept only letters, marks, numbers,
spaces and simple name punctuation (`' & ( ) , -`), not URLs, email addresses,
domain-shaped strings or markup. A successful destination save returns the HTTP
`Warning` header `299 Paperclip "Only a private place on this instance: run links and task titles are private content"`.
The JSON settings response remains unchanged. Choose an actually private,
access-controlled place that the intended reporters can use; a same-instance
path is not proof of its privacy, existence, accessibility or redirect behavior.
The server does not submit a report or copy diagnostics automatically.

The label and path are not admin-only secrets: any authenticated board member
of any company on this instance, instance admin, or trusted local board actor
can read general settings. The full settings GET and company activity logs also
carry the setting; report-bearing refusal projections use the same instance-wide
value, not a per-viewer access check. Use a generic label safe to disclose
instance-wide. Only an instance admin or trusted local board actor may save it.
An unreadable stored destination becomes `null` without resetting any other
general setting, including an explicit execution-mode pin.

Absent or `null` means the plain instance-admin handoff sentence, with no public
tracker default. Set `null` to clear an existing destination. Refusal projection
reads the current setting, so an old run shows the current destination without
rewriting its saved evidence. `report_defect` is projected as
`{kind: "report_defect", destination: {label, url} | null}`; other routes remain
labels. The shared page contract is `TaskInterruptionPresentation.failure.cause`.
A missing legacy remedies field projects to `[]` (text only). An unmarked saved
`[]` also stays text-only: v11 normalized a missing remedies field to that shape.
New action-bearing errors carry `remediesVersion: 2` in both structured and
serialized evidence. A marked empty list can use this reader's kind/measure
routes on version skew; compatible known rows still do not invent omitted
routes. Unmarked nonempty v12 lists retain the existing read behavior. Unknown
provenance versions are text-only. This reader uses its own kind/measure routes,
not a newer writer's incompatible action list.

Message-specific causes carry `commentIds` for the inputs actually counted.
These are targets, not permissions. The page must check the current message's
author, queued/editable and deleted state before offering edit/delete. Legacy
causes may have no IDs; do not guess the target from the newest visible message.
Serialized causes require the closing `]`: a cut marker supplies no cause, IDs
or actions and uses the existing readable fallback. Valid structured evidence
still takes precedence over the error string. The run page retains the sentence
saved at failure time; only the task refusal projection resolves today's setting.

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## Cloud startup configuration

Cloud stores nonsecret startup choices in a private PostgreSQL singleton.
Bootstrap connection credentials stay in the supplied environment. A bounded
one-time config-file seed preserves existing choices, then later starts use the
database without loading home `.env` files or repairing worktree config. See
[Cloud runtime configuration](cloud-runtime-configuration.md) for field ownership,
secret handling, initialization order and migration interfaces.
