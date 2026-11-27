import { createContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginChatComposerAccessoryContext } from "@paperclipai/shared/types/plugin";
import { useResolvedTheme } from "@/context/ThemeContext";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import "./ChatComposerAccessoryHost.css";

export interface ChatComposerAccessoryHostProps {
  companyId: string;
  conversationIssueId: string;
  agentId: string;
  children: ReactNode;
}

/** Contributions can suspend their own effects while another accessory is selected. */
export const ChatComposerAccessoryActiveContext = createContext(true);

/** One primary accessory; selecting another remounts contributions to close panels. */
export function ChatComposerAccessoryHost({ companyId, conversationIssueId, agentId, children }: ChatComposerAccessoryHostProps) {
  const theme = useResolvedTheme();
  const { slots } = usePluginSlots({ slotTypes: ["chatComposerAccessory"], companyId });
  const orderedSlots = useMemo(() => [...slots].sort((a, b) =>
    (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
    || (a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), [slots]);
  const context = useMemo<PluginChatComposerAccessoryContext>(() => ({
    companyId, conversationIssueId, agentId, theme, entityId: conversationIssueId, entityType: "issue",
  }), [companyId, conversationIssueId, agentId, theme]);
  const contributions = [
    { key: "builtin:tasks", label: "Tasks", content: children },
    ...orderedSlots.map(slot => ({
      key: JSON.stringify([slot.pluginKey, slot.id]), label: slot.displayName,
      content: <PluginSlotMount slot={slot} context={context} missingBehavior="hidden" fallback={null} />,
    })),
  ];
  const host = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [selection, setSelection] = useState<{ key: string; generation: number } | null>(null);
  const active = available.includes(selection?.key ?? "") ? selection!.key : available[0];

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    // React elements may return null (including the tray and missing/failed
    // plugins). Observe actual output, not the truthiness of their JSX element.
    const update = () => {
      const keys = Array.from(element.querySelectorAll<HTMLElement>("[data-accessory-key]"))
        .filter(node => node.childNodes.length > 0).map(node => node.dataset.accessoryKey!);
      setAvailable(previous => keys.length === previous.length && keys.every((key, i) => key === previous[i]) ? previous : keys);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [companyId, conversationIssueId, orderedSlots.length]);

  // The built-in needs no arbitration when no plugin contributes. A null tray
  // then leaves no wrapper, spacing or observer behind in the composer dock.
  if (orderedSlots.length === 0) return <>{children}</>;

  return (
    <div ref={host} className="chat-composer-accessory-host" hidden={!active} data-testid="chat-composer-accessory-host">
      {contributions.map(contribution => (
        <div key={`${contribution.key}:${selection?.generation ?? 0}`} data-accessory-key={contribution.key}
          className="chat-composer-accessory-primary" hidden={contribution.key !== active} inert={contribution.key !== active}>
          <ChatComposerAccessoryActiveContext.Provider value={contribution.key === active}>
            {contribution.content}
          </ChatComposerAccessoryActiveContext.Provider>
        </div>
      ))}
      {available.length > 1 ? (
        <label className="chat-composer-accessory-selector">
          <span aria-hidden>+{available.length - 1}</span>
          <select aria-label="Chat accessories" value={active}
            onChange={event => setSelection(previous => ({ key: event.target.value, generation: (previous?.generation ?? 0) + 1 }))}>
            {contributions.filter(item => available.includes(item.key)).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}
