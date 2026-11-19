import { createContext, useContext } from "react";

/**
 * A send the server definitely refused stays in the thread as one 'Not sent'
 * bubble. The page that owns the send supplies Retry (same clientRequestId)
 * and Edit (the words move to the composer and the bubble goes).
 */
export interface TaskChatFailedSendActions {
  retry: (clientId: string) => void;
  edit: (clientId: string) => void;
  /** The words Edit moved, taken by the composer once per key. */
  restoreText: { key: string; body: string } | null;
}

export const TaskChatFailedSendContext = createContext<TaskChatFailedSendActions | null>(null);

export function useTaskChatFailedSend() {
  return useContext(TaskChatFailedSendContext);
}
