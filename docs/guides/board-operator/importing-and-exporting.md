---
title: Importing & Exporting Companies
summary: Export companies to portable packages and import them from local paths or GitHub
---

Paperclip companies can be exported to portable markdown packages and imported from local directories or GitHub repositories. This lets you share company configurations, duplicate setups, and version-control your agent teams.

## Package Format

Exported packages follow the [Agent Companies specification](/companies/companies-spec) and use a markdown-first structure:

```text
my-company/
├── COMPANY.md          # Company metadata
├── agents/
│   ├── ceo/AGENT.md    # Agent instructions + frontmatter
│   └── cto/AGENT.md
├── projects/
│   └── main/PROJECT.md
├── skills/
│   └── review/SKILL.md
├── tasks/
│   └── onboarding/TASK.md
└── .paperclip.yaml     # Adapter config, env inputs, routines
```

- **COMPANY.md** defines company name, description, and metadata.
- **AGENT.md** files contain agent identity, role, and instructions.
- **SKILL.md** files are compatible with the Agent Skills ecosystem.
- **.paperclip.yaml** holds Paperclip-specific config (adapter types, env inputs, budgets) as an optional sidecar.

## Export & Import in the App

Both flows are also available in the web UI as company settings pages: **Export** and **Import** appear in the company settings navigation.

> **Cloud-managed instances:** when a hosting platform manages the instance, the company is provisioned by the platform and importing is disabled — the Import page and buttons are hidden, and every import API route answers `403` with `code: "cloud_managed"`. Export stays available, so you can always take your company's data with you. Self-hosted instances keep the full import surface.

The **Export** page lets you pick exactly which files go into the bundle before downloading it. Above the file tree it shows a **"Not included in this export"** panel — the export fidelity report — listing data the bundle will not carry (for example attachments, approvals, cost history, or activity log entries), with blocking issues highlighted.

The **Import** page previews the package, lets you resolve name collisions and adapter assignments, and applies the import. A **"Start imported agents and routines paused"** checkbox (on by default) makes imported agents and routines land paused instead of live. After the import finishes, an **"Activate imported agents and routines"** panel lists everything that was imported paused so you can resume the agents and activate the routines you select — nothing starts running until you say so.

## Exporting a Company

Export a company into a portable folder:

```sh
paperclipai company export <company-id> --out ./my-export
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--out <path>` | Output directory (required) | — |
| `--include <values>` | Comma-separated set: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | `company,agents` |
| `--skills <values>` | Export only specific skill slugs | all |
| `--projects <values>` | Export only specific project shortnames or IDs | all |
| `--issues <values>` | Export specific issue identifiers or IDs | none |
| `--project-issues <values>` | Export issues belonging to specific projects | none |
| `--expand-referenced-skills` | Vendor skill file contents instead of keeping upstream references | `false` |

### Examples

```sh
# Export company with agents and projects
paperclipai company export abc123 --out ./backup --include company,agents,projects

# Export everything including tasks and skills
paperclipai company export abc123 --out ./full-export --include company,agents,projects,tasks,skills

# Export only specific skills
paperclipai company export abc123 --out ./skills-only --include skills --skills review,deploy
```

### What Gets Exported

- Company name, description, and metadata
- Agent names, roles, reporting structure, and instructions
- Project definitions and workspace config
- Task/issue descriptions (when included)
- Skill packages (as references or vendored content)
- Adapter type and env input declarations in `.paperclip.yaml`

Secret values, machine-local paths, and database IDs are **never** exported.

## Importing a Company

Import from a local directory, GitHub URL, or GitHub shorthand:

```sh
# From a local folder
paperclipai company import ./my-export

# From a GitHub URL
paperclipai company import https://github.com/org/repo

# From a GitHub subfolder
paperclipai company import https://github.com/org/repo/tree/main/companies/acme

# From GitHub shorthand
paperclipai company import org/repo
paperclipai company import org/repo/companies/acme
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--target <mode>` | `new` (create a new company) or `existing` (merge into existing) | inferred from context |
| `--company-id <id>` | Target company ID for `--target existing` | current context |
| `--new-company-name <name>` | Override company name for `--target new` | from package |
| `--include <values>` | Comma-separated set: `company`, `agents`, `projects`, `issues`, `tasks`, `skills` | auto-detected |
| `--agents <list>` | Comma-separated agent slugs to import, or `all` | `all` |
| `--collision <mode>` | How to handle name conflicts: `rename`, `skip`, or `replace` | `rename` |
| `--ref <value>` | Git ref for GitHub imports (branch, tag, or commit) | default branch |
| `--dry-run` | Preview what would be imported without applying | `false` |
| `--yes` | Skip the interactive confirmation prompt | `false` |
| `--json` | Output result as JSON | `false` |

### Target Modes

