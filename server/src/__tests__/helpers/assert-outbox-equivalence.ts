import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { issues, issueComments, type Db } from '@paperclipai/db';
import { hedge } from './outbox-baseline.js';
import { undeliveredConversationComments } from '../../services/agent-conversations.js';

/** Compare the actual old/head selectors on one repeatable-read snapshot.
 * The second pass also keys legacy fixture messages, so fixtures predating
 * clientRequestId exercise the owed floor rather than returning empty sets.
 * All projection writes are rolled back, including when an assertion fails.
 */
export async function assertOutboxEquivalence(db: Db, suite: string) {
  const rollback = new Error('outbox equality projection rollback');
  const evidence: unknown[] = [];
  try {
    await db.transaction(async tx => {
      const chats = await tx.select({id:issues.id,companyId:issues.companyId}).from(issues);
      for (const projection of ['persisted','keyed-person-projection']) {
        if (projection !== 'persisted') await tx.update(issueComments).set({
          clientRequestId: sql`'outbox-equality:' || ${issueComments.id}::text`,
        }).where(and(eq(issueComments.authorType,'user'),isNull(issueComments.clientRequestId)));
        for (const chat of chats) {
          const base = await hedge(tx as unknown as Db,chat.companyId,chat.id);
          const head = await undeliveredConversationComments(tx as unknown as Db,chat.companyId,chat.id);
          assert.deepStrictEqual(head,base,`${suite}: ${projection}: ${chat.id}`);
          evidence.push({suite,projection,issueId:chat.id,base:base.map(row=>row.id),head:head.map(row=>row.id),equal:true});
        }
      }
      throw rollback;
    }, { isolationLevel:'repeatable read' });
  } catch (error) { if (error !== rollback) throw error; }
  if (process.env.TASK_OUT) await appendFile(`${process.env.TASK_OUT}/equality.jsonl`,evidence.map(row=>JSON.stringify(row)+'\n').join(''));
}
