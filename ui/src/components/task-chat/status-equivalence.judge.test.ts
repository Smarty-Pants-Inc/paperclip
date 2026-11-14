import { expect, it } from 'vitest';
import { taskChatStatusRelevance as before } from './base-status-relevance.judge';
import { taskChatStatusRelevance as after } from './status-relevance';
import type { IssueChatComment } from '@/lib/issue-chat-messages';

const old = { id: 'old', agentId: 'agent', status: 'failed', createdAt: '2026-01-01T00:00:00Z' };
const next = { ...old, id: 'next', status: 'succeeded', createdAt: '2026-01-01T00:01:00Z' };
const comment = { id: 'notice', companyId:'company', issueId:'issue', authorAgentId:null, authorUserId:null,
 body:'Retained note', createdAt:new Date(), updatedAt:new Date(), deletedAt:null };

it('judge: all non-superseded comment kinds preserve base semantics (cartesian table)', () => {
 let checked=0;
 for (const authorType of ['system','agent','user'])
 for (const presentation of [null,{kind:'message'}, {kind:'system_notice', title:'Notice', tone:'warning'}])
 for (const conversationSessionGeneration of [undefined,null,0,1,2])
 for (const metadata of [null,{}, {version:1,sections:[]}, {sourceRunId:'old'}, {sourceRunId:'next'}, {sourceRunId:'unknown'}, {recovery:{actionId:'action'}}, {sourceRunId:'old',recovery:{actionId:'action'}}])
 for (const provenance of [{}, {createdByRunId:'old'}, {runId:'old'}, {derivedCreatedByRunId:'old'}, {createdByRunId:'next',runId:'old'}])
 for (const issueStatus of [undefined,'todo','in_progress','blocked','done','cancelled'])
 for (const runs of [[],[old],[old,next],[{...old,execution:{phase:'recovery_needed'}},next]])
 for (const recoveryAction of [null,{id:'action',status:'active'},{id:'action',status:'resolved'},{id:'action',status:'cancelled'}]) {
   const c={...comment,authorType,presentation,conversationSessionGeneration,metadata,...provenance} as IssueChatComment;
   const expected=before(issueStatus,runs as any,recoveryAction as any).isHistoricalNotice(c);
   const actual=after(issueStatus,runs as any,recoveryAction as any).isHistoricalNotice(c);
   if(actual!==expected) throw new Error(JSON.stringify({c,issueStatus,runs,recoveryAction,actual,expected}));
   checked++;
 }
 console.log('NON_SUPERSEDED_EQUIVALENCE_CASES='+checked);
 expect(checked).toBe(172800);
});

// RFL-AUTHORIZED (M1.5, change 4): rows 2-3 use the live-view contract
//   live(n) = !isHistoricalNotice(n) && !isSupersededNotice(n.metadata)
// instead of isHistoricalNotice alone; the whitespace-only marker inputs are unreachable
// (schema = guid) and are replaced by guid / absent.
import { isSupersededNotice } from './status-relevance';
const G1='4bb544d1-4874-4bcc-afb1-c8170d0ab5e2', G2='d4620ecc-3dc1-43c0-8c47-5bd6f29986cb';
it('judge: exact superseded predicate under the live-view contract (guid / absent markers)',()=>{
 const policy=after('in_progress',[]);
 const live=(c:IssueChatComment)=>!policy.isHistoricalNotice(c)&&!isSupersededNotice(c.metadata);
 let count=0;
 for(const authorType of ['system','agent','user'])
 for(const presentation of [null,{kind:'message'},{kind:'system_notice',title:'Notice',tone:'warning'}])
 for(const marker of [{}, {supersededBy:G1}, {supersededByInteractionId:G2}, {supersededBy:G1,supersededByInteractionId:G2}])
 for(const conversationSessionGeneration of [undefined]) {
  const c={...comment,authorType,presentation,conversationSessionGeneration,metadata:{version:1,sections:[],...marker}} as unknown as IssueChatComment;
  const marked=Object.keys(marker).length>0;
  expect(policy.isHistoricalNotice(c),'isHistoricalNotice itself is unchanged from base').toBe(before('in_progress',[]).isHistoricalNotice(c));
  expect(live(c)).toBe(!marked);
  count++;
 }
 console.log('SUPERSEDED_LIVE_CONTRACT_CASES='+count);
});

it('judge: a session boundary: isHistoricalNotice is unchanged from base; the live-view contract decides',()=>{
 const c={...comment,authorType:'system',presentation:null,conversationSessionGeneration:1,metadata:{version:1,sections:[],supersededBy:G1}} as unknown as IssueChatComment;
 expect(before('in_progress',[]).isHistoricalNotice(c)).toBe(false);
 expect(after('in_progress',[]).isHistoricalNotice(c)).toBe(false);
 expect(isSupersededNotice(c.metadata)).toBe(true);
});
