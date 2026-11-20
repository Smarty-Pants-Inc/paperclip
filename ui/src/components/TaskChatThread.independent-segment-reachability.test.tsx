// @vitest-environment jsdom
// Own user-path observation. Transport/editor mocked; TaskChatThread, segmentation,
// transcript parser and all conversation renderers are production code.
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
vi.mock('@/components/transcript/useNativeRunTranscripts',()=>({useNativeRunTranscripts:()=>({transcriptByRun:new Map(state.transcript),errorsByRun:new Map(),terminalHydratedRunIds:new Set(['segment-run'])})}));
vi.mock('@/context/SidebarContext',()=>({useSidebar:()=>({isMobile:false})}));
vi.mock('@/hooks/useIssuePlanDocument',()=>({useIssuePlanDocument:()=>({data:null})}));
vi.mock('@/hooks/useStreamlinedUiEnabled',()=>({useStreamlinedUiEnabled:()=>({enabled:true,loaded:true})}));
vi.mock('@/hooks/useAgentReasoningDisplay',()=>({useAgentReasoningDisplayPreferences:()=>({})}));
vi.mock('@/lib/router',()=>({useLocation:()=>({pathname:'/issues/segment',hash:'',search:'',key:'test',state:null}),Link:({to,children,...props}:any)=><a href={to} {...props}>{children}</a>}));
vi.mock('@/components/MarkdownEditor',()=>({MarkdownEditor:forwardRef(function Editor({value}:any,ref){useImperativeHandle(ref,()=>({insertMarkdown:()=>{},focus:()=>{}}));return <div>{value}</div>;})}));
const iso=(s:number)=>`2026-11-20T07:41:${String(s).padStart(2,'0')}.000Z`;
const entry=(s:number,text:string,channel='progress')=>({kind:'assistant',ts:iso(s),text,channel,itemId:`native-${s}`});
const steer=(s:number)=>({id:`steer-${s}`,companyId:'company-1',issueId:'issue-1',authorType:'user' as const,authorAgentId:null,authorUserId:'user-1',body:s===2?'What is 100+1?':'Continue the remaining steps.',presentation:null,metadata:null,runId:null,followUpRequested:true,consumedByRunId:'segment-run',steeredIntoRunId:'segment-run',conversationAnchorAt:new Date(iso(s)),createdAt:new Date(iso(s)),updatedAt:new Date(iso(s))});
describe.each([390,1440])('real TaskChatThread segment reachability %ipx',width=>{
 it.each([false,true])('restated answer once from progress to live final to settled/reload (second steer=%s)',async(secondSteer)=>{
  Object.defineProperty(window,'innerWidth',{configurable:true,value:width});window.dispatchEvent(new Event('resize'));localStorage.clear();
  const host=document.createElement('div');host.style.width=`${width}px`;document.body.append(host);let root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const records:any[]=[];let stage='init';
  const sample=(source='post-act')=>{const texts=[...host.querySelectorAll('[data-conversation-text]')].map(e=>e.textContent?.trim()??'');const row={stage,source,texts,count:texts.join('\n').split('100+1 = 101.').length-1,work:texts.join('\n').split('Step 3 done.').length-1,html:host.innerHTML};records.push(row);return row;};
  const observer=new MutationObserver(()=>sample('mutation'));observer.observe(host,{childList:true,subtree:true,characterData:true});
  const entries=[entry(1,'Starting the remaining work.'),entry(3,'100+1 = 101.'),entry(5,'Step 3 done.'),{kind:'tool_call',ts:iso(6),name:'bash',input:{command:'ls'},toolUseId:'ls'}];
  const live={id:'segment-run',runtimeMode:'native' as const,status:'running' as const,invocationSource:'issue' as const,triggerDetail:null,startedAt:iso(0),finishedAt:null,createdAt:iso(0),agentId:'agent-1',agentName:'Runner',adapterType:'paperclip_runner'};
  const comments=[steer(2),...(secondSteer?[steer(4)]:[])];
  const render=async(label:string,final:boolean,settled=false)=>{stage=label;state.transcript.set('segment-run',[...entries,...(final?[entry(8,'Done. Also, 100+1 = 101.','final')]:[])]);await act(async()=>flushSync(()=>root.render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider><TaskChatThread issueId="issue-1" comments={comments} onAdd={async()=>{}} issueStatus="in_progress" {...(settled?{linkedRuns:[{...live,runId:live.id,status:'succeeded',finishedAt:iso(9)}]}:{activeRun:live})}/></TooltipProvider></ThemeProvider></QueryClientProvider>)));return sample();};
  try{const before=await render('before-final',false);const liveFinal=await render('live-final',true);const settled=await render('settled',true,true);act(()=>root.unmount());root=createRoot(host);const reload=await render('settled-reload',true,true);expect(before.count).toBe(1);expect([liveFinal.count,settled.count,reload.count]).toEqual([1,1,1]);expect([liveFinal.work,settled.work,reload.work]).toEqual([1,1,1]);}
  finally{observer.disconnect();const out=process.env.RF7_SEGMENT_DIR;if(out){mkdirSync(out,{recursive:true});writeFileSync(`${out}/segments-${secondSteer?'two-steers':'one-steer'}-${width}.json`,JSON.stringify({width,secondSteer,entries,comments,records},null,2));}act(()=>root.unmount());client.clear();host.remove();state.transcript.clear();localStorage.clear();}
 });
});
