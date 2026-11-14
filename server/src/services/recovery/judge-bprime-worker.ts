import { createDb } from "@paperclipai/db";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";
if (!process.env.JUDGE_DB_URL) { console.log("worker import: ready"); }
else {
  const db = createDb(process.env.JUDGE_DB_URL);
  try {
    const outcome = await settleUnansweredPersonMessage(db, {companyId: process.env.JUDGE_COMPANY!, issueId:process.env.JUDGE_ISSUE!, now:new Date(process.env.JUDGE_NOW!)});
    console.log(JSON.stringify({pid:process.pid,kind:outcome.kind}));
  } finally { await db.$client.end(); }
}