- **`new`** — Creates a fresh company from the package. Good for duplicating a company template.
- **`existing`** — Merges the package into an existing company. Use `--company-id` to specify the target.

If `--target` is not specified, Paperclip infers it: if a `--company-id` is provided (or one exists in context), it defaults to `existing`; otherwise `new`.

### Collision Strategies

When importing into an existing company, agent or project names may conflict with existing ones:

- **`rename`** (default) — Appends a suffix to avoid conflicts (e.g., `ceo` becomes `ceo-2`).
- **`skip`** — Skips entities that already exist.
- **`replace`** — Overwrites existing entities. Only available for non-safe imports (not available through the CEO API).

### Interactive Selection

When running interactively (no `--yes` or `--json` flags), the import command shows a selection picker before applying. You can choose exactly which agents, projects, skills, and tasks to import using a checkbox interface.

### Preview Before Applying

Always preview first with `--dry-run`:

```sh
paperclipai company import org/repo --target existing --company-id abc123 --dry-run
```

The preview shows:
- **Package contents** — How many agents, projects, tasks, and skills are in the source
- **Import plan** — What will be created, renamed, skipped, or replaced
- **Env inputs** — Environment variables that may need values after import
- **Warnings** — Potential issues like missing skills or unresolved references

Imported agents always land with timer heartbeats disabled. Assignment/on-demand wake behavior from the package is preserved, but scheduled runs stay off until a board operator re-enables them.

