// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsConnect } from "./AppsConnect";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  searchParams: new URLSearchParams(),
  params: {} as { appKey?: string },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
  useSearchParams: () => [mocks.searchParams, vi.fn()] as const,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/api/ai-connections", () => ({
  aiConnectionsApi: {
    list: vi.fn().mockResolvedValue({ connections: [], canManageConnections: true }),
    loginSetup: vi.fn(),
    startLocalLogin: vi.fn().mockResolvedValue({
      attemptId: "attempt-1",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=antigravity-state",
    }),
    checkLocalLogin: vi.fn().mockResolvedValue({
      status: "sign_in_required",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=antigravity-state",
    }),
    cancelLocalLogin: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
    getAdapterAuthSignal: vi.fn().mockResolvedValue({ status: "missing" }),
  },
}));

vi.mock("@/api/environments", () => ({
  environmentsApi: {
    list: vi.fn().mockResolvedValue([]),
    capabilities: vi.fn().mockResolvedValue({ environments: {} }),
  },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    get: vi.fn().mockResolvedValue({}),
    getExperimental: vi.fn().mockResolvedValue({}),
    getGeneral: vi.fn().mockResolvedValue({ executionMode: "standard" }),
  },
}));

vi.mock("@/api/health", () => ({
  healthApi: {
    get: vi.fn().mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      localAiLoginSupported: false,
      hostedGoogleAiLoginSupported: true,
    }),
  },
}));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: vi.fn().mockResolvedValue({ apps: [] }),
    listApplications: vi.fn().mockResolvedValue({ applications: [] }),
    listConnections: vi.fn().mockResolvedValue({ connections: [] }),
    getCloudConnectorEnrollment: vi.fn().mockResolvedValue({ configured: false, status: "not_configured" }),
    connectApp: vi.fn().mockResolvedValue({
      connectionId: "conn-1",
      application: { id: "app-1", name: "GitHub" },
      actions: { readOnly: [], canMakeChanges: [] },
      catalog: [],
      suggestedDefaults: {},
    }),
  },
}));

vi.mock("@/api/companies-query", () => ({
  useAccountIdentity: () => ({ userId: "board-user", settled: true, failed: false }),
  resolveAccountUserId: async () => "board-user",
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

vi.mock("@/components/new-agent/useSavedProviderKeys", () => ({
  useSavedProviderKeys: () => ({
    options: [],
    subscriptions: [],
    loading: false,
    storedLogin: { data: undefined, isPending: false, isError: false },
  }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = {};
  mocks.searchParams = new URLSearchParams();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function renderAppsConnect() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={client}>
        <BreadcrumbProvider><TooltipProvider><AppsConnect /></TooltipProvider></BreadcrumbProvider>
      </QueryClientProvider>,
    );
  });
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AppsConnect secret custody", () => {
  it("keeps a GitHub App private key masked and multiline through submission", async () => {
    mocks.searchParams = new URLSearchParams({ source: "github", method: "app-installation" });
    vi.mocked(toolsApi.listGallery).mockResolvedValueOnce({
      apps: CONNECTABLE_APP_DEFINITIONS.filter(app => app.slug === "github"),
      capabilities: { canCreateOrganizationGrant: true, organizationGrantReason: null, canSetCompanyInstall: true, companyInstallReason: null },
      credentialSources: { vercelConnect: { available: false, enabled: false, authentication: null, manageUrl: "", reason: null } },
    });
    renderAppsConnect();
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Your GitHub key"]')).not.toBeNull());
    const key = host.querySelector<HTMLTextAreaElement>('[aria-label="Your GitHub key"]')!;
    expect(key.matches("textarea.secret-value-masked.ph-no-capture")).toBe(true);
    await act(async () => {
      setFieldValue(host.querySelector<HTMLInputElement>('input[placeholder="123456"]')!, "123456");
      setFieldValue(host.querySelector<HTMLInputElement>('input[placeholder="12345678"]')!, "12345678");
      setFieldValue(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="acme/backend, acme/frontend"]')!, "example/repository");
      setFieldValue(key, "line-1\nline-2\nline-3");
    });
    await act(async () => {
      Array.from(host.querySelectorAll("button")).find(button => button.textContent?.trim() === "Connect")!.click();
    });
    expect(toolsApi.connectApp).toHaveBeenCalledWith("company-1", expect.objectContaining({
      credentialValues: { "credentials.privateKey": "line-1\nline-2\nline-3" },
    }));
  });
});

describe("AppsConnect Antigravity routing and branding", () => {
  it.each(["google", "google-ai"])("redirects legacy source=%s links to source=antigravity while preserving query params", async (legacySource) => {
    mocks.searchParams = new URLSearchParams({ source: legacySource, reconnect: "conn-123" });
    renderAppsConnect();
    await vi.waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith(
        "/apps/connect?source=antigravity&reconnect=conn-123",
        { replace: true },
      );
    });
  });

  it("renders Connect Antigravity with the Antigravity logo and hosted sign-in prompt for source=antigravity", async () => {
    mocks.searchParams = new URLSearchParams({ source: "antigravity" });
    renderAppsConnect();

    await vi.waitFor(() => {
      expect(host.querySelector("h2")?.textContent).toBe("Connect Antigravity");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('input[aria-label="Antigravity redirect URL"]')).not.toBeNull();
    });
    expect(host.querySelector('img[src="/brands/apps/antigravity.svg"]')).not.toBeNull();
    expect(host.textContent).toContain("Sign in to Antigravity");
    expect(host.textContent).not.toContain("Connect Google");
  });
});
