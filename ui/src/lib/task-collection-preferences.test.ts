import { describe, expect, it } from "vitest";
import {
  loadTaskCollectionPreferences,
  saveTaskCollectionPreferences,
  taskCollectionPreferencesStorageKey,
} from "./task-collection-preferences";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

type ViewState = { sort: "updated" | "created"; filters: string[] };
type Column = "status" | "id" | "updated";

const defaults: ViewState = { sort: "updated", filters: [] };
const columns: Column[] = ["status", "id", "updated"];
const normalizeViewState = (value: unknown): ViewState => {
  const candidate = value as Partial<ViewState> | null;
  return {
    sort: candidate?.sort === "created" ? "created" : "updated",
    filters: Array.isArray(candidate?.filters)
      ? candidate.filters.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};
const normalizeColumns = (value: unknown): Column[] => Array.isArray(value)
  ? value.filter((entry): entry is Column => columns.includes(entry as Column))
  : columns;

describe("task collection preferences", () => {
  it.each(["current", "legacy"])("ignores the old hidden default but retains the saved %s view and new choices", (source) => {
    const storage = new MemoryStorage();
    const location = {
      companyId: "example-org", collectionKey: "tasks",
      legacyViewStorageKey: "legacy:view", legacyColumnsStorageKey: "legacy:columns",
    };
    const viewState = { showAgentCreatedTasks: false, sort: "created", groupBy: "priority", filters: ["active"] };
    const key = taskCollectionPreferencesStorageKey(location);
    if (source === "current") {
      storage.setItem(key, JSON.stringify({ version: 1, ...location, viewState, columns: ["id"] }));
    } else {
      storage.setItem("legacy:view", JSON.stringify(viewState));
      storage.setItem("legacy:columns", JSON.stringify(["id"]));
    }
    const options = {
      ...location, storage, defaultViewState: { ...viewState, showAgentCreatedTasks: true }, defaultColumns: columns,
      normalizeViewState: (value: unknown) => value as typeof viewState, normalizeColumns,
    };
    const loaded = loadTaskCollectionPreferences(options);
    expect(loaded.viewState).toMatchObject({ ...viewState, showAgentCreatedTasks: true });
    expect(loaded.columns).toEqual(["id"]);
    for (const shown of [false, true]) {
      saveTaskCollectionPreferences(location, {
        viewState: { ...loaded.viewState, showAgentCreatedTasks: shown }, columns: loaded.columns,
      }, storage);
      const reloaded = loadTaskCollectionPreferences(options);
      expect(reloaded.viewState).toMatchObject({ ...viewState, showAgentCreatedTasks: shown });
      expect(reloaded.columns).toEqual(["id"]);
      expect(JSON.parse(storage.getItem(key)!).viewState.hideAgentCreatedTasks).toBe(!shown);
    }
  });

  it("migrates legacy view and column keys into a versioned company scope", () => {
    const storage = new MemoryStorage();
    storage.setItem("legacy:view", JSON.stringify({ sort: "created", filters: ["active"] }));
    storage.setItem("legacy:columns", JSON.stringify(["status", "id"]));

    const loaded = loadTaskCollectionPreferences<ViewState, Column>({
      storage,
      companyId: "company-a",
      collectionKey: "tasks",
      legacyViewStorageKey: "legacy:view",
      legacyColumnsStorageKey: "legacy:columns",
      defaultViewState: defaults,
      defaultColumns: columns,
      normalizeViewState,
      normalizeColumns,
    });

    expect(loaded).toEqual({
      viewState: { sort: "created", filters: ["active"] },
      columns: ["status", "id"],
      migrated: true,
      source: "legacy",
    });
    const current = storage.getItem(taskCollectionPreferencesStorageKey({
      companyId: "company-a",
      collectionKey: "tasks",
    }));
    expect(JSON.parse(current ?? "{}")).toMatchObject({ version: 1, companyId: "company-a", collectionKey: "tasks" });
  });

  it("keeps preferences isolated between companies", () => {
    const storage = new MemoryStorage();
    saveTaskCollectionPreferences<ViewState, Column>(
      { companyId: "company-a", collectionKey: "tasks" },
      { viewState: { sort: "created", filters: [] }, columns: ["id"] },
      storage,
    );

    const companyB = loadTaskCollectionPreferences<ViewState, Column>({
      storage,
      companyId: "company-b",
      collectionKey: "tasks",
      defaultViewState: defaults,
      defaultColumns: columns,
      normalizeViewState,
      normalizeColumns,
    });
    expect(companyB.viewState).toEqual(defaults);
    expect(companyB.columns).toEqual(columns);
  });

  it("dual-writes legacy keys for compatibility", () => {
    const storage = new MemoryStorage();
    saveTaskCollectionPreferences<ViewState, Column>(
      {
        companyId: "company-a",
        collectionKey: "tasks",
        legacyViewStorageKey: "legacy:view",
        legacyColumnsStorageKey: "legacy:columns",
      },
      { viewState: { sort: "created", filters: ["active"] }, columns: ["status"] },
      storage,
    );

    expect(JSON.parse(storage.getItem("legacy:view") ?? "{}")).toEqual({ sort: "created", filters: ["active"] });
    expect(JSON.parse(storage.getItem("legacy:columns") ?? "[]")).toEqual(["status"]);
  });

  it("preserves a collection default when only legacy columns existed", () => {
    const storage = new MemoryStorage();
    storage.setItem("legacy:columns", JSON.stringify(["id"]));
    const options = {
      storage,
      companyId: "company-a",
      collectionKey: "tasks",
      legacyViewStorageKey: "legacy:view",
      legacyColumnsStorageKey: "legacy:columns",
      defaultViewState: defaults,
      defaultColumns: columns,
      normalizeViewState,
      normalizeColumns,
    } as const;

    const migrated = loadTaskCollectionPreferences<ViewState, Column>(options);
    const reloaded = loadTaskCollectionPreferences<ViewState, Column>(options);
    expect(migrated.source).toBe("default");
    expect(reloaded.source).toBe("default");
    expect(reloaded.columns).toEqual(["id"]);
  });
});
