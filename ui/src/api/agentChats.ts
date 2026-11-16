import type { Issue } from "@paperclipai/shared";
import { api } from "./client";
export const agentChatsApi = {
  list: (companyId: string, options?: { agentId: string; members: "all"; limit?: number; offset?: number }) => {
    const query = options ? `?${new URLSearchParams({ agentId: options.agentId, members: options.members,
      limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) })}` : "";
    return api.get<Issue[]>(`/companies/${companyId}/chats${query}`);
  },
  get: (companyId: string, agentRef: string) =>
    api.get<Issue | null>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
    ),
  ensure: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      {},
    ),
};
