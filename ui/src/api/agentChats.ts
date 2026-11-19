import type { Issue } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";
/** Chat reads take a signal so a cancelled query releases its request, and `fresh`
 * so a read made after a write never joins an older in-flight GET. */
type ChatRead = Pick<RequestOptions, "signal" | "fresh">;
export const agentChatsApi = {
  list: (companyId: string, options?: { agentId: string; members: "all"; limit?: number; offset?: number }, read?: ChatRead) => {
    const query = options ? `?${new URLSearchParams({ agentId: options.agentId, members: options.members,
      limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) })}` : "";
    return api.get<Issue[]>(`/companies/${companyId}/chats${query}`, read);
  },
  get: (companyId: string, agentRef: string, read?: ChatRead) =>
    api.get<Issue | null>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      read,
    ),
  ensure: (companyId: string, agentRef: string) =>
    api.post<Issue>(
      `/companies/${companyId}/chats/${encodeURIComponent(agentRef)}`,
      {},
    ),
};
