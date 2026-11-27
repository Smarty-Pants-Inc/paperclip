// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act as reactAct, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "./Layout";
const classicWorkspace = vi.hoisted(() => ({ enabled: false }));
const mockSidebarState = vi.hoisted(() => ({ isMobile: false }));
const mockPanelState = vi.hoisted(() => ({ visible: false, showsArtifact: false, content: null as ReactNode, setVisible: vi.fn() }));
const mockNavigate = vi.hoisted(() => vi.fn());
let currentPathname = "/PAP/chats/planner";
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: !classicWorkspace.enabled, loaded: true, userId: "viewer" }) }));
vi.mock("@/hooks/useBrowserTimeZoneSync", () => ({ useBrowserTimeZoneSync: () => undefined }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("@/lib/router", () => ({
  Outlet: () => <div>Conversation</div>, useLocation: () => ({ key: "chat", pathname: currentPathname, search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate, useNavigationType: () => "PUSH", useParams: () => ({ companyPrefix: "PAP" }),
}));
vi.mock("@/context/CompanyContext", () => {
  const company = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  return { useCompany: () => ({ companies: [company], selectedCompany: company, selectedCompanyId: company.id, loading: false, selectionSource: "manual", setSelectedCompanyId: vi.fn() }) };
});
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ ...mockSidebarState, sidebarOpen: true, setSidebarOpen: vi.fn(), toggleSidebar: vi.fn() }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ panelVisible: mockPanelState.visible, panelShowsArtifact: mockPanelState.showsArtifact, panelContent: mockPanelState.content, setPanelVisible: mockPanelState.setVisible, togglePanelVisible: vi.fn() }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn(), openOnboarding: vi.fn() }) }));
vi.mock("@/hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => undefined }));
vi.mock("@/hooks/useCompanyPageMemory", () => ({ useCompanyPageMemory: () => undefined }));
vi.mock("@/api/health", () => ({ healthApi: { get: async () => ({ status: "ok", deploymentMode: "authenticated", deploymentExposure: "private" }) } }));
vi.mock("@/lib/company-selection", () => ({ shouldSyncCompanySelectionFromRoute: () => false, resolveArchivedCompanyBounce: () => null }));
vi.mock("@/lib/main-content-focus", () => ({ scheduleMainContentFocus: () => () => undefined }));
vi.mock("@/plugins/slots", () => ({ usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }), resolveRouteSidebarSlot: () => null, PluginSlotMount: () => null }));
// Keep the real shell and secondary sidebar; unrelated page chrome is outside this regression.
vi.mock("./Sidebar", () => ({ Sidebar: () => <div>Main company nav</div> }));
vi.mock("./BreadcrumbBar", () => ({ BreadcrumbBar: ({ toolbarAction }: { toolbarAction?: ReactNode }) => <div>{toolbarAction}</div> }));
vi.mock("./AgentConversationsSidebar", () => ({ AgentConversationsSidebar: ({ compact }: { compact?: boolean }) => compact ? <button>Browse chats</button> : <aside aria-label="Chat contacts" /> }));
vi.mock("./AppsSidebar", () => ({ AppsSidebar: () => null, useAppsDeveloperTabs: () => [] }));
vi.mock("./CompanySettingsSidebar", () => ({ CompanySettingsSidebar: () => null }));
vi.mock("./access/CompanySettingsNav", () => ({ CompanySettingsNav: () => null }));
vi.mock("./AppConnectionSidebar", () => ({ AppDetailSidebar: () => null }));
vi.mock("./AgentContextualSidebar", () => ({ AgentContextualSidebar: () => null }));
vi.mock("./SkillsContextualSidebar", () => ({ SkillsContextualSidebar: () => null }));
vi.mock("./PropertiesPanel", () => ({ PropertiesPanel: () => null }));
vi.mock("./BoardDialogs", () => ({ BoardDialogs: () => null }));
vi.mock("./CloudTrialGate", () => ({ CloudTrialGate: () => null }));
vi.mock("./PluginAppShellOverlays", () => ({ PluginAppShellOverlays: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./KeyboardShortcutsCheatsheet", () => ({ KeyboardShortcutsCheatsheet: () => null }));
vi.mock("./ToastViewport", () => ({ ToastViewport: () => null }));
vi.mock("./AnnouncementWell", () => ({ AnnouncementWell: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./WorktreeBanner", () => ({ WorktreeBanner: () => null }));
vi.mock("./DevRestartBanner", () => ({ DevRestartBanner: () => null }));
vi.mock("./StandaloneBrowserControls", () => ({ StandaloneBrowserControls: () => null }));
vi.mock("./SidebarAccountMenu", () => ({ SidebarAccountMenu: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderLayoutView(root: ReturnType<typeof createRoot>, queryClient: QueryClient) {
  root.render(<QueryClientProvider client={queryClient}><Layout /></QueryClientProvider>);
}
describe("fork optional chat list", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container);
    mockSidebarState.isMobile = false; mockPanelState.visible = false; mockPanelState.showsArtifact = false; mockPanelState.content = null;
  });
  afterEach(() => container.remove());
  it("opens chats alone, with an optional desktop list that collapses for artifacts", async () => {
    classicWorkspace.enabled = false;
    currentPathname = "/PAP/chats/planner";
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const style = document.createElement("style");
    style.textContent = ":root { --sz-280px: 280px; --sz-420px: 420px; }";
    document.head.append(style);
    let readingWidth = 416;
    let measure: ResizeObserverCallback | undefined;
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => readingWidth);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { measure = callback; }
      observe() {}
      disconnect() {}
    });
    const render = () => reactAct(async () => renderLayoutView(root, queryClient));
    localStorage.removeItem("paperclip:chat-list-beside");
    try {
      await render();
      expect(container.querySelector("[data-secondary-sidebar]")).toBeNull();
      await reactAct(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show chat list"]')!.click());
      expect(localStorage.getItem("paperclip:chat-list-beside")).toBe("true");
      const list = container.querySelector('[aria-label="Chat contacts"]')?.closest("[data-secondary-sidebar]");
      expect(list?.classList.contains("hidden")).toBe(false);
      expect(container.textContent).not.toContain("Browse chats");

      mockPanelState.visible = true;
      mockPanelState.content = <div>Tasks</div>;
      await render();
      expect(list?.classList.contains("hidden")).toBe(false);

      mockPanelState.showsArtifact = true;
      await render();
      expect(list?.classList.contains("hidden")).toBe(true);
      expect(container.textContent).toContain("Browse chats");

      mockPanelState.showsArtifact = false;
      await render();
      expect(list?.classList.contains("hidden")).toBe(false);
      mockPanelState.showsArtifact = true;
      await render();
      expect(list?.classList.contains("hidden")).toBe(true);

      readingWidth = 700;
      await reactAct(async () => measure?.([], {} as ResizeObserver));
      expect(list?.classList.contains("hidden")).toBe(false);

      readingWidth = 699;
      await reactAct(async () => measure?.([], {} as ResizeObserver));
      expect(list?.classList.contains("hidden")).toBe(true);

      mockPanelState.visible = false;
      await render();
      expect(list?.classList.contains("hidden")).toBe(false);
      expect(container.textContent).not.toContain("Browse chats");
      mockSidebarState.isMobile = true;
      await render();
      expect(container.querySelector("[data-secondary-sidebar]")).toBeNull();
      expect(container.textContent).toContain("Main company nav");
      expect(container.querySelector('[aria-label="Chat contacts"]')).toBeNull();
      expect(container.querySelector('[aria-label="Hide chat list"]')).toBeNull();
      mockSidebarState.isMobile = false;
      await render();
      await reactAct(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide chat list"]')!.click());
      expect(container.querySelector("[data-secondary-sidebar]")).toBeNull();
      expect(localStorage.getItem("paperclip:chat-list-beside")).toBe("false");
    } finally {
      localStorage.removeItem("paperclip:chat-list-beside");
      await reactAct(async () => root.unmount());
      queryClient.clear();
      width.mockRestore();
      vi.unstubAllGlobals();
      style.remove();
    }
  });
});
