import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { retireAnsweredMessageNotes } from "./recovery/message-note-retirement.js";

type WriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function insertIssueComment(db: WriteDb, input: PgInsertValue<typeof issueComments> & { companyId: string }) {
  return db.transaction(async tx => {
    await notifyStatusCardIssueChange(tx, input.companyId);
    await notifyIssueRecovery(tx, { companyId: input.companyId,
      issueId: typeof input.issueId === "string" ? input.issueId : undefined });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${input.companyId}`);
    const rows = await tx.insert(issueComments).values(input).returning();
    // An agent's answer supersedes the old send-it-again notes of the messages it answers.
    for (const row of rows) {
      if (row.authorType === "agent" && row.authorAgentId) {
        await retireAnsweredMessageNotes(tx, { companyId: row.companyId, issueId: row.issueId, answerCommentId: row.id, answeredAt: row.createdAt });
      }
    }
    return rows;
  });
}
