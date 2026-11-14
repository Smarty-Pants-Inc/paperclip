
  it('JUDGE R5 transport after durable dead-owner settlement cannot strand reply before successor finalization',async()=>{
    const f=await materialized();await failure(f);await copybackSuccess(f);
    const child=spawnSync(process.execPath,['--import',path.join(process.cwd(),'server/node_modules/tsx/dist/loader.mjs'),path.join(process.cwd(),'server/src/__tests__/judge-r5-claim-child.ts')],{
      cwd:process.cwd(),env:{...process.env,JUDGE_DATABASE_URL:externalTestDatabaseUrl??temporary!.connectionString,JUDGE_RUN_ID:f.runId},encoding:'utf8',timeout:60000,
    });
    expect(child.status,child.stderr).toBe(0);expect(child.stdout).toContain('JUDGE_CLAIM_CHILD ');
    const {OWNABLE_KINDS}=await import('../services/recovery/ownership-registry.js');
    const {proveOwnerGone}=await import('../services/owner-proof.js');
    const kind=OWNABLE_KINDS.find(k=>k.id==='native_finalizer_lease')!;
    const [record]=await kind.listForRuns!(db,[f.runId]);expect(record.owner.kind).toBe('process');
    if(record.owner.kind!=='process')throw new Error('real claim must have process holder');
    const proof=await proveOwnerGone(record.owner.stamp);expect(proof.verdict).toBe('gone');
    const settled=await kind.settle!(db,record,{now:new Date(),proof});expect(settled.settled).toBe(true);
    const before=await row(f.runId);expect(before.phase).toBe('arbitrating');expect(before.leaseExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await auth(f)).toBe(false);
    const early=await publishPending(db,f.publication.id,true);expect(early.errors).toEqual([]);expect(early.sends).toHaveLength(0);
    const during=(await publicationRow(f.publication.id)).state;
    const first=restart(f,true),second=restart(f,true);
    console.log('JUDGE_R5_SETTLEMENT_RACE',JSON.stringify({proof,settled,during,first,second,originalDecisionId:f.original.decisionId,state:(await publicationRow(f.publication.id)).state,authorizedAfter:await auth(f)}));
    expect.soft(during).not.toBe('cancelled');
    expect.soft(first.errors).toEqual([]);expect.soft(first.allowed).toBe(true);expect.soft(first.decisionId).toBe(f.original.decisionId);
    expect.soft(first.sends).toHaveLength(1);expect.soft(second.sends).toHaveLength(0);
    expect.soft((await publicationRow(f.publication.id)).state).toBe('published');expect.soft(await commentsFor(f.runId)).toHaveLength(1);
  },120000);
