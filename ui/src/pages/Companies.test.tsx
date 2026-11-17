// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { Companies } from "./Companies";

const mockCompaniesApi = vi.hoisted(() => ({
  stats: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
const mockOpenOnboarding = vi.hoisted(() => vi.fn());
const costPolicy = vi.hoisted(() => ({ hidden: true }));
vi.mock("../lib/cost-visibility", () => ({
  get COST_BUDGET_UI_HIDDEN() { return costPolicy.hidden; },
}));
const creationPolicy = vi.hoisted(() => ({ hidden: false }));
vi.mock("../lib/organization-creation", () => ({
  get ORGANIZATION_CREATION_HIDDEN() { return creationPolicy.hidden; },
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        issuePrefix: "PAP",
        name: "Acme Labs",
        status: "active",
        budgetMonthlyCents: 50000,
        spentMonthlyCents: 57230,
      },
    ],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: mockOpenOnboarding }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

describe("Companies page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    creationPolicy.hidden = false;
    costPolicy.hidden = true;
    mockCompaniesApi.stats.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage({ cloud }: { cloud?: boolean } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cloud) queryClient.setQueryData(queryKeys.health, CLOUD_HEALTH);
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Companies />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  // Data safety: the admin's organization list must not offer accidental creation.
  it.each([true, false])("creation entry point: hidden=%s", async (hidden) => {
    creationPolicy.hidden = hidden;
    const root = await renderPage();
    try {
      const button = Array.from(container.querySelectorAll("button"))
        .find((element) => element.textContent?.includes("New Organization"));
      expect(Boolean(button)).toBe(!hidden);
      expect(container.textContent).toContain("Acme Labs");
      if (button) {
        act(() => button.click());
        expect(mockOpenOnboarding).toHaveBeenCalledWith();
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows configured company budgets without the spend-derived percentage when money UI is enabled", async () => {
    costPolicy.hidden = false;
    const root = await renderPage();
    try {
      expect(container.textContent).toContain("— / $500.00");
      expect(container.textContent).toContain("(—)");
      expect(container.textContent).not.toContain("114%");
      expect(container.textContent).not.toContain("$572.30");
    } finally { act(() => root.unmount()); }
  });

  it("shows no organization spend or budget summary", async () => {
    const root = await renderPage();
    try {
      expect(container.textContent).toContain("Acme Labs");
      expect(container.textContent).not.toMatch(/spend|spent|budget/i);
    } finally { act(() => root.unmount()); }
  });

  it("offers the company wizard when self-hosted", async () => {
    const root = await renderPage();

    expect(container.textContent).toContain("New Organization");

    act(() => {
      root.unmount();
    });
  });

  it("hides the company wizard on a cloud-managed instance", async () => {
    const root = await renderPage({ cloud: true });

    // Cloud stacks hold exactly one company and POST /companies is a 403 floor,
    // so the entry point must not be offered at all.
    expect(container.textContent).not.toContain("New Organization");
    expect(container.textContent).toContain("Acme Labs");
    expect(mockOpenOnboarding).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
