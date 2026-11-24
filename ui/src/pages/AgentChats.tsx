import { useEffect } from "react";
import { AgentConversationsSidebar } from "@/components/AgentConversationsSidebar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { Link } from "@/lib/router";

/** Chat is the list of all chats, as the page. Picking a chat replaces the list with that chat. */
export function AgentChats() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyId, enabled, loaded } = useAgentChatNavigation();
  useEffect(() => setBreadcrumbs([{ label: "Chat" }]), [setBreadcrumbs]);
  if (!loaded) return <p role="status" className="text-sm text-muted-foreground">Loading chat…</p>;
  if (!enabled) return <p className="text-sm text-muted-foreground">Agent Chat is off for this instance. An administrator can enable it in <Link className="underline underline-offset-4" to="/company/settings/instance/experimental#experimental-enableAgentChat">Experimental settings</Link>. Your workspace preference does not change Chat availability.</p>;
  if (!companyId) return <p className="text-sm text-muted-foreground">Select a company to start a conversation.</p>;
  return <div className="h-full w-full max-w-2xl md:-mx-3 [&>aside]:border-r-0"><AgentConversationsSidebar /></div>;
}
