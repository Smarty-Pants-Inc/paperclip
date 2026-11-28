// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { ThemeProvider } from "@/context/ThemeContext";
import type { TaskChatItem } from "./task-chat-model";
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: true, loaded: true, userId: "viewer" }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("TaskChatRunnerTurn task rows", () => {
  it.each(["running", "succeeded"])("separates stock task cards from activity while %s", async status => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const call = (id: string): TaskChatItem => ({ id, kind: "tool", name: "create_task", status: "completed" });
    const card = (id: string): TaskChatItem => ({ id, kind: "task_handoff", handoff: {
      id, issueId: id, identifier: null, title: `Created ${id}`, status: "todo",
      createdAt: "2026-10-26T12:00:00Z", sourceRunId: "run", suggestionInteractionId: null,
    } });
    try {
      await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider>
        <TaskChatRunnerTurn runId="run" status={status} startedAtMs={null}
          items={[call("one"), card("first"), call("two"), card("second"), call("three")]} />
      </ThemeProvider></QueryClientProvider>));
      const rows = [...host.querySelectorAll('[data-testid="task-chat-turn-timeline-row"]')];
      expect(rows.map(row => row.getAttribute("data-timeline-row-id")?.split(":")[0]))
        .toEqual(["one", "first", "two", "second", "three"]);
      expect(host.querySelectorAll(".coordinator-created-task")).toHaveLength(2);
      expect(rows[1].querySelector('a[href="/issues/first"]')?.textContent).toContain("Created first");
      expect(rows[1].querySelector(".coordinator-task-commitment")?.getAttribute("data-phase")).toBe("created");
    } finally {
      await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks();
    }
  });
});
