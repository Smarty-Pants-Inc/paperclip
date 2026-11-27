// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "@/lib/router";
import { ApiError } from "@/api/client";
import { NewAgentSetup } from "./NewAgentSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  connectionModels: undefined as undefined | { models: { id: string; label: string }[]; isLoading: boolean; error: unknown; resolveModel: (id: string) => string },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { id: "company", issuePrefix: "PAP" } }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
vi.mock("../../hooks/useAgentAppearanceDraft", () => ({ useAgentAppearanceDraft: () => ({ appearance: {} }) }));
vi.mock("../AgentCharacter", () => ({ AgentCharacter: () => null }));
vi.mock("./AgentBasicsDialog", () => ({ AgentBasicsDialog: () => null, AdapterMark: () => null }));
vi.mock("../ai-connections/useConnectionModels", () => ({ useConnectionModels: () => state.connectionModels }));
vi.mock("@/api/adapters", () => ({ adaptersApi: { list: async () => [{ type: "paperclip_runner", loaded: true }] } }));
vi.mock("@/api/environments", () => ({ environmentsApi: { list: async () => [], capabilities: async () => ({}) } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: {
  get: async () => ({}), getExperimental: async () => ({ enableNativeRunner: true }), getGeneral: async () => ({}),
} }));
vi.mock("@/api/secrets", () => ({ secretsApi: { list: async () => [], listMyUserSecrets: async () => [] } }));
vi.mock("@/api/agents", () => ({ agentsApi: {
  list: async () => [], adapterModels: state.adapterModels,
  get: async () => ({ id: "saved", companyId: "company", name: "Researcher", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "provider/saved-model" }, runtimeConfig: {}, metadata: {}, pauseReason: "setup", status: "paused" }),
} }));
// Keep the actual setup query and error rendering. The picker boundary exposes
// model entry and catalog contents without unrelated configuration sections.
vi.mock("../AgentConfigForm", () => ({ ModelDropdown: ({ value, onChange, models }: { value: string; onChange: (id: string) => void; models: { id: string }[] }) => <>
  <input aria-label="Model ID" value={value} onChange={event => onChange(event.target.value)} />
  <output aria-label="Models">{models.map(model => model.id).join(",")}</output>
</> }));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;
afterEach(() => { act(() => root?.unmount()); host?.remove(); client?.clear(); state.connectionModels = undefined; vi.clearAllMocks(); });

async function configure() {
  state.adapterModels.mockRejectedValue(new ApiError("Unknown adapter type: pi_rpc", 422, {}));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<QueryClientProvider client={client!}><MemoryRouter initialEntries={["/agents/new?name=Researcher&adapterType=paperclip_runner&runnerProvider=pi_rpc&setupAgentId=saved"]}><NewAgentSetup /></MemoryRouter></QueryClientProvider>));
  await act(async () => {
    await vi.waitFor(() => expect(client!.isFetching()).toBe(0));
  });
  expect(host!.textContent).toContain("Configure your agent");
}

it("opens native Pi Configure with manual model entry and no adapter-catalog failure", async () => {
  await configure();
  expect(host!.textContent).not.toContain("Could not load models");
  expect(host!.querySelector<HTMLInputElement>('[aria-label="Model ID"]')?.value).toBe("provider/saved-model");
  expect(state.adapterModels).not.toHaveBeenCalled();
});

it("uses the routed Pi catalog and still reports a real connection-catalog failure", async () => {
  state.connectionModels = { models: [{ id: "gateway/selected-model", label: "Selected model" }], isLoading: false, error: null, resolveModel: id => id };
  await configure();
  expect(host!.querySelector('[aria-label="Models"]')?.textContent).toContain("gateway/selected-model");
  expect(host!.textContent).not.toContain("Could not load models");
  state.connectionModels.error = new Error("Connection unavailable");
  await act(async () => root!.render(<QueryClientProvider client={client!}><MemoryRouter initialEntries={["/agents/new?name=Researcher&adapterType=paperclip_runner&runnerProvider=pi_rpc&setupAgentId=saved"]}><NewAgentSetup /></MemoryRouter></QueryClientProvider>));
  expect(host!.textContent).toContain("Could not load models");
  expect(state.adapterModels).not.toHaveBeenCalled();
});
