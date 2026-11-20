// @vitest-environment jsdom
// ui-doubles4 cross-RUN control: an answer an EARLIER run wrote stays when a LATER run's final
// restates it. The restated-progress rule is one run's business only. Production TaskChatThread.
import {mkdirSync,writeFileSync} from 'node:fs';
import {act,forwardRef,useImperativeHandle} from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@/context/ThemeContext';
import {TooltipProvider} from '@/components/ui/tooltip';
import {TaskChatThread} from './TaskChatThread';
const state=vi.hoisted(()=>({transcript:new Map()}));
vi.mock('@/hooks/useCoordinatorWorkspaceEnabled',()=>({useCoordinatorWorkspaceEnabled:()=>({enabled:false,loaded:true,userId:'owner-a'})}));
vi.mock('@/components/transcript/useLiveRunTranscripts',()=>({useLiveRunTranscripts:()=>({transcriptByRun:new Map(),isInitialHydrating:false})}));
vi.mock('@/components/transcript/useNativeRunTranscripts',()=>({useNativeRunTranscripts:()=>({transcriptByRun:new Map(state.transcript),errorsByRun:new Map(),terminalHydratedRunIds:new Set(['run-a','run-b'])})}));
vi.mock('@/context/SidebarContext',()=>({useSidebar:()=>({isMobile:false})}));
vi.mock('@/hooks/useIssuePlanDocument',()=>({useIssuePlanDocument:()=>({data:null})}));
vi.mock('@/hooks/useStreamlinedUiEnabled',()=>({useStreamlinedUiEnabled:()=>({enabled:true,loaded:true})}));
vi.mock('@/hooks/useAgentReasoningDisplay',()=>({useAgentReasoningDisplayPreferences:()=>({})}));
vi.mock('@/lib/router',()=>({useLocation:()=>({pathname:'/issues/cross-run',hash:'',search:'',key:'test',state:null}),Link:({to,children,...props}:any)=><a href={to} {...props}>{children}</a>}));
vi.mock('@/components/MarkdownEditor',()=>({MarkdownEditor:forwardRef(function Editor({value}:any,ref){useImperativeHandle(ref,()=>({insertMarkdown:()=>{},focus:()=>{}}));return <div>{value}</div>;})}));
const iso=(s:number)=>`2026-11-20T07:41:${String(s).padStart(2,'0')}.000Z`;
const entry=(s:number,text:string,channel='progress')=>({kind:'assistant',ts:iso(s),text,channel,itemId:`native-${s}`});
const comment=(s:number,body:string,runId:string)=>({id:`steer-${s}`,companyId:'company-1',issueId:'issue-1',authorType:'user' as const,authorAgentId:null,authorUserId:'user-1',body,presentation:null,metadata:null,runId:null,followUpRequested:true,consumedByRunId:runId,steeredIntoRunId:runId,conversationAnchorAt:new Date(iso(s)),createdAt:new Date(iso(s)),updatedAt:new Date(iso(s))});
const run=(id:string,start:number,status:'running'|'succeeded',finish?:number)=>({id,runId:id,runtimeMode:'native' as const,status,invocationSource:'issue' as const,triggerDetail:null,startedAt:iso(start),finishedAt:finish==null?null:iso(finish),createdAt:iso(start),agentId:'agent-1',agentName:'Runner',adapterType:'paperclip_runner'});
describe.each([390,1440])('cross-run control %ipx',width=>{
 it('an earlier run\'s answer and a later run\'s final restating it both stay (live final, settled, reload)',async()=>{
  Object.defineProperty(window,'innerWidth',{configurable:true,value:width});window.dispatchEvent(new Event('resize'));localStorage.clear();
  const host=document.createElement('div');host.style.width=`${width}px`;document.body.append(host);let root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const records:any[]=[];
  const sample=(stage:string)=>{const texts=[...host.querySelectorAll('[data-conversation-text]')].map(e=>e.textContent?.trim()??'');const row={stage,texts,count:texts.join('\n').split('100+1 = 101.').length-1,work:texts.join('\n').split('Step 3 done.').length-1};records.push(row);return row;};
  state.transcript.set('run-a',[entry(1,'Starting the remaining work.'),entry(3,'100+1 = 101.'),{kind:'tool_call',ts:iso(4),name:'bash',input:{command:'ls'},toolUseId:'ls-a'},entry(6,'Checked the sum.','final')]);
  const runB=[entry(21,'Picking up the remaining steps.'),entry(23,'Step 3 done.'),{kind:'tool_call',ts:iso(24),name:'bash',input:{command:'ls'},toolUseId:'ls-b'}];
  const comments=[comment(2,'What is 100+1?','run-a'),comment(22,'Continue the remaining steps.','run-b')];
  const render=async(stage:string,final:boolean,settled:boolean)=>{state.transcript.set('run-b',[...runB,...(final?[entry(28,'Done. Also, 100+1 = 101.','final')]:[])]);await act(async()=>flushSync(()=>root.render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider><TaskChatThread issueId="issue-1" comments={comments} onAdd={async()=>{}} issueStatus="in_progress" linkedRuns={[run('run-a',0,'succeeded',7),...(settled?[run('run-b',20,'succeeded',29)]:[])]} {...(settled?{}:{activeRun:run('run-b',20,'running')})}/></TooltipProvider></ThemeProvider></QueryClientProvider>)));return sample(stage);};
  try{const before=await render('before-final',false,false);const liveFinal=await render('live-final',true,false);const settled=await render('settled',true,true);act(()=>root.unmount());root=createRoot(host);const reload=await render('settled-reload',true,true);
   expect(before.count).toBe(1);expect([liveFinal.count,settled.count,reload.count]).toEqual([2,2,2]);expect([liveFinal.work,settled.work,reload.work]).toEqual([1,1,1]);}
  finally{const out=process.env.RF7_SEGMENT_DIR;if(out){mkdirSync(out,{recursive:true});writeFileSync(`${out}/cross-run-${width}.json`,JSON.stringify({width,comments,records},null,2));}act(()=>root.unmount());client.clear();host.remove();state.transcript.clear();localStorage.clear();}
 });
});
