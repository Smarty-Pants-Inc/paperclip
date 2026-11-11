# Budget — read-only

A company-scoped Paperclip SDK page, sidebar entry and dashboard widget. Native Costs/Budgets continue to own cost-event accounting and monetary policy. This plugin adds one monthly envelope with current and previous category coverage. It has no jobs, event consumers, actions, intake, holds, releases, agent writes, account selection, gateway access or purchases.

## Runtime and build

Pinned source/SDK: Paperclip `2026.1111.0-canary.4`, commit `fcf4e39b41df0b871c1391566f911b39b8af1b71`. Build from that workspace, not moving master:

```sh
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm --filter @smarty-pants/plugin-dynamic-budget typecheck
pnpm --filter @smarty-pants/plugin-dynamic-budget test
pnpm --filter @smarty-pants/plugin-dynamic-budget build
```

The SDK's official esbuild presets bundle the worker and externalize host UI modules/React. Manifest is self-contained. Deploy `package.json`, `dist/`, `migrations/`, and this README; no workspace node_modules or credentials. The operator uses a local-path artifact under the documented [local plugin development contract](../../../doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md); publishing to npm is not part of this slice.

## Installation and reads

Only an authorized installer runs lifecycle operations. Copy the artifact **inside the target** first, verify its checksum and `GET /api/health` against the pinned runtime, then:

```json
POST /api/plugins/install
{"packageName":"/absolute/path/inside/target/plugin-dynamic-budget","isLocalPath":true}
```

Save returned plugin UUID as `PLUGIN_ID`. Configure only the authorized company:

```json
POST /api/plugins/PLUGIN_ID/config
{"companyId":"COMPANY_UUID","configJson":{"importJson":"SERIALIZED_SCHEMA_1_DOCUMENT"}}
```

Then `POST /api/plugins/PLUGIN_ID/enable` if not already ready. Read `GET /api/plugins/PLUGIN_ID`, `GET /api/plugins/PLUGIN_ID/health`, and `GET /api/plugins/PLUGIN_ID/config?companyId=COMPANY_UUID`.

Data reads use the host's documented POST bridge (not a mutating plugin action):

```json
POST /api/plugins/PLUGIN_ID/bridge/data
{"key":"budget","params":{"companyId":"COMPANY_UUID"}}
```

Open the company's **Budget** sidebar entry (`/COMPANY_PREFIX/dynamic-budget`) and dashboard widget. Refresh only rereads stored evidence. No provider observation is refreshed by reading this page. Errors remain visible and do not become zero.

Disable: `POST /api/plugins/PLUGIN_ID/disable`. Re-enable with `/enable`. Removal: `DELETE /api/plugins/PLUGIN_ID` **without `purge=true`**. Preserve source evidence, audit and raw traces independently; do not purge. There are no budget blockers to release in this phase. Never restart Paperclip core, Postgres, gateway or tunnel for this plugin.

## Capabilities and instance-wide installation

Installation and enable/disable are instance-wide. Config is company-scoped. With no company policy, the page and widget show **Not configured for this company** and the worker runs **no source queries**. No company receives default data, categories or amounts. A config import with another company's UUID is rejected.

