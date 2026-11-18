import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import type { ReasoningDisplay, WorkspacePreference } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { workspacePreferencesApi } from "@/api/workspacePreferences";
import { queryKeys } from "@/lib/queryKeys";
import { useAccountBoundMutation } from "./useAccountBoundMutation";

let detachedClient: QueryClient | null = null;
const getDetachedClient = () => detachedClient ??= new QueryClient();
const NO_PREFERENCES: Readonly<Record<string, ReasoningDisplay>> = Object.freeze({});

/**
 * The signed-in person's reasoning display per agent. It is one server-side
 * personal preference (PUT /api/companies/:id/workspace-preferences/me,
 * `agentReasoningDisplay`), so it follows the person to every browser and
 * device. It is never part of the agent's configuration.
 */
function useReasoningPreferenceQuery() {
  const contextClient = useContext(QueryClientContext);
  const client = contextClient ?? getDetachedClient();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: contextClient != null,
  }, client);
  const sessionUserId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    enabled: contextClient != null && session.isSuccess && !sessionUserId,
  }, client);
  const userId = session.isSuccess
    ? sessionUserId ?? (health.isSuccess && health.data.deploymentMode === "local_trusted" ? "local-board" : null)
    : null;
  const preference = useQuery({
    queryKey: queryKeys.workspacePreferences.mine(userId),
    queryFn: () => workspacePreferencesApi.get(),
    enabled: contextClient != null && !!userId,
  }, client);
  const identityLoaded = !contextClient
    || (session.isFetched && (!!sessionUserId || session.isError || health.isFetched));
  const preferences = userId && preference.isSuccess && preference.data.userId === userId
    ? preference.data.agentReasoningDisplay ?? NO_PREFERENCES
    : NO_PREFERENCES;
  return {
    client,
    contextClient,
    userId,
    preferences,
    loaded: identityLoaded && (!userId || preference.isFetched),
    error: preference.error,
  };
}

/** Every agent's reasoning display the person chose; agents without an entry use their adapter default. */
export function useAgentReasoningDisplayPreferences(): Readonly<Record<string, ReasoningDisplay>> {
  return useReasoningPreferenceQuery().preferences;
}

/** The person's reasoning display for one agent, and a setter for the agent's page. */
export function useAgentReasoningDisplay(agentId: string) {
  const { client, contextClient, userId, preferences, loaded, error } = useReasoningPreferenceQuery();
  const mutation = useAccountBoundMutation({
    mutationFn: async ({ companyId, display, owner }: { companyId: string; display: ReasoningDisplay | null; owner: string }) => {
      const result = await workspacePreferencesApi.update(companyId, { agentReasoningDisplay: { agentId, display } });
      if (result.userId !== owner) throw new Error("Your account changed. Reload and try again.");
      return result;
    },
    onMutate: ({ display, owner }) => {
      // Show the choice at once; the server response (or a refetch on error) settles it.
      client.setQueryData<WorkspacePreference>(queryKeys.workspacePreferences.mine(owner), (current) => {
        if (!current || current.userId !== owner) return current;
        const next = { ...(current.agentReasoningDisplay ?? {}) };
        if (display) next[agentId] = display; else delete next[agentId];
        return { ...current, agentReasoningDisplay: next };
      });
    },
    onSuccess: (result) => {
      client.setQueryData(queryKeys.workspacePreferences.mine(result.userId), result);
    },
    onError: (_error, { owner }) => {
      void client.invalidateQueries({ queryKey: queryKeys.workspacePreferences.mine(owner) });
    },
  }, client);
  return {
    display: preferences[agentId] ?? null,
    loaded,
    error: error ?? (mutation.variables?.owner === userId ? mutation.error : null),
    isSaving: mutation.isPending && mutation.variables?.owner === userId,
    setDisplay: async (companyId: string, display: ReasoningDisplay | null) => {
      if (!contextClient || !userId) throw new Error("Sign in before changing how reasoning shows.");
      return mutation.mutateAsync({ companyId, display, owner: userId });
    },
  };
}
