import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {BudgetView} from './worker.js';
const mocks=vi.hoisted(()=>({query:{data:null as BudgetView|null,error:null as Error|null,loading:false,refresh:vi.fn<()=>void>()},toast:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useCallback:<T,>(fn:T)=>fn}));
vi.mock('@paperclipai/plugin-sdk/ui',()=>({
  useHostContext:()=>({companyId:'11111111-1111-4111-8111-111111111111'}),
  useHostNavigation:()=>({linkProps:(to:string)=>({href:to})}),usePluginData:()=>mocks.query,usePluginToast:()=>mocks.toast,
  MetricCard:'div',StatusBadge:'span',DataTable:'div',
}));
import {BudgetPage} from './ui/index.js';
interface Element {type?:unknown;props?:{children?:unknown;onClick?:()=>void;role?:string}}
function find(node:unknown,predicate:(e:Element)=>boolean):Element|undefined{
  if(Array.isArray(node)){for(const child of node){const found=find(child,predicate);if(found)return found;}return;}
  if(!node||typeof node!=='object')return;
  const e=node as Element;return predicate(e)?e:find(e.props?.children,predicate);
}
const render=()=>BudgetPage({context:{} as never});
beforeEach(()=>{
  mocks.query.data={configured:true,payer:'Synthetic',month:'2026-11',previousMonth:'2026-10',monthlyEnvelopeUsd:'100.00',coveredTotalUsd:null,previousCoveredTotalUsd:null,categories:[],nativeEvidence:[],notes:[],generatedAt:'2026-11-11T00:00:00Z',forecast:'Unknown',quota:'Unknown',controls:'Not enabled',sandboxes:'Unknown'} as unknown as BudgetView;
  mocks.query.error=null;mocks.query.loading=false;mocks.query.refresh.mockReset();mocks.toast.mockReset();
});
describe('void SDK refresh trigger',()=>{
  it('says requested, not successful, while the host read has not settled',()=>{
    let settled=false;
    mocks.query.refresh.mockImplementation(()=>{mocks.query.loading=true;});
    const button=find(render(),e=>e.type==='button')!;button.props!.onClick!();
    expect(mocks.query.refresh).toHaveBeenCalledOnce();expect(settled).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'Refresh requested',tone:'info'}));
    expect(find(render(),e=>e.props?.role==='status')).toBeDefined();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toMatch(/refreshed|success/);
    settled=true;mocks.query.loading=false;
    expect(settled).toBe(true);expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
  it('renders the later hook error without emitting a false success toast',()=>{
    find(render(),e=>e.type==='button')!.props!.onClick!();
    mocks.query.loading=false;mocks.query.data=null;mocks.query.error=new Error('host read failed');
    expect(find(render(),e=>e.props?.role==='alert')).toBeDefined();
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toMatch(/refreshed|success/);
    find(render(),e=>e.type==='button')!.props!.onClick!();
    expect(mocks.query.refresh).toHaveBeenCalledTimes(2);expect(mocks.toast.mock.calls.every(([input])=>input.title==='Refresh requested')).toBe(true);
  });
});
