import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { taskChatStatusRelevance, isSupersededNotice } from "./status-relevance";
// Run after judge-m14-attacks: these are actual production-settlement rows from isolated PostgreSQL.
// This is the projection called by TaskChatThread.tsx:934, not a browser/render claim.
describe("M14 current held notice projection",()=>{
 it("counts only the current note from actual retained B-prime PostgreSQL rows",()=>{
  if(!process.env.JUDGE_NOTICE_RECEIPT) throw new Error("JUDGE_NOTICE_RECEIPT must name the retained evidence file");
  const rows=JSON.parse(readFileSync(process.env.JUDGE_NOTICE_RECEIPT,"utf8")) as IssueChatComment[];
  expect(rows).toHaveLength(2);
  const current=rows.filter(n=>!(n.metadata as Record<string,unknown>|null)?.supersededBy);
  expect(current).toHaveLength(1);
  const projection=taskChatStatusRelevance("blocked",[],{id:"active-hold",status:"active"});
  // RFL-AUTHORIZED (M1.5, A3): the live-view contract is !isHistoricalNotice(n) && !isSupersededNotice(n.metadata).
  const notices=()=>rows.filter(n=>!projection.isHistoricalNotice(n)&&!isSupersededNotice(n.metadata));
  console.log("actual-db-to-ui-receipt",JSON.stringify({persistedRows:rows.length,currentRows:current.length,projectedRows:notices().length}));
  expect(notices().map(n=>n.id),"superseded history must not count as a CURRENT held notice").toEqual(current.map(n=>n.id));
 });
});
