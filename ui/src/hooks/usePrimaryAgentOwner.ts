import { useQuery } from "@tanstack/react-query";
import type { MemberPrimaryAgent } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { primaryAgentApi } from "@/api/primaryAgent";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The other active member whose primary Smarty this agent is. Undefined when it
 * is the viewer's own primary (even if shared), nobody's primary, or unknown.
 */
export function otherMemberPrimaryOwner(
  primaries: readonly MemberPrimaryAgent[] | undefined,
  agentId: string | undefined,
  viewerId: string,
): string | undefined {
  if (!primaries || !agentId) return undefined;
  if (primaries.some(item => item.agentId === agentId && item.userId === viewerId)) return undefined;
  return primaries.find(item => item.agentId === agentId)?.userId;
}

export type PrimaryAgentOwnerStatus = "mine" | "other" | "nobody" | "pending" | "error";

/**
 * One answer for every route that opens an agent: is it another member's
 * Smarty? Such an agent opens only that member's chat, read-only. When the
 * session or ownership can't be read the answer is "error", never "nobody":
 * callers must not offer the owner's actions on an unknown answer.
 */
export function usePrimaryAgentOwner(companyId: string | null | undefined, agentId: string | undefined, enabled = true) {
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const viewerId = userId ?? "local-board";
  const primaries = useQuery({
    queryKey: queryKeys.primaryAgent.members(companyId!, viewerId),
    queryFn: () => primaryAgentApi.list(companyId!),
    enabled: enabled && !!companyId && session.isSuccess,
  });
  const otherOwnerId = otherMemberPrimaryOwner(primaries.data, agentId, viewerId);
  const status: PrimaryAgentOwnerStatus = !enabled ? "nobody"
    : session.isError ? "error"
    : !session.isSuccess || !agentId ? "pending"
    : primaries.data ? (otherOwnerId ? "other" : primaries.data.some(item => item.agentId === agentId) ? "mine" : "nobody")
    : primaries.isError ? "error"
    : "pending";
  const retry = () => { void (session.isError ? session.refetch() : primaries.refetch()); };
  const error = status === "error" ? (session.error ?? primaries.error) : null;
  const retrying = session.isFetching || primaries.isFetching;
  return { session, userId, primaries, status, ownerId: status === "other" ? otherOwnerId : undefined, otherOwnerId, error, retry, retrying };
}
