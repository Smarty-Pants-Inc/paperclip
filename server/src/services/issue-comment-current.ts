import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ISSUE_COMMENT_SUPERSESSION_KEYS } from "@paperclipai/shared";

/**
 * SQL form of @paperclipai/shared isCurrentNotice (RFL 11:43Z): the ONE rule for
 * a CURRENT comment notice, derived from the same marker list. A note is
 * current iff no supersession marker (supersededBy, supersededByInteractionId)
 * holds a non-empty string. Kept notes are never deleted (org 09:18Z); a
 * superseded one is history, and no server reader treats it as live.
 */
export function currentNoticeSql(metadata: SQL | AnyPgColumn): SQL {
  return sql`(${sql.join(ISSUE_COMMENT_SUPERSESSION_KEYS.map(key => {
    if (!/^[A-Za-z]+$/.test(key)) throw new Error(`unexpected supersession key: ${key}`);
    const k = sql.raw(`'${key}'`);
    return sql`(jsonb_typeof(${metadata}->${k}) is distinct from 'string' or ${metadata}->>${k} = '')`;
  }), sql` and `)})`;
}
