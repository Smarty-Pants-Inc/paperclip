import { and, desc, eq, sql } from "drizzle-orm";
import { pluginCompanySettings, pluginLogs, plugins, type Db } from "@paperclipai/db";

export const PLUGIN_WAKE_HOLD_MS = 30 * 60_000;

/** Called on the status writer's transaction, after its write succeeds. */
export async function recordPluginStatusTransition(
  db: Pick<Db, "insert">,
  pluginId: string,
  from: string | null,
  to: string,
  backfill?: { createdAt: Date },
) {
  if (from === to) return;
  await db.insert(pluginLogs).values({
    pluginId, companyId: null, level: "info", message: `status → ${to}`,
    meta: { kind: "status_transition", from, to, ...(backfill ? { backfilled: true } : {}) },
    createdAt: backfill?.createdAt ?? new Date(),
  });
}

/** Read the current plugin and its stable hold start together. Locking the plugin
 * serializes legacy backfills with each other and with registry status writers.
 * A nested call from release admission stays in that admission transaction. */
export async function readPluginWakeHold(db: Db, pluginId: string, companyId: string) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [row] = await tx.select({ plugin: plugins, enabled: pluginCompanySettings.enabled })
      .from(plugins).leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id),
        eq(pluginCompanySettings.companyId, companyId)))
      // Compare as text: untrusted persisted payloads must not cause UUID cast errors.
      .where(sql`${plugins.id}::text = ${pluginId}`).for("update", { of: plugins });
    if (!row) return null;
    const { plugin, enabled } = row;
    let start: Date | null = null;
    if (enabled !== false && (plugin.status === "installed" || plugin.status === "upgrade_pending")) {
      const [transition] = await tx.select({ createdAt: pluginLogs.createdAt }).from(pluginLogs)
        .where(and(eq(pluginLogs.pluginId, plugin.id), sql`${pluginLogs.meta}->>'kind' = 'status_transition'`,
          sql`${pluginLogs.meta}->>'to' = ${plugin.status}`))
        .orderBy(desc(pluginLogs.createdAt), desc(pluginLogs.id)).limit(1);
      start = transition?.createdAt ?? plugin.updatedAt;
      if (!transition) await recordPluginStatusTransition(tx, plugin.id, null, plugin.status, { createdAt: start });
    }
    return { plugin, enabled, start };
  });
}
