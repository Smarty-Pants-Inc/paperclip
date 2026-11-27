import { useContext, useEffect, useLayoutEffect, useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { paperclipHumanAvatarUrl } from "@/lib/issue-chat-human-author";
import { Link } from "@/lib/router";
import { StatusIcon } from "@/components/StatusIcon";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Identity } from "@/components/Identity";
import type { AvatarAgent } from "@/components/AgentAvatar";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { coordinatorRelativeLabel, useCoordinatorRelativeClock } from "./CoordinatorRelativeTime";
import { ChatComposerAccessoryActiveContext } from "@/components/chat-composer/ChatComposerAccessoryHost";
import { ChatTaskTrayMembershipContext, chatTaskTrayScopeKey, useChatTaskTray, type ChatTaskTrayItem } from "./useChatTaskTray";
import { buildChatTaskTray, CHAT_TASK_TRAY_GROUP_ORDER, CHAT_TASK_TRAY_LABELS, filterChatTaskTray, trayTaskStatusInput, type ChatTaskTrayRow } from "./chat-task-tray-model";
import "./CoordinatorChatTaskTray.css";

export interface CoordinatorChatTaskTrayProps {
  companyId: string;
  conversationIssueId: string;
  viewerUserId: string | null;
  sessionGeneration: number | null;
  onOpenConversationTasks: () => void;
}
type TrayUser = { name: string; image: string | null };
type Owners = { agents: ReadonlyMap<string, AvatarAgent>; users: ReadonlyMap<string, TrayUser> };
function ownerName(item: ChatTaskTrayItem, owners: Owners) {
  if (item.assigneeAgentId) return owners.agents.get(item.assigneeAgentId)?.name ?? "Agent";
  if (item.assigneeUserId) return owners.users.get(item.assigneeUserId)?.name ?? "User";
  return "Unassigned";
}
function Owner({ item, owners }: { item: ChatTaskTrayItem; owners: Owners }) {
  if (item.assigneeAgentId) return <AgentIdentity agent={owners.agents.get(item.assigneeAgentId) ?? { id: item.assigneeAgentId, name: "Agent" }} size="sm" />;
  if (item.assigneeUserId) {
    const user = owners.users.get(item.assigneeUserId);
    return <Identity name={user?.name ?? "User"} avatarUrl={paperclipHumanAvatarUrl(user?.image)} size="sm" />;
  }
  return <span>Unassigned</span>;
}
function TaskRow({ row, owners, single = false, clock }: { row: ChatTaskTrayRow; owners: Owners; single?: boolean; clock: number }) {
  const { item, presentation } = row;
  const age = item.updatedAt ? coordinatorRelativeLabel(item.updatedAt, clock) : null;
  return <Link to={`/issues/${item.identifier ?? item.issueId}`} disableIssueQuicklook
    data-testid={single ? "chat-task-tray-single" : "chat-task-tray-row"}
    className={`chat-task-tray-task ${single ? "chat-task-tray-single" : ""}`}
    onKeyDown={event => { if (event.key === " ") { event.preventDefault(); event.currentTarget.click(); } }}>
    <StatusIcon {...trayTaskStatusInput(item)} />
    <span className="chat-task-tray-task-copy">
      <span className="chat-task-tray-title" title={item.title}>{item.title}</span>
      <span className="chat-task-tray-meta">
        <span className="chat-task-tray-id">{item.identifier ?? item.issueId}</span>
        <span className="chat-task-tray-status" title={presentation.label}>{presentation.label}</span>
        <span className="chat-task-tray-owner"><Owner item={item} owners={owners} /></span>
      </span>
    </span>
    {age && <time className="chat-task-tray-age" dateTime={item.updatedAt} title={new Date(item.updatedAt!).toLocaleString()}>{age}</time>}
  </Link>;
}
/** Scope-keyed state: nothing from the previous viewer/chat survives even one paint. */
export function CoordinatorChatTaskTray(props: CoordinatorChatTaskTrayProps): JSX.Element | null {
  return <ScopedChatTaskTray key={chatTaskTrayScopeKey(props)} {...props} />;
}
function ScopedChatTaskTray(props: CoordinatorChatTaskTrayProps): JSX.Element | null {
  const tray = useChatTaskTray(props);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [settledPulse, setSettledPulse] = useState(0);
  const reducedMotion = useReducedMotion();
  const clock = useCoordinatorRelativeClock();
  const agents = useQuery({
    queryKey: [...queryKeys.agents.list(props.companyId), "tray", props.viewerUserId],
    queryFn: () => agentsApi.list(props.companyId), enabled: tray.enabled,
  });
  const users = useQuery({
    queryKey: [...queryKeys.access.companyUserDirectory(props.companyId), "tray", props.viewerUserId],
    queryFn: ({ signal }) => accessApi.listUserDirectory(props.companyId, { signal, fresh: true }), enabled: tray.enabled,
  });
  const owners = useMemo<Owners>(() => ({
    agents: new Map((agents.data ?? []).map(agent => [agent.id, agent])),
    users: new Map((users.data?.users ?? []).map(entry => [entry.principalId,
      { name: entry.user?.name ?? entry.user?.email ?? "User", image: entry.user?.image ?? null }])),
  }), [agents.data, users.data]);
  const model = useMemo(() => buildChatTaskTray(tray.items, item => ownerName(item, owners)), [tray.items, owners]);
  const visible = useMemo(() => filterChatTaskTray(model.rows, filter), [model.rows, filter]);
  const visibleGroups = useMemo(() => {
    const groups = new Map(CHAT_TASK_TRAY_GROUP_ORDER.map(group => [group, [] as ChatTaskTrayRow[]]));
    for (const row of visible) if (row.group) groups.get(row.group)!.push(row);
    return groups;
  }, [visible]);
  const publishMembership = useContext(ChatTaskTrayMembershipContext);
  const activeAccessory = useContext(ChatComposerAccessoryActiveContext);
  const representedIds = useMemo(() => activeAccessory && tray.enabled && !tray.loading && !tray.stale && !model.unavailable
    ? new Set(model.rows.map(row => row.item.issueId)) : null,
  [activeAccessory, tray.enabled, tray.loading, tray.stale, model]);
  useLayoutEffect(() => {
    publishMembership?.(props, representedIds);
  }, [publishMembership, representedIds, props.companyId, props.conversationIssueId, props.viewerUserId, props.sessionGeneration]);
  useLayoutEffect(() => () => publishMembership?.(props, null),
    [publishMembership, props.companyId, props.conversationIssueId, props.viewerUserId, props.sessionGeneration]);
  useEffect(() => { if (reducedMotion) setSettledPulse(tray.newTaskSequence); }, [reducedMotion, tray.newTaskSequence]);
  useEffect(() => { if (model.total < 2 || model.unavailable) { setOpen(false); setFilter(""); } }, [model.total, model.unavailable]);
  if (!tray.enabled || (!tray.loading && !tray.stale && !model.total)) return null;
  const shimmer = !reducedMotion && tray.newTaskSequence > settledPulse;
  const light = shimmer ? <span key={settledPulse} className="chat-task-tray-shimmer" aria-hidden="true"
    onAnimationEnd={() => setSettledPulse(value => value + 1)} /> : null;
  const retry = <button type="button" className="chat-task-tray-retry" onClick={tray.retry}>Retry</button>;
  const rootProps = { "data-testid": "chat-task-tray", "data-stale": tray.stale || undefined,
    "data-shimmer": shimmer || undefined, className: "chat-task-tray" };
  if (tray.loading || model.unavailable || (!model.total && tray.stale)) return <div {...rootProps}>
    <span className="chat-task-tray-message" role="status">{tray.loading ? "Loading open tasks…" : "Status unavailable"}</span>
    {!tray.loading && retry}
  </div>;
  const stale = tray.stale ? <><span className="chat-task-tray-stale" role="status">Stale</span>{retry}</> : null;
  if (model.total === 1) return <div {...rootProps}><TaskRow row={model.rows[0]} owners={owners} clock={clock} single />{stale}{light}</div>;
  return <Popover modal={false} open={open && model.total >= 2} onOpenChange={setOpen}>
    <PopoverAnchor asChild><div {...rootProps}>
      <PopoverTrigger asChild><button type="button" data-testid="chat-task-tray-summary" className="chat-task-tray-summary"
        aria-label={`${model.total} open tasks. ${model.preview}`}>
        <span className="chat-task-tray-summary-copy">
          <span className="chat-task-tray-preview">
            <strong>{model.total} open tasks</strong>
            <span className="chat-task-tray-preview-titles">{model.rows.slice(0, 2).map(row => row.item.title).join(", ")}</span>
            {model.total > 2 && <span>+{model.total - 2}</span>}
          </span>
          <span className="chat-task-tray-counts">
            {CHAT_TASK_TRAY_GROUP_ORDER.filter(group => model.counts[group] > 0).map(group => <span key={group}
              data-testid={`chat-task-tray-count-${group}`} className={group === "needs-you" ? "chat-task-tray-needs-you" : undefined}>
              <StatusIcon {...trayTaskStatusInput(model.groups[group][0].item)} />
              {model.counts[group]} {CHAT_TASK_TRAY_LABELS[group].toLowerCase()}
            </span>)}
          </span>
        </span>
        <ChevronUp className="chat-task-tray-chevron" aria-hidden="true" />
      </button></PopoverTrigger>{stale}{light}
    </div></PopoverAnchor>
    <PopoverContent side="top" avoidCollisions={false} align="start" className="chat-task-tray-panel"
      data-testid="chat-task-tray-panel" aria-label="Open tasks">
      {model.total >= 10 && <div className="chat-task-tray-filter-wrap"><Input data-testid="chat-task-tray-filter"
        aria-label="Filter open tasks by ID, title or owner" placeholder={`Filter ${model.total} open tasks…`} value={filter} onChange={event => setFilter(event.target.value)} /></div>}
      <div className="chat-task-tray-scroll">
        {CHAT_TASK_TRAY_GROUP_ORDER.map(group => {
          const rows = visibleGroups.get(group)!;
          return rows.length > 0 && <section key={group} aria-labelledby={`tray-${props.conversationIssueId}-${group}`}>
            <h3 id={`tray-${props.conversationIssueId}-${group}`} data-testid={`chat-task-tray-group-${group}`}>
              {CHAT_TASK_TRAY_LABELS[group]} · {rows.length}
            </h3>
            {rows.map(row => <TaskRow key={row.item.issueId} row={row} owners={owners} clock={clock} />)}
          </section>;
        })}
        {visible.length === 0 && <p className="chat-task-tray-message" role="status">No open tasks match.</p>}
      </div>
      <div className="chat-task-tray-footer"><span>{model.total} open tasks from this chat</span>
        <a href={`/issues/${props.conversationIssueId}`} data-testid="chat-task-tray-open-tasks"
          onClick={event => { event.preventDefault(); setOpen(false); props.onOpenConversationTasks(); }}>Open conversation tasks</a>
      </div>
    </PopoverContent>
  </Popover>;
}
