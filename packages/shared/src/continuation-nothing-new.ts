/** Server proof that a retained-session wake required no provider turn. */
export const CONTINUATION_NOTHING_NEW_SCHEMA = "paperclip.continuation-nothing-new.v1";

export type ContinuationNothingNew = {
  schema: typeof CONTINUATION_NOTHING_NEW_SCHEMA;
  namedCommentIds: string[];
  answeredCommentIds: string[];
  cause: "all_named_answered" | "own_reply_only" | "empty_system_wake";
};
