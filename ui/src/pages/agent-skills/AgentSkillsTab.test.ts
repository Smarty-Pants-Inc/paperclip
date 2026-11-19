// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "../../lib/queryKeys";
import { AgentSkillsTab } from "./AgentSkillsTab";
import { TooltipProvider } from "../../components/ui/tooltip";

vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));
vi.mock("./AgentSkillRow", () => ({ AgentSkillRow: ({ variant, data }: { variant: string; data: { key: string } }) =>
  createElement("div", { "data-skill": data.key, "data-variant": variant }) }));
import { toDesiredSkillPayload } from "./AgentSkillsTab";

// catch: https://github.com/Smarty-Pants-Inc/paperclip/blob/e8de03bc033cee15de9a35ed4015619ea7687573/ui/src/pages/agent-skills/AgentSkillsTab.tsx#L78-L88
// The HTTP boundary fails while the real query/client/error presentation renders.
describe("agent skills reads", () => {
  const agent = { id: "agent-load", companyId: "company-load", adapterType: "codex_local", adapterConfig: {} } as Agent;
  const key = "example/skills/review";
  const snapshot = { adapterType: "codex_local", supported: true, mode: "ephemeral", desiredSkills: [key], entries: [], warnings: [] };
  const library = [{ id: "skill-load", key, name: "Review", categories: [], sourceKind: "bundled", sourceType: "bundled" }];
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  async function renderReads(failed: "both" | "agent" | "library" | "network" | "none", empty = false) {
    let failure = failed;
    let finishRetry: (() => void) | undefined;
    let retryWait: Promise<void> | undefined;
    const requests: Array<{ path: string; status: number | "network" }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://localhost").pathname;
      expect(init?.method).toBe("GET");
      const agentRead = path === `/api/agents/${agent.id}/skills`;
      expect(agentRead || path === `/api/companies/${agent.companyId}/skills`).toBe(true);
      if (retryWait) await retryWait;
      const fails = failure === "both" || failure === "network" || failure === (agentRead ? "agent" : "library");
      requests.push({ path, status: fails ? failure === "network" ? "network" : 500 : 200 });
      if (fails && failure === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(fails ? { error: "Internal server error" } : agentRead ? { ...snapshot, desiredSkills: empty ? [] : snapshot.desiredSkills } : empty ? [] : library), {
        status: fails ? 500 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableBetaSkills: false });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      flushSync(() => root.unmount());
      client.clear();
      container.remove();
    };
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, { children: createElement(AgentSkillsTab, { agent, companyId: agent.companyId }) }))));
    const settle = async () => {
      for (let tick = 0; tick < 100; tick++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
        if (client.isFetching() === 0) return;
      }
      throw new Error("Skills reads did not settle");
    };
    await settle();
    return {
      container, client, requests, settle,
      failNext: (next: typeof failed) => { failure = next; },
      holdRetry: () => { retryWait = new Promise<void>((resolve) => { finishRetry = resolve; }); },
      releaseRetry: () => { finishRetry?.(); retryWait = undefined; },
    };
  }

  it.each(["both", "agent", "library", "network"] as const)("shows an error and Retry, not a saved empty library, when %s reads fail without data", async (failed) => {
    const { container, requests } = await renderReads(failed);
    expect(requests).toHaveLength(2);
    expect(requests.filter((request) => request.status !== 200)).toHaveLength(failed === "both" || failed === "network" ? 2 : 1);
    const error = container.querySelector('[role="alert"][data-query-view="error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain(failed === "network" ? "Connection interrupted" : "Couldn't load skills");
    expect(error?.querySelector("button")?.textContent).toBe("Retry");
    expect(container.textContent).not.toMatch(/\d+ of \d+ enabled/);
    expect(container.textContent).not.toContain("Saved");
    expect(container.textContent).not.toContain("No skills in the organization library");
    expect(container.querySelector('[data-skill]')).toBeNull();
  });

  it("Retry refetches both GETs without claiming a saved library, then restores successful data", async () => {
    const view = await renderReads("both");
    const retry = view.container.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(retry).not.toBeNull();
    view.failNext("none");
    view.holdRetry();
    try {
      await act(async () => retry!.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(view.container.textContent).not.toContain("Saved");
      expect(view.container.textContent).not.toMatch(/\d+ of \d+ enabled/);
    } finally {
      view.releaseRetry();
    }
    await view.settle();
    expect(view.requests.map((request) => request.status)).toEqual([500, 500, 200, 200]);
    expect(view.requests.slice(2).map((request) => request.path).sort()).toEqual(view.requests.slice(0, 2).map((request) => request.path).sort());
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).toContain("1 of 1 enabled");
    expect(view.container.textContent).toContain("Saved");
    expect(view.container.querySelector(`[data-skill="${key}"][data-variant="enabled"]`)).not.toBeNull();
  });

  it.each([false, true])("keeps successful reads unchanged (empty library: %s)", async (empty) => {
    const { container } = await renderReads("none", empty);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(empty ? "0 of 0 enabled" : "1 of 1 enabled");
    expect(container.textContent).toContain("Saved");
    if (empty) expect(container.textContent).toContain("No skills in the organization library");
    else expect(container.querySelector(`[data-skill="${key}"][data-variant="enabled"]`)).not.toBeNull();
  });

  it("keeps loaded data visible when background refetches fail", async () => {
    const view = await renderReads("none");
    view.failNext("both");
    await act(async () => {
      await Promise.all([
        view.client.refetchQueries({ queryKey: queryKeys.agents.skills(agent.id) }),
        view.client.refetchQueries({ queryKey: queryKeys.companySkills.list(agent.companyId) }),
      ]);
    });
    await view.settle();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).toContain("1 of 1 enabled");
    expect(view.container.querySelector(`[data-skill="${key}"][data-variant="enabled"]`)).not.toBeNull();
  });
});

describe("toDesiredSkillPayload", () => {
  const skillKey = "paperclipai/paperclip/paperclip";
  const versionId = "22222222-2222-4222-8222-222222222222";

  it("includes saved version pins while beta skills are enabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, true)).toEqual([
      { key: skillKey, versionId },
    ]);
  });

  it("omits saved version pins while beta skills are disabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, false)).toEqual([
      skillKey,
    ]);
  });
});


it("removes a connector from editable library rows when its automatic assignment arrives", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const agent = { id: "agent-1", companyId: "company-1", adapterType: "codex_local", adapterConfig: {} } as Agent;
  const key = "paperclipai/paperclip/agentmail";
  const snapshot = { adapterType: "codex_local", supported: true, mode: "ephemeral", desiredSkills: [], entries: [], warnings: [] };
  client.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
  client.setQueryData(queryKeys.companySkills.list(agent.companyId), [{ id: "skill-1", key, name: "agentmail", categories: [], sourceKind: "bundled", sourceType: "bundled" }]);
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableBetaSkills: false });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, { children: createElement(AgentSkillsTab, { agent, companyId: agent.companyId }) }))));
    expect(container.querySelector(`[data-skill="${key}"][data-variant="available"]`)).not.toBeNull();
    client.setQueryData(queryKeys.agents.skills(agent.id), { ...snapshot, desiredSkills: [key], entries: [{ key, runtimeName: "agentmail", desired: true, managed: true, readOnly: true, state: "configured" }] });
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-skill="${key}"][data-variant="available"]`)).toBeNull();
      expect(container.querySelector(`[data-skill="${key}"][data-variant="enabled"]`)).toBeNull();
      expect(container.textContent).toContain("Automatic and detected skills");
    });
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  }
});
