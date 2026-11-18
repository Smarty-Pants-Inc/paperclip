import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { accessApi } from "@/api/access";
import { primaryAgentApi } from "@/api/primaryAgent";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useCompany } from "@/context/CompanyContext";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { recordAgentChatVisit } from "@/lib/recent-agent-chats";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useParams } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { TaskDetailSurface } from "./IssueDetail";
import { isUuidLike, type Issue } from "@paperclipai/shared";

export function AgentChat() {
  const { agentRef = "" } = useParams<{ agentRef: string }>();
  const { selectedCompanyId } = useCompany();
  const { enabled, loaded } = useAgentChatEnabled();
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agentsView = useQueryView(agents);
  const rosterAgent = agents.data?.find(
    (item) => item.id === agentRef || agentRouteRef(item) === agentRef,
  );
  const historyAgent = useQuery({
    queryKey: queryKeys.agents.detail(agentRef),
    queryFn: () => agentsApi.get(agentRef, selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId && (agentsView.kind === "ready" || agentsView.kind === "stale")
      && !rosterAgent && isUuidLike(agentRef),
  });
  const agent = rosterAgent ?? (historyAgent.data?.companyId === selectedCompanyId ? historyAgent.data : undefined);
  const primaries = useQuery({
    queryKey: queryKeys.primaryAgent.members(selectedCompanyId!, userId ?? "local-board"),
    queryFn: () => primaryAgentApi.list(selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId && session.isSuccess,
  });
  // A shared primary is still interactive for its own member. Otherwise open
  // only the other member's conversation, never the viewer's chat by accident.
  const ownPrimary = primaries.data?.some(item => item.agentId === agent?.id && item.userId === (userId ?? "local-board"));
  const otherOwnerId = ownPrimary ? undefined : primaries.data?.find(item => item.agentId === agent?.id)?.userId;
  const ownChatEnabled = enabled && !!agent && session.isSuccess && primaries.isSuccess && !otherOwnerId;
  const chatKey = queryKeys.agentChats.detail(selectedCompanyId, userId, agent?.id);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => agentChatsApi.get(selectedCompanyId!, agent!.id),
    initialData: () => ownChatEnabled
      ? client.getQueryData<Issue[]>(queryKeys.agentChats.list(selectedCompanyId, userId))
        ?.find(issue => issue.companyId === selectedCompanyId && issue.conversationAgentId === agent?.id)
      : undefined,
    initialDataUpdatedAt: () => {
      const state = client.getQueryState(queryKeys.agentChats.list(selectedCompanyId, userId));
      return state?.isInvalidated ? 0 : state?.dataUpdatedAt;
    },
    enabled: ownChatEnabled,
  });
  const memberChat = useQuery({
    queryKey: [...queryKeys.agentChats.list(selectedCompanyId, userId), "owner", agent?.id, otherOwnerId],
    queryFn: async () => {
      // The existing shared-chat read is paginated. An absent owner on page one
      // does not mean they have no conversation.
      for (let offset = 0; ; offset += 100) {
        const page = await agentChatsApi.list(selectedCompanyId!, { agentId: agent!.id, members: "all", limit: 100, offset });
        const owned = page.find(item => item.conversationUserId === otherOwnerId);
        if (owned) return owned;
        if (page.length < 100) return null;
      }
    },
    enabled: enabled && !!agent && session.isSuccess && primaries.isSuccess && !!otherOwnerId,
  });
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: enabled && !!selectedCompanyId && !!otherOwnerId,
  });
  const ownerNames = useMemo(() => buildCompanyUserLabelMap(directory.data?.users), [directory.data?.users]);
  const primariesView = useQueryView(primaries);
  const memberChatView = useQueryView(memberChat);
  const directoryView = useQueryView(directory);
  const sessionView = useQueryView(session);
  const historyView = useQueryView(historyAgent);
  const chatView = useQueryView(chat);
  const creating = useRef<Promise<Issue> | null>(null);
  useEffect(() => { creating.current = null; }, [selectedCompanyId, userId, agent?.id]);
  useEffect(() => {
    if (ownChatEnabled && agent && chat.isSuccess)
      recordAgentChatVisit(agent.companyId, userId, agent.id, chat.data?.id ?? null);
  }, [ownChatEnabled, agent?.id, agent?.companyId, userId, chat.isSuccess, chat.data?.id]);
  const ensureIssue = useCallback(async () => {
    if (!ownChatEnabled || !agent || !selectedCompanyId) throw new Error("This conversation is read-only");
    if (chat.data) return chat.data;
    const promise = (creating.current ??= agentChatsApi.ensure(selectedCompanyId, agent.id));
    try {
      const issue = await promise;
      client.setQueryData(queryKeys.issues.detail(issue.id), issue);
      client.setQueryData(chatKey, issue);
      void client.invalidateQueries({ queryKey: queryKeys.agentChats.list(selectedCompanyId, userId) });
      return issue;
    } catch (error) {
      creating.current = null;
      throw error;
    }
  }, [ownChatEnabled, agent, selectedCompanyId, chat.data, client, chatKey, userId]);
  const relevantViews = [agentsView, sessionView, ...(enabled ? [primariesView] : []),
    ...(otherOwnerId ? [memberChatView, directoryView] : [chatView]), ...(rosterAgent ? [] : [historyView])];
  const reconnecting = relevantViews.some(view => view.kind === "reconnecting");
  if (!loaded || agents.isPending || session.isPending || historyAgent.isFetching && !agent || reconnecting)
    return <p className="text-sm text-muted-foreground">Loading conversation…</p>;
  if (!enabled && !chat.data)
    return (
      <p className="text-sm text-muted-foreground">
        Agent Chat is disabled for this instance. An administrator can enable it in{" "}
        <Link className="underline underline-offset-4" to="/company/settings/instance/experimental#experimental-enableAgentChat">Experimental settings</Link>.
        {" "}Your workspace preference does not change Chat availability. Existing history remains available through task links.
      </p>
    );
  const failed = relevantViews.find(view => view.kind === "error");
  if (failed)
    return <QueryErrorState size="page" error={failed.error} action="load this conversation" onRetry={failed.retry} retrying={failed.isFetching} />;
  if (!agent) return <p className="text-sm text-destructive">Agent not found.</p>;
  if (primaries.isPending || (otherOwnerId ? memberChat.isPending || directory.isPending : chat.isPending))
    return <p className="text-sm text-muted-foreground">Loading conversation…</p>;
  if (otherOwnerId) {
    const ownerName = ownerNames.get(otherOwnerId) ?? "Company member";
    if (!memberChat.data) return <p className="text-sm text-muted-foreground">{ownerName} hasn't chatted with {agent.name} yet</p>;
    return (
      <section aria-label={`${ownerName}'s chat with ${agent.name}`} className="flex h-full min-h-0 flex-col">
        <h1 className="shrink-0 break-words px-4 py-2 text-lg font-semibold">{ownerName}'s chat with {agent.name}</h1>
        <TaskDetailSurface key={`${agent.id}:${otherOwnerId}`} conversation={{ agent, issue: memberChat.data, ensureIssue }} />
      </section>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TaskDetailSurface key={`${agent.id}:${userId}`} conversation={{ agent, issue: chat.data ?? null, ensureIssue }} />
    </div>
  );
}
