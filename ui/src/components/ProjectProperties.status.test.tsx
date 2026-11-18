// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProperties } from "./ProjectProperties";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "../lib/queryKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(() => {
    callback();
  });
}

const noop = vi.hoisted(() => () => undefined);

vi.mock("../api/projects", () => ({ projectsApi: { createWorkspace: vi.fn(), removeWorkspace: vi.fn(), updateWorkspace: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn().mockResolvedValue([]), listUserSecretDefinitions: vi.fn().mockResolvedValue([]), create: vi.fn() } }));
vi.mock("../api/environments", () => ({ environmentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) } }));
vi.mock("@/api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn().mockResolvedValue(null),
    listMembers: vi.fn().mockResolvedValue({
      members: [
        { user: { id: "scott", name: "Scott", email: "scott@example.test" } },
        { user: { id: "riley", name: "Riley", email: "riley@example.test" } },
      ],
    }),
  },
}));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue(null) } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ companies: [{ id: "company-1", issuePrefix: "PAP" }], selectedCompanyId: "company-1", setSelectedCompanyId: vi.fn() }),
}));

// Heavy children that are unrelated to the status control.
vi.mock("./environment-variables-editor", () => ({ EnvironmentVariablesEditor: () => null }));
vi.mock("./InlineEditor", () => ({ InlineEditor: ({ value }: { value?: ReactNode }) => <div>{value}</div> }));
vi.mock("./PathInstructionsModal", () => ({ ChoosePathButton: () => null }));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    urlKey: "project-1",
    name: "Test project",
    description: "A long description that fills the value column",
    status: "in_progress",
    goalIds: [],
    goals: [],
    env: null,
    codebase: { workspaceId: null, repoUrl: null, repoRef: null, defaultRef: null, repoName: null },
    primaryWorkspace: null,
    workspaces: [],
    executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", allowIssueOverride: true },
    ...overrides,
  } as unknown as Project;
}

function primedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.health, { hiddenSettings: [] });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableIsolatedWorkspaces: true });
  return client;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(project: Project, onFieldUpdate?: (field: string, data: Record<string, unknown>) => void) {
  act(() => {
    root.render(
      <QueryClientProvider client={primedClient()}>
        <TooltipProvider>
          <ProjectProperties project={project} onFieldUpdate={onFieldUpdate} onArchive={noop} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Visibility");
  });
}

// The project's pill follows its tasks, so Configuration carries no hand-set
// Status control (upstream removed it; it stays removed).
describe("ProjectProperties status", () => {
  it("has no Status control", async () => {
    await render(makeProject({ status: "in_progress" }), vi.fn());

    expect(container.querySelector("[data-testid='project-status']")).toBeNull();
    expect(container.querySelector("select[aria-label='Status']")).toBeNull();
    const optionLabels = [...container.querySelectorAll("option")].map((option) => option.textContent);
    expect(optionLabels).not.toContain("Completed");
    expect(optionLabels).not.toContain("Planned");
  });

  it("has no Status control when the project is read-only", async () => {
    await render(makeProject({ status: "planned" }));

    expect(container.querySelector("[data-testid='project-status']")).toBeNull();
    expect(container.querySelector("select[aria-label='Status']")).toBeNull();
  });
});
