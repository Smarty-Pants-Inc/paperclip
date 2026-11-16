// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ hidden: true, companies: [] as { id: string }[] }));
const setBreadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("../lib/organization-creation", () => ({
  get ORGANIZATION_CREATION_HIDDEN() { return state.hidden; },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: null, companies: state.companies }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));

import { DashboardLive } from "./DashboardLive";

afterEach(() => { document.body.innerHTML = ""; });

// Data safety: do not direct an empty account toward hidden organization creation.
describe("DashboardLive empty state", () => {
  it.each([
    { hidden: true, hasCompany: false, message: "Select an organization to view live runs." },
    { hidden: false, hasCompany: false, message: "Create an organization to view live runs." },
    { hidden: true, hasCompany: true, message: "Select an organization to view live runs." },
    { hidden: false, hasCompany: true, message: "Select an organization to view live runs." },
  ])("hidden=$hidden, existing organization=$hasCompany", async ({ hidden, hasCompany, message }) => {
    state.hidden = hidden;
    state.companies = hasCompany ? [{ id: "company-1" }] : [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<DashboardLive />));
      expect(container.textContent).toBe(message);
    } finally { await act(async () => root.unmount()); }
  });
});
