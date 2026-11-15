// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";
import { useShowAgentCreatedTasks } from "./useShowAgentCreatedTasks";

const mockInstanceSettingsApi = vi.hoisted(() => ({ getGeneral: vi.fn() }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

const COMPANY = "company-1";
// The Tasks page and the project Tasks tab fetch through this hook.
const COLLECTIONS = ["paperclip:issues-view", "paperclip:project-issues-view"];

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockInstanceSettingsApi.getGeneral.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function writeV1Envelope(collectionKey: string, viewState: Record<string, unknown>) {
  localStorage.setItem(
    taskCollectionPreferencesStorageKey({ companyId: COMPANY, collectionKey }),
    JSON.stringify({ version: 1, companyId: COMPANY, collectionKey, viewState, viewStateSource: "stored", columns: ["id"] }),
  );
}

async function readPreference(collectionKey: string, settingOn: boolean): Promise<string> {
  const general = { censorUsernameInLogs: false, taskListsShowAgentCreatedByDefault: settingOn };
  mockInstanceSettingsApi.getGeneral.mockResolvedValue(general);
  queryClient.setQueryData(queryKeys.instance.generalSettings, general);
  function Probe() {
    return <span data-testid="value">{String(useShowAgentCreatedTasks(COMPANY, collectionKey))}</span>;
  }
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
  });
  return container.querySelector("[data-testid='value']")!.textContent!;
}

describe("useShowAgentCreatedTasks instance default", () => {
  it.each(COLLECTIONS)("shows agent-created tasks by default in %s when the setting is on", async (collectionKey) => {
    expect(await readPreference(collectionKey, true)).toBe("true");
  });

  it.each(COLLECTIONS)("keeps the upstream hidden default in %s when the setting is off", async (collectionKey) => {
    expect(await readPreference(collectionKey, false)).toBe("false");
  });

  it.each(COLLECTIONS)("does not let a stored v1 false stick in %s when the setting is on", async (collectionKey) => {
    writeV1Envelope(collectionKey, { showAgentCreatedTasks: false, boardCardDensity: "compact" });
    expect(await readPreference(collectionKey, true)).toBe("true");
  });

  it("does not let a legacy-key false stick when the setting is on", async () => {
    localStorage.setItem(`paperclip:issues-view:${COMPANY}`, JSON.stringify({ showAgentCreatedTasks: false }));
    expect(await readPreference("paperclip:issues-view", true)).toBe("true");
  });

  it.each(COLLECTIONS)("keeps an explicit choice in %s over the setting", async (collectionKey) => {
    writeV1Envelope(collectionKey, { showAgentCreatedTasks: false, showAgentCreatedTasksExplicit: true });
    expect(await readPreference(collectionKey, true)).toBe("false");
  });
});
