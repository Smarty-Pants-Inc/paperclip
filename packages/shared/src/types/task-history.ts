import type { IssueComment } from "./issue.js";

/** Existing comment fields stay backward compatible; native saved replies add their turn. */
export type TaskHistoryComment = Pick<IssueComment, "id" | "body" | "origin" | "sourceTrust" | "authorAgentId"
  | "authorUserId" | "createdAt" | "createdByRunId"> & { visibleTurn?: TaskHistoryVisibleTurn };

export interface TaskHistoryPage extends TaskHistoryPageInfo {
  comments: TaskHistoryComment[];
}

/** Display-safe native transcript alongside a saved agent reply; never raw tool payloads. */
export interface TaskHistoryVisibleTurn {
  runId: string;
  turnId: string | null;
  normalizedSessionId: string | null;
  fromSeq: number;
  throughSeq: number;
  text: string;
  rows: TaskHistoryVisibleRow[];
}

export type TaskHistoryVisibleRow = {
  seq: number;
  throughSeq: number;
  itemId: string | null;
} & ({
  type: "text";
  text: string;
} | {
  type: "tool" | "activity";
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  summary: string;
});

/** Comment pages are newest-first windows returned in chronological display order. */
export interface TaskHistoryPageInfo {
  limit: number;
  returnedCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}
