// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePreference } from "@paperclipai/shared";

const api = vi.hoisted(() => ({
  saved: {} as Record<string, "fold" | "inline">,
  update: vi.fn(),
  agentUpdate: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: "user-1" }, session: { userId: "user-1" } }) },
}));
vi.mock("@/api/health", () => ({ healthApi: { get: async () => ({ deploymentMode: "authenticated" }) } }));
vi.mock("@/api/workspacePreferences", () => ({
  workspacePreferencesApi: {
    get: async (): Promise<WorkspacePreference> => ({
      userId: "user-1", coordinatorWorkspaceEnabled: true, timeZone: null, updatedAt: null,
      agentReasoningDisplay: { ...api.saved },
    }),
    update: api.update,
  },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { update: api.agentUpdate } }));

import { findUIAdapter, registerUIAdapter } from "@/adapters/registry";
import { AgentReasoningDisplaySetting } from "./AgentReasoningDisplaySetting";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  api.saved = {};
  api.update.mockReset();
  api.agentUpdate.mockReset();
  api.update.mockImplementation(async (_companyId: string, data: { agentReasoningDisplay: { agentId: string; display: "fold" | "inline" | null } }) => {
    const { agentId, display } = data.agentReasoningDisplay;
    if (display) api.saved[agentId] = display; else delete api.saved[agentId];
    return { userId: "user-1", coordinatorWorkspaceEnabled: true, timeZone: null, updatedAt: new Date().toISOString(),
      agentReasoningDisplay: { ...api.saved } };
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  client.clear();
});

const agent = { id: "agent-1", companyId: "company-1", adapterType: "codex_local" };

function render(target: typeof agent = agent) {
  flushSync(() => root.render(
    <QueryClientProvider client={client}><AgentReasoningDisplaySetting agent={target} /></QueryClientProvider>,
  ));
}
const radio = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  .find((node) => node.textContent?.trim().startsWith(name))!;
async function loaded() {
  await vi.waitFor(() => expect(container.querySelector('[role="radiogroup"][aria-busy="false"]')).not.toBeNull());
}

describe("Reasoning display on the agent's page", () => {
  it("shows the harness default when the person has not chosen", async () => {
    render();
    await loaded();
    expect(container.textContent).toContain("Reasoning display");
    expect(radio("Folded").getAttribute("aria-checked")).toBe("true");
    expect(radio("Inline").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Default for this harness: Folded");
  });

  it("follows an inline harness default", async () => {
    const original = findUIAdapter("codex_local")!;
    registerUIAdapter({ ...original, transcriptPresentation: { liveReasoningView: "inline" } });
    try {
      render();
      await loaded();
      expect(radio("Inline").getAttribute("aria-checked")).toBe("true");
    } finally {
      registerUIAdapter(original);
    }
  });

  it("shows Inline as the harness default for a Paperclip Runner (pi_rpc) agent", async () => {
    render({ ...agent, adapterType: "paperclip_runner" });
    await loaded();
    expect(radio("Inline").getAttribute("aria-checked")).toBe("true");
    expect(radio("Folded").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Default for this harness: Inline");
  });

  it("keeps a stored Folded for a Paperclip Runner agent", async () => {
    api.saved = { "agent-1": "fold" };
    render({ ...agent, adapterType: "paperclip_runner" });
    await loaded();
    expect(radio("Folded").getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Default for this harness: Inline");
  });

  it("shows the person's saved choice for this agent", async () => {
    api.saved = { "agent-1": "inline", "agent-2": "fold" };
    render();
    await loaded();
    expect(radio("Inline").getAttribute("aria-checked")).toBe("true");
  });

  it("saves the choice as the person's preference keyed by agent, never through the agent", async () => {
    render();
    await loaded();
    await act(async () => { radio("Inline").click(); });
    await vi.waitFor(() => expect(radio("Inline").getAttribute("aria-checked")).toBe("true"));
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update).toHaveBeenCalledWith("company-1", { agentReasoningDisplay: { agentId: "agent-1", display: "inline" } });
    expect(api.agentUpdate).not.toHaveBeenCalled();
    await act(async () => { radio("Folded").click(); });
    await vi.waitFor(() => expect(radio("Folded").getAttribute("aria-checked")).toBe("true"));
    expect(api.update).toHaveBeenLastCalledWith("company-1", { agentReasoningDisplay: { agentId: "agent-1", display: "fold" } });
    expect(api.agentUpdate).not.toHaveBeenCalled();
  });
});
