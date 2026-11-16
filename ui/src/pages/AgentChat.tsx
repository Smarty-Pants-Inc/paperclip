import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentChatsApi } from "@/api/agentChats";
import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { accessApi } from "@/api/access";
import { Button } from "@/components/ui/button";
import { CoordinatorRelativeTime } from "@/components/coordinator/CoordinatorRelativeTime";
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
  const userId =
    session.data?.user?.id ?? session.data?.session?.userId ?? null;
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
  const chatKey = queryKeys.agentChats.detail(selectedCompanyId, userId, agent?.id);
  const chat = useQuery({
    queryKey: chatKey,
    queryFn: () => agentChatsApi.get(selectedCompanyId!, agent!.id),
    initialData: () => enabled && agent && session.isSuccess
      ? client.getQueryData<Issue[]>(queryKeys.agentChats.list(selectedCompanyId, userId))
        ?.find(issue => issue.companyId === selectedCompanyId && issue.conversationAgentId === agent?.id)
      : undefined,
    initialDataUpdatedAt: () => {
      const state = client.getQueryState(queryKeys.agentChats.list(selectedCompanyId, userId));
      return state?.isInvalidated ? 0 : state?.dataUpdatedAt;
    },
    enabled: enabled && !!agent && session.isFetched,
  });
  const [memberScope, setMemberScope] = useState<"mine" | "all">("mine");
  const [offset, setOffset] = useState(0);
  useEffect(() => { setMemberScope("mine"); setOffset(0); }, [selectedCompanyId, userId, agent?.id]);
  const allChats = useQuery({
    queryKey: [...queryKeys.agentChats.list(selectedCompanyId, userId), "all", agent?.id, offset],
    queryFn: () => agentChatsApi.list(selectedCompanyId!, { agentId: agent!.id, members: "all", limit: 50, offset }),
    enabled: enabled && !!agent && session.isSuccess && memberScope === "all",
  });
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId && memberScope === "all",
  });
  const ownerNames = useMemo(() => buildCompanyUserLabelMap(directory.data?.users), [directory.data?.users]);
  const allChatsView = useQueryView(allChats);
  const directoryView = useQueryView(directory);
  const sessionView = useQueryView(session);
  const historyView = useQueryView(historyAgent);
  const chatView = useQueryView(chat);
  const creating = useRef<Promise<Issue> | null>(null);
  useEffect(() => {
    creating.current = null;
  }, [selectedCompanyId, userId, agent?.id]);
  useEffect(() => {
    if (enabled && agent && session.isSuccess && chat.isSuccess)
      recordAgentChatVisit(agent.companyId, userId, agent.id, chat.data?.id ?? null);
  }, [enabled, agent?.id, agent?.companyId, userId, session.isSuccess, chat.isSuccess, chat.data?.id]);
  const ensureIssue = useCallback(async () => {
    if (!agent || !selectedCompanyId) throw new Error("Agent not found");
    if (chat.data) return chat.data;
    const promise = (creating.current ??= agentChatsApi.ensure(
      selectedCompanyId,
      agent.id,
    ));
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
  }, [agent, selectedCompanyId, chat.data, client, userId]);
  // An outage before anything loaded keeps the quiet loading copy; loaded
  // data renders through it.
  const reconnecting = agentsView.kind === "reconnecting" || sessionView.kind === "reconnecting"
    || chatView.kind === "reconnecting" || (!rosterAgent && historyView.kind === "reconnecting");
  if (!loaded || agents.isPending || session.isPending || historyAgent.isFetching && !agent || reconnecting)
    return (
      <p className="text-sm text-muted-foreground">Loading conversation…</p>
    );
  if (!enabled && !chat.data)
    return (
      <p className="text-sm text-muted-foreground">
        Agent Chat is disabled for this instance. An administrator can enable it in{" "}
        <Link className="underline underline-offset-4" to="/company/settings/instance/experimental#experimental-enableAgentChat">Experimental settings</Link>.
        {" "}Your workspace preference does not change Chat availability. Existing history remains available through task links.
      </p>
    );
  const failed = [agentsView, chatView, ...(rosterAgent ? [] : [historyView])].find((view) => view.kind === "error");
  if (failed)
    return (
      <QueryErrorState
        size="page"
        error={failed.error}
        action="load this conversation"
        onRetry={failed.retry}
        retrying={failed.isFetching}
      />
    );
  if (!agent)
    return <p className="text-sm text-destructive">Agent not found.</p>;
  if (chat.isPending)
    return (
      <p className="text-sm text-muted-foreground">Loading conversation…</p>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="group" aria-label="Conversation members" className="flex shrink-0 gap-1 px-4 py-2">
        <Button size="sm" variant={memberScope === "mine" ? "secondary" : "ghost"} aria-pressed={memberScope === "mine"} onClick={() => setMemberScope("mine")}>Mine</Button>
        <Button size="sm" variant={memberScope === "all" ? "secondary" : "ghost"} aria-pressed={memberScope === "all"} onClick={() => setMemberScope("all")}>All members</Button>
      </div>
      {memberScope === "mine" ? <div className="flex min-h-0 flex-1 flex-col">
        <TaskDetailSurface key={`${agent.id}:${userId}`} conversation={{ agent, issue: chat.data ?? null, ensureIssue }} />
      </div> : <section aria-label={`Conversations with ${agent.name}`} className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
        <h1 className="text-lg font-semibold">Conversations with {agent.name}</h1>
        {allChatsView.kind === "error" ? <QueryErrorState error={allChats.error} action="load conversations" onRetry={allChatsView.retry} />
          : directoryView.kind === "error" ? <QueryErrorState error={directory.error} action="load member names" onRetry={directoryView.retry} />
          : allChats.isPending || directory.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading conversations…</p>
          : <>
            <ul className="flex flex-col gap-2">
              {allChats.data?.map(item => <li key={item.id}>
                <Link to={`/issues/${item.identifier ?? item.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex min-w-0 flex-col gap-1"><span className="break-words text-sm font-medium">{item.title}</span><span className="text-sm text-muted-foreground">{ownerNames.get(item.conversationUserId ?? "") ?? "Company member"}</span></span>
                  <CoordinatorRelativeTime value={item.updatedAt} className="shrink-0 text-xs text-muted-foreground" />
                </Link>
              </li>)}
            </ul>
            {!allChats.data?.length && <p className="text-sm text-muted-foreground">No shared conversations on this page.</p>}
            <div className="flex gap-2">
              {offset > 0 && <Button variant="ghost" size="sm" onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</Button>}
              {allChats.data?.length === 50 && <Button variant="ghost" size="sm" onClick={() => setOffset(value => value + 50)}>Next</Button>}
            </div>
          </>}
      </section>}
    </div>
  );
}
