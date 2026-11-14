
  it.each(['missing','pending','running','failed','other-run-success','other-phase-success','same-run-success'] as const)('R4 R2-F1 fence: %s',async kind=>{
    const f=await seed(); await committed(f);
    const [before]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
    if(kind!=='missing') {
      const other=kind==='other-run-success'?await seed():f;
      await db.insert(workspaceOperations).values({companyId,issueId:other.issueId,heartbeatRunId:other.runId,
        phase:kind==='other-phase-success'?'workspace_prepare':'workspace_finalize',
        status:(['pending','running','failed'].includes(kind)?kind:'succeeded') as 'pending'|'running'|'failed'|'succeeded'});
    }
    await failure(f.runId);
    const [after]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
    console.log('JUDGE_FENCE',JSON.stringify({kind,phase:after.phase,nextAttempt:after.nextAttemptAt}));
    if(kind==='same-run-success') expect(after).toEqual(before);
    else {
      expect(after.phase).toBe('retryable_failure');
      expect(after.nextAttemptAt!.getTime()-after.updatedAt.getTime()).toBe(30000);
    }
  });
});
