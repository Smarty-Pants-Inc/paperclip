// Keep: capability trust boundary and retained-allocation data safety.
import { afterEach, expect, it, vi } from 'vitest';
import plugin from './plugin.js';
import manifest from './manifest.js';
const base = {driverKey:'boat',companyId:'route-company',environmentId:'route-env',config:{apiKey:'fixture-only'},runId:'run'};
afterEach(()=>vi.unstubAllGlobals());
it('declares verified route-A methods while keeping environment opt-in off',()=>{
 expect(manifest.environmentDrivers![0].sandboxCapabilities).toMatchObject({reusableLeases:true,duplexCommandStream:true});
 expect((manifest.environmentDrivers![0].configSchema as any).properties.duplexCarrier.default).toBe('off');
 for(const hook of ['onDuplexChannelOpen','onDuplexChannelWrite','onDuplexChannelStop','onDuplexChannelClose'] as const) expect(plugin.definition[hook]).toBeTypeOf('function');
});
it('non-SSH acquire has no marker and generic bridge open fails typed without I/O',async()=>{
 const network=vi.fn(async()=>new Response(JSON.stringify({sandbox:{id:'bx_routeoff',state:'ready'}})));
 vi.stubGlobal('fetch',network);
 const lease=await plugin.definition.onEnvironmentAcquireLease!(base);
 expect(lease.metadata?.runnerGuardianVersion).toBeUndefined();
 expect(lease.metadata?.guardianPreflight).toBeUndefined();
 network.mockClear();
 expect(plugin.definition.onDuplexChannelOpen).toBeTypeOf('function');
 await expect(plugin.definition.onDuplexChannelOpen!({...base,providerLeaseId:'bx_routeoff',hostRouteId:'route-off',command:['node','generic-callback-bridge']})).rejects.toMatchObject({code:'BOAT_SSH_LEASE_UNBOUND'});
 expect(network).not.toHaveBeenCalled();
});
it('disabled resume strips both an old marker and preflight receipt',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sandbox:{id:'bx_routeoff2',state:'ready'}}))));
 const lease=await plugin.definition.onEnvironmentResumeLease!({...base,providerLeaseId:'bx_routeoff2',leaseMetadata:{runnerGuardianVersion:1,guardianPreflight:{usable:true}}});
 expect(lease.metadata?.runnerGuardianVersion).toBeUndefined();
 expect(lease.metadata?.guardianPreflight).toBeUndefined();
});
