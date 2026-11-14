import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { ISSUE_COMMENT_SUPERSESSION_KEYS } from "@paperclipai/shared";
import { issues } from "@paperclipai/db";
import { CONVERSATION_RESET_COMMAND } from "./agent-conversations.js";

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

/** String.prototype.trim's whitespace (ECMA-262 WhiteSpace and LineTerminator), so SQL trims exactly as JS does. */
const JS_TRIM_CHARACTERS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
  + "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/**
 * The ONE SQL mirror of agent-conversations.ts isConversationReset: a person's
 * "/new" session reset, a command and a conversation boundary, not a message
 * owed a reply (SMAA-1909). Like Paperclip's callers (agent-conversations.ts
 * resumeConversationForReset), it requires a person author AND a chat:
 * isConversation(issue), both conversation ids set. In a task a literal "/new"
 * is an ordinary message (RFL m15b). A parity test pins it to the TS functions.
 */
export function conversationResetSql(comment: { body: SQL | AnyPgColumn; authorUserId: SQL | AnyPgColumn;
  issueId: SQL | AnyPgColumn }): SQL {
  return sql`(${comment.authorUserId} is not null and btrim(${comment.body}, ${JS_TRIM_CHARACTERS}) = ${CONVERSATION_RESET_COMMAND}
    and exists (select 1 from ${issues} reset_issue where reset_issue.id = ${comment.issueId}
      and reset_issue.conversation_agent_id is not null and reset_issue.conversation_user_id is not null))`;
}