The pinned [plugin authoring guide](../../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md#plugin-database-declarations) requires `database.namespace.read` **and** `database.namespace.migrate` for a `database` declaration. The host manifest validator (`packages/shared/src/validators/plugin.ts`, `if (manifest.database)`) enforces both, while its database schema requires `migrationsDir`. The same declaration is needed to allowlist native `cost_events`/`heartbeat_runs` reads. Therefore the package declares namespace migration capability with an **empty SQL migration directory**. It does not create private tables, store imports in its namespace, request `database.namespace.write`, or migrate core tables. Imports remain company config. The focused tests exercise the actual pinned host manifest schema, including rejection when the required migration capability is omitted.

## Company configuration

There are **no built-in payer names, budget amounts, commitments or private policy links**. There is one monthly envelope, not a sum of category limits. There are no per-category caps or provider dollar lines. Category allocations can change without a transfer mechanism.

A schema-1 import has `companyId`, `records`, and `notes`, plus optional `policy`:

```ts
{
  payer: string;
  monthlyEnvelopeUsd: string; // exact nonnegative USD decimal
  categories: { id: string; label: string }[]; // unique lower-case identifiers
  nativeInferenceCategory?: string; // must name a configured category
}
```

An absent policy stays unknown, not zero. Imported records must use configured category identifiers. The optional native-inference mapping determines where native metered cost evidence can appear; no provider mapping or allocation is invented. The UI presents only configured category labels and one total envelope.

Each record has unique `id`, `category`, independently-priced `coverageKey`, UTC `from`/exclusive `until`, exact decimal-string `usd`, `kind` (`commitment`, `accrual`, `actual`, `reservation`, `uncertainty`), `source`, `observedAt`, positive integer `revision`, optional `unresolved`. An aggregate inference commitment is a sourced record, not a second envelope or a paid invoice. No secrets or raw provider/account identifiers belong in imports.

## Accounting and comparisons

Same category/key/exact interval: actual replaces accrual replaces commitment, then higher revision wins. Ambiguous revisions and partial overlaps are rejected, not added. Split cross-month invoices into explicitly sourced monthly allocations; no silent proration. Unresolved older liabilities survive rollover. Supported precision is nine USD fractional digits. Missing category coverage remains unknown, including when another category has evidence.

Category rows compare current and previous UTC calendar months. Both amounts remain partial, not equal-coverage periods. The non-actual subset is already inside the covered amount. No complete forecast, category balance, headroom, comparable-period change percentage or safe-to-spend balance is claimed.

Bound company SELECTs read current/previous cost events and current run counts from the two declared core tables. Native cost groups use UTC month, billing class and status, never provider. Metered API/overage reported or estimated costs are accrual evidence, never invoice actuals. Subscription-included list-price equivalents, credits, unknown billing types and unpriced events are not inferred as cash. When an `aggregate-inference:YYYY-MM` record is imported for the mapped inference category, native marginal evidence is displayed **separately** as a period total, not added to it: inclusion/additional-spend basis is unknown until bill reconciliation. Do not import separate inference charges alongside an unallocated aggregate commitment.

`node scripts/build-import.mjs COMPANY_UUID SEED_JSON METER_READINGS OUTPUT_JSON` preserves the operator's schema-1 seed policy/commitments and appends current-month daily CI v2 observations. The seed notes must identify meter scope and rate provenance. V2 is measured USD (factor 1.0); v1 is excluded, not multiplied into v2. Each CI bucket is day-to-date through its observation, not complete-month coverage or an invoice. The helper expects a configured `ci` category. Approval ceilings are never spend. This is an explicit operator import, **not a live collector**; refresh does not rerun it.

Published rates are not charges. Actual sandbox spend stays unknown without a validated usage export and resource allocation evidence. Core run count is not sandbox lifetime or billing coverage. Quota windows and forecast remain unknown. No control-plane phase is included.

## Verification boundaries

Focused Vitest suites use the official SDK `createTestHarness` for SELECT-only capability/company/error paths. Unit tests cover precision, configurable envelopes/categories, rejection of category caps, prior-period comparisons, replacement, malformed inputs, duplicate/overlap detection and rollover. These do not establish native runtime behavior; install/data/page/widget/lifecycle read-backs must be proven on an isolated test instance before the separate owner installs a principal-facing target. A build is not UI proof.

## Direction contract (development only)

THESIS: one truthful combined budget view, not another accounting engine or a safe-to-spend gauge.
OWN-WORLD: inherit Paperclip semantic tokens and SDK MetricCard/DataTable; no new branding, stripes, accent borders or parallel primitives.
STORY: read one envelope, compare category coverage across periods, then open native Costs/Budgets or expand source provenance.
FIRST VIEWPORT: Budget heading, configured payer/month/read-only state, one envelope metric, current/previous covered totals, coverage warning and category table. Evidence is progressively disclosed with native details; refresh is the only local interaction.
FORM: specified narrow extension; code-led; seed: none (established host surface).
FINISH: rendered inspection and independent acceptance remain necessary; builds alone are not acceptance evidence.
