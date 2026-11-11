# No application SQL migrations

This directory deliberately contains no SQL files. Imports are company-scoped config, not private plugin tables. The database declaration is needed only to allowlist bound SELECT reads of the two named core tables.

The pinned host schema requires `database.namespace.migrate` and `database.namespace.read` for every database declaration, plus a `migrationsDir`. See [Plugin database declarations](../../../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md#plugin-database-declarations). This grants migration access only to the plugin's own namespace. There is no `database.namespace.write`, core migration, runtime mutation or purge path in this plugin.
