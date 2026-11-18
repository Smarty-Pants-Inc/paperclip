/**
 * Does a live warm native owner in THIS process hold a sandbox lease?
 *
 * The warm owners live in the native session executor's in-memory map. The
 * environment runtime must ask before it treats a previous boot's ACTIVE lease
 * tip as closed (J3-26), but it cannot import the executor. The executor
 * registers a probe here when it loads; until it loads, this process has no
 * warm owners, so no probe means no holder. A probe that throws counts as a
 * holder (fail closed).
 */
export type WarmOwnerLeaseHolderQuery = {
  companyId: string;
  providerLeaseId: string;
  heartbeatRunId: string | null;
};

type WarmOwnerLeaseHolderProbe = (lease: WarmOwnerLeaseHolderQuery) => boolean;

const probes = new Set<WarmOwnerLeaseHolderProbe>();

export function registerWarmOwnerLeaseHolderProbe(probe: WarmOwnerLeaseHolderProbe): () => void {
  probes.add(probe);
  return () => { probes.delete(probe); };
}

export function warmOwnerInThisProcessHoldsLease(lease: WarmOwnerLeaseHolderQuery): boolean {
  for (const probe of probes) {
    try {
      if (probe(lease)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
