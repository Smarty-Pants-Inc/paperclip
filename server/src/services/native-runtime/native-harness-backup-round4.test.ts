import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../middleware/logger.js', () => ({logger: {warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn()}}));
import { logger } from '../../middleware/logger.js';
import { nativeHarnessBackupErrorFields, reportNativeHarnessBackupCapture } from './native-harness-backup-observability.js';
import { nativeHarnessBackupExpirationService } from './native-harness-backup-expiration.js';
import { createDeliveryWorkCoordinator } from '../delivery-work-coordinator.js';
import { noteNativeHarnessBackupChange } from '../native-harness-backup-expiration-notifications.js';
import { installDatabaseWorkSignals } from '@paperclipai/db/work-signals';
const OUT = process.env.TASK_OUT!;
const HOUR = 3_600_000;
let roots: string[] = [];
let workers: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  await Promise.all(workers.map(w => w.stop())); workers=[];
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks();
  await Promise.all(roots.map(root => fs.rm(root, {recursive:true, force:true}))); roots=[];
});
async function root() { const r=await fs.mkdtemp(path.join(process.env.TMPDIR!, 'judge-r3-')); roots.push(r); return r; }
async function pending(r: string) { const p=path.join(r,'a'.repeat(64),'failover-backups','.pending-judge'); await fs.mkdir(p,{recursive:true}); await fs.utimes(p,new Date(),new Date(Date.now()-3*HOUR)); return p; }
function setup(r: string, allowed=()=>true) {
  const db={execute:vi.fn(async()=>[]),transaction:vi.fn()}; installDatabaseWorkSignals(db);
  const coordinator=createDeliveryWorkCoordinator({owner:db,canRun:allowed,canReconcile:()=>true,onError:vi.fn()}); workers.push(coordinator);
  const svc=nativeHarnessBackupExpirationService(db as never,{stateBase:r,shouldContinue:allowed});
  return {db,coordinator,svc};
}
describe('independent round 3 safety',()=>{
  it('must not put a secret-derived constructor name into any log sink',async()=>{
    const secret='CredentialSentinelClass8392';
    const SecretError = ({[secret]:class extends Error{}})[secret];
    const error=new SecretError('synthetic message');
    reportNativeHarnessBackupCapture({scopeDigest:'a'.repeat(64),runId:'run',nativeSessionId:'session',outcome:'failed',reason:'capture_failed',error});
    const logs=JSON.stringify(Object.values(logger).flatMap(fn=>vi.mocked(fn).mock.calls));
    await fs.writeFile(path.join(OUT,'constructor-privacy.json'),JSON.stringify({constructorEqualsSentinel:error.constructor.name===secret,projected:nativeHarnessBackupErrorFields(error).errorCode,leakedToAnySink:logs.includes(secret)},null,2));
    expect(logs.includes(secret)).toBe(false);
  });
  it('performs zero filesystem scans for an empty root over a simulated day',async()=>{
    const r=await root(); vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    const {coordinator,svc}=setup(r);
    const read=vi.spyOn(fs,'readdir'); const stat=vi.spyOn(fs,'lstat');
    await svc.registerStalePendingScan(coordinator).ready;
    const startupReads=read.mock.calls.length; read.mockClear(); stat.mockClear();
    await vi.advanceTimersByTimeAsync(24*HOUR);
    const result={startupReads,idleReaddir:read.mock.calls.length,idleLstat:stat.mock.calls.length,nextWakeAt:coordinator.nextWakeAt()};
    await fs.writeFile(path.join(OUT,'idle-day.json'),JSON.stringify(result,null,2));
    expect(result).toEqual({startupReads:1,idleReaddir:0,idleLstat:0,nextWakeAt:null});
  });
  it('retains a half-inspected obligation across drain and retries within one hour after resume',async()=>{
    const r=await root(); const p=await pending(r); vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    let allowed=true; const {coordinator,svc}=setup(r,()=>allowed);
    const original=fs.readdir.bind(fs);
    vi.spyOn(fs,'readdir').mockImplementationOnce((async(...args:Parameters<typeof fs.readdir>)=>{ const out=await original(...args); allowed=false; return out; }) as typeof fs.readdir);
    const start=Date.now(); await svc.registerStalePendingScan(coordinator).ready;
    const pausedNext=coordinator.nextWakeAt(); expect(logger.warn).not.toHaveBeenCalled();
    const read=vi.mocked(fs.readdir); read.mockClear();
    await vi.advanceTimersByTimeAsync(2*HOUR); const scansDuringDrain=read.mock.calls.length;
    allowed=true; await vi.advanceTimersByTimeAsync(HOUR);
    await vi.waitFor(()=>expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({pendingRoot:p}),expect.any(String)));
    await fs.writeFile(path.join(OUT,'drain-resume.json'),JSON.stringify({retryDelay:pausedNext!-start,scansDuringDrain,warnings:vi.mocked(logger.warn).mock.calls.length,retained:true},null,2));
    expect(pausedNext!-start).toBe(HOUR); expect(scansDuringDrain).toBe(0);
  });
  it('does not repeat the same stale warning before the promised hourly deadline on unrelated capture wakes',async()=>{
    const r=await root(); await pending(r); vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    const {db,coordinator,svc}=setup(r); await svc.registerStalePendingScan(coordinator).ready;
    const first=vi.mocked(logger.warn).mock.calls.length;
    noteNativeHarnessBackupChange(db,{companyId:'company',scopeDigest:'b'.repeat(64)});
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(()=>expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now()));
    const result={initialWarnings:first,afterUnrelatedWake:vi.mocked(logger.warn).mock.calls.length,elapsedMs:0};
    await fs.writeFile(path.join(OUT,'early-duplicate.json'),JSON.stringify(result,null,2));
    expect(result.afterUnrelatedWake).toBe(first);
  });
  it('shared coordinator must not discard a truncated scan when drain reopens in its continuation',async()=>{
    const r=await root(); await pending(r); vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    let allowed=true;
    const {coordinator,svc}=setup(r,()=>{
      if(!allowed) { queueMicrotask(()=>{allowed=true;}); return false; }
      return true;
    });
    const original=fs.readdir.bind(fs);
    vi.spyOn(fs,'readdir').mockImplementationOnce((async(...args:Parameters<typeof fs.readdir>)=>{const out=await original(...args);allowed=false;return out;}) as typeof fs.readdir);
    await svc.registerStalePendingScan(coordinator).ready;
    const result={admissionReopened:allowed,warnings:vi.mocked(logger.warn).mock.calls.length,nextWakeAt:coordinator.nextWakeAt(),uninspectedPendingRemains:true};
    await fs.writeFile(path.join(OUT,'drain-coordinator-race.json'),JSON.stringify(result,null,2));
    expect(result.warnings>0 || result.nextWakeAt!==null).toBe(true);
  });
  it('retains an interrupted scan even when admission resumes before hasPending',async()=>{
    const r=await root(); await pending(r);
    let allowed=true;
    // Exercise the exact task contract independently of coordinator microtask timing:
    // a scan aborts, admission reopens, then the shared coordinator asks hasPending.
    let task: any; const fake={register:(_q:string,t:any)=>{task=t;return {ready:Promise.resolve(),wake:vi.fn(),stop:async()=>t.onStop?.()};}};
    const db={}; const svc=nativeHarnessBackupExpirationService(db as never,{stateBase:r,shouldContinue:()=>allowed});
    const original=fs.readdir.bind(fs);
    vi.spyOn(fs,'readdir').mockImplementationOnce((async(...args:Parameters<typeof fs.readdir>)=>{const out=await original(...args);allowed=false;return out;}) as typeof fs.readdir);
    const w=svc.registerStalePendingScan(fake as never);
    try {
      await task.run(new AbortController().signal); allowed=true;
      const hasPending=await task.hasPending(true), next=task.nextRunAt();
      await fs.writeFile(path.join(OUT,'drain-reopen-race.json'),JSON.stringify({warnings:vi.mocked(logger.warn).mock.calls.length,hasPending,next,uninspectedPendingRemains:true},null,2));
      expect(hasPending || next!==null).toBe(true);
    } finally {await w.stop();}
  });
});
