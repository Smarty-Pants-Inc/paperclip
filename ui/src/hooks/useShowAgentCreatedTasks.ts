import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { resolveAgentCreatedTasksDefault } from "../lib/issue-filters";
import { taskCollectionPreferencesStorageKey, TASK_COLLECTION_PREFERENCES_CHANGED, TASK_COLLECTION_PREFERENCES_VERSION } from "../lib/task-collection-preferences";

type CollectionViewFlag = "showAgentCreatedTasks" | "showHiddenTasks";

/**
 * The instance default for Show agent-created tasks (General setting
 * `taskListsShowAgentCreatedByDefault`). Off until the settings load, which
 * is upstream's hidden default.
 */
export function useAgentCreatedTasksDefault(): boolean {
  const { data } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  return data?.taskListsShowAgentCreatedByDefault === true;
}

/** Subscribe the collection's fetching owner to its persisted filter control. */
export function useShowAgentCreatedTasks(companyId: string | null, collectionKey: string): boolean {
  const instanceDefault = useAgentCreatedTasksDefault();
  return useCollectionViewFlag(companyId, collectionKey, "showAgentCreatedTasks", instanceDefault);
}

/** Subscribe the collection's fetching owner to its persisted Show hidden tasks control. */
export function useShowHiddenTasks(companyId: string | null, collectionKey: string): boolean {
  return useCollectionViewFlag(companyId, collectionKey, "showHiddenTasks");
}

function useCollectionViewFlag(companyId: string | null, collectionKey: string, flag: CollectionViewFlag, instanceDefault = false): boolean {
  const getSnapshot = useCallback(() => {
    try {
      const key = taskCollectionPreferencesStorageKey({ companyId: companyId ?? "__unscoped__", collectionKey });
      const current = localStorage.getItem(key);
      const legacy = localStorage.getItem(companyId ? `${collectionKey}:${companyId}` : collectionKey);
      const envelope = current ? JSON.parse(current) : null;
      const valid = envelope?.version === TASK_COLLECTION_PREFERENCES_VERSION
        && envelope.companyId === (companyId ?? "__unscoped__") && envelope.collectionKey === collectionKey;
      const view = valid ? envelope.viewState : legacy ? JSON.parse(legacy) : null;
      if (flag === "showHiddenTasks") return view?.showHiddenTasks === true;
      // Only a recorded toggle is a choice; anything else uses the instance default.
      return resolveAgentCreatedTasksDefault({
        showAgentCreatedTasks: view?.showAgentCreatedTasks === true,
        showAgentCreatedTasksExplicit: view?.showAgentCreatedTasksExplicit === true,
      }, instanceDefault).showAgentCreatedTasks;
    } catch {
      return instanceDefault;
    }
  }, [companyId, collectionKey, flag, instanceDefault]);
  return useSyncExternalStore(subscribe, getSnapshot, () => instanceDefault);
}

function subscribe(onChange: () => void) {
  window.addEventListener(TASK_COLLECTION_PREFERENCES_CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TASK_COLLECTION_PREFERENCES_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}
