
  it('JUDGE R5 real exited prior-boot finalizer cannot authorize with only an unexpired timestamp',async()=>{
    const f=await materialized();await failure(f);await copybackSuccess(f);
    const child=spawnSync(process.execPath,['--import',path.join(process.cwd(),'server/node_modules/tsx/dist/loader.mjs'),path.join(process.cwd(),'server/src/__tests__/judge-r5-claim-child.ts')],{
      cwd:process.cwd(),env:{...process.env,JUDGE_DATABASE_URL:externalTestDatabaseUrl??temporary!.connectionString,JUDGE_RUN_ID:f.runId},encoding:'utf8',timeout:60000,
    });
    expect(child.status,child.stderr).toBe(0);expect(child.stdout).toContain('JUDGE_CLAIM_CHILD ');
    const c=await row(f.runId);
    expect(c.phase).toBe('arbitrating');expect(c.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const {readNativeLeaseHolder,nativeLeaseHolderStamp}=await import('../services/native-runtime/native-token-lease-settlement.js');
    const {proveOwnerGone}=await import('../services/owner-proof.js');
    const holder=readNativeLeaseHolder(c.leaseHolder,c.leaseOwner);expect(holder).not.toBeNull();
    const proof=await proveOwnerGone(nativeLeaseHolderStamp(holder!,'native_finalizer_lease'));
    expect(proof.verdict).toBe('gone');
    const allowed=await auth(f),transport=await publishPending(db,f.publication.id,true);
    console.log('JUDGE_R5_DEAD_BOOT',JSON.stringify({childStatus:child.status,proof,phase:c.phase,expiryInFuture:c.leaseExpiresAt!.getTime()>Date.now(),allowed,transport,state:(await publicationRow(f.publication.id)).state}));
    expect.soft(allowed).toBe(false);expect.soft(transport.errors).toEqual([]);expect.soft(transport.sends).toHaveLength(0);
  },120000);