Imports can additionally request `pauseAutomations` (the default in the app's Import page) so imported agents and routines land fully paused. Use the post-import activation panel — or resume the agents and activate the routines individually — when you are ready for them to run.

After activation, carried-over todo and in-progress tasks without a local run use normal assignment admission, once per task. Imported blocked and in-review tasks keep waiting for their blocker or review; done and cancelled tasks do not receive an automatic assignment run. Recovery rechecks the current task status and its run/wake history under the queue's task lock: a stale assignment cannot start a waiting or finished task, and a competing controller cannot admit that initial work again after Stop. A monitor armed before admission keeps its schedule instead of receiving an immediate assignment run.

The import safety pause leaves assigned open tasks waiting without blocking them or adding stopped-task or unanswered-message notices. Resuming the assignee admits carried-over work with no local run through normal assignment recovery; it does not require an unblock comment on each task. An additional manual pause still uses the normal paused-agent notice.

Task monitor notes and provenance are imported, but their schedules arrive unarmed (with an import warning). Re-arm an imported monitor from its task page when ready. Recovery preserves an already-armed monitor while its assignee waits on the import safety pause.

### Common Workflows

**Clone a company template from GitHub:**

```sh
paperclipai company import org/company-templates/engineering-team \
  --target new \
  --new-company-name "My Engineering Team"
```

**Add agents from a package into your existing company:**

```sh
paperclipai company import ./shared-agents \
  --target existing \
  --company-id abc123 \
  --include agents \
  --collision rename
```

**Import a specific branch or tag:**

```sh
paperclipai company import org/repo --ref v2.0.0 --dry-run
```

**Non-interactive import (CI/scripts):**

```sh
paperclipai company import ./package \
  --target new \
  --yes \
  --json
```

## API Endpoints

The CLI commands use these API endpoints under the hood:

| Action | Endpoint |
|--------|----------|
| Export company | `POST /api/companies/{companyId}/export` |
| Export fidelity report | `GET /api/companies/{companyId}/export/fidelity` |
| Preview import (existing company) | `POST /api/companies/{companyId}/imports/preview` |
| Apply import (existing company) | `POST /api/companies/{companyId}/imports/apply` |
| Preview import (new company) | `POST /api/companies/import/preview` |
| Apply import (new company) | `POST /api/companies/import` |

Import apply requests accept `pauseAutomations: true` to create imported agents and routines in a paused state.

### Imported comment history

Both `new_company` and `existing_company` imports mark every inserted comment with
`origin: "import"`. Imported person comments are history: they are not pending
continuation input and do not receive unanswered-message notices, regardless of
their preserved source timestamps or how many times the company is imported.
Live comments written on the destination retain `origin: "comment"` and the
normal continuation and notice rules. Imports made before this marker was added
retain the existing arrival-time fallback: the task's first `issue.imported`
record, or its company's first `company.imported` record for a `company_import`
task. With neither a marker nor an arrival record, comments keep normal behavior.

### Imported comment authorship

Import preview and apply requests optionally accept `userCommentAuthorEmail` in
the JSON body, ZIP upload metadata, or chunked-transfer body. Input matching uses
`trim().toLowerCase()`; stored email matching uses SQL `lower(btrim(email))`
(surrounding spaces). The email must
identify exactly one existing instance user in either mode; unknown or ambiguous
matches are rejected even if only one matching user belongs to the target company.
For `new_company`, no membership is required because the company does not yet
exist. Instance users have no active/disabled status; email verification, admin
roles, and sessions are not eligibility requirements. For `existing_company`, the
resolved user must also have an active user membership in the target company.
Failures return an unprocessable error before preview or import-domain writes;
this option never creates users or memberships or grants access.

**Required operator precondition:** every plain bundled user comment must belong
to the selected person. Before using this option, run a read-only query against
the source for this exact bundle's tasks and comments to verify that condition.
Export identity is lossy: the exporter removes user identities, so Paperclip
cannot prove original authorship from the bundle; preview's mapping is not evidence
of original authorship. Do not use this
single-person option for a bundle containing plain user comments from other people.

With this option, imported user comments are attributed to the selected user,
except comments with any nonempty `metadata.sourceChannel`: those are imported as system
comments without a user author. Channel metadata, presentation, and content are
retained, with the usual embedded-asset URL rewriting. Agent comments keep the
existing agent-slug mapping, and system comments remain system comments.

Without this option, existing behavior is unchanged: imported user comments,
including relayed channel comments, are attributed to the importing user, or become
system comments with the existing warning when no importing user is available.
This option does not change task or document creators and is not an app setting
or CLI flag.

### Imported task people

Independently of `userCommentAuthorEmail`, import preview and apply requests
optionally accept `taskPeople` as a direct array (no version or tasks wrapper).
**Required operator precheck:** client-side, bind the task table to the exact full
bundle being submitted and verify every row against read-only source data for that
bundle. The API checks full-bundle coverage and resolves emails; it cannot prove
that the supplied people were the original task creators or responsible users.

```json
{
  "taskPeople": [
    {
      "issueIdentifier": "SRC-123",
      "creatorEmail": "creator@example.com",
      "responsibleEmail": null
    }
  ]
}
```

When present, the array must list every task in the full bundle exactly once,
even when `include.issues` is false or `selectedFiles` selects only some tasks.
`issueIdentifier` matches the exported `.paperclip.yaml` task `identifier`, not
its slug or a newly generated target identifier. Missing source identifiers,
ambiguous source tasks, missing rows, extra rows, and duplicate rows fail closed.
Each row requires both email fields; `null` explicitly means nobody, never the
importing user. Unknown row properties are ignored and cannot supply user or
agent IDs.

Every non-null email uses the same normalized global-uniqueness and target
membership checks as `userCommentAuthorEmail`. All coverage and user resolution
finish before company creation/update or any other import-domain write. Existing
upload/transfer bookkeeping and source loading are outside this domain boundary.
For each imported task, the verified users (or explicit nulls) set its creator and
responsible-user fields. Assignees, conversation users, document creators,
approvals, and exports are unchanged. Bundled recurring tasks still import as
routines under the existing routine behavior; their table rows are checked but
do not change routine attribution.

Without `taskPeople`, task attribution and insert-field shape retain their legacy
behavior. Either authorship input works alone, or both can be supplied together.
These are API request options, not app settings or CLI flags.

### Preview attribution mapping

Preview and apply share the same full-bundle coverage and email preflight. Invalid attribution is rejected before preview or import-domain writes.
With either authorship input present, preview reads the saved skill inventory
without refreshing it and performs no import-domain writes. Without both inputs,
preview retains its legacy behavior and adds no `authorship` key. A valid apply
retains the existing skill-inventory refresh behavior.

Preview keeps the source manifest's original comment authors and metadata intact;
the optional `authorship` supplement shows the resolved mapping separately:

```json
{
  "authorship": {
    "userCommentAuthorUserId": "selected-user-id",
    "comments": [
      { "issueSlug": "onboarding", "issueIdentifier": "SRC-123", "commentIndex": 0, "authorType": "user", "authorUserId": "selected-user-id" },
      { "issueSlug": "onboarding", "issueIdentifier": "SRC-123", "commentIndex": 2, "authorType": "system", "authorUserId": null }
    ],
    "taskPeople": [
      { "issueIdentifier": "SRC-123", "createdByUserId": "creator-user-id", "responsibleUserId": null }
    ]
  }
}
```

`comments` and `userCommentAuthorUserId` appear only with the comment option;
`comments` lists only originally-user comments, using indexes in each original
comment array (unchanged agent/system comments need no entry). `taskPeople`
appears only with the task table and uses original source identifiers. Each
supplement covers the full bundle, independently of selected files.

CEO agents can also use the safe import routes (`/imports/preview` and `/imports/apply`) which enforce non-destructive rules: `replace` is rejected, collisions resolve with `rename` or `skip`, and issues are always created as new.

## GitHub Sources

Paperclip supports several GitHub URL formats:

- Full URL: `https://github.com/org/repo`
- Subfolder URL: `https://github.com/org/repo/tree/main/path/to/company`
- Shorthand: `org/repo`
- Shorthand with path: `org/repo/path/to/company`

Use `--ref` to pin to a specific branch, tag, or commit hash when importing from GitHub.
