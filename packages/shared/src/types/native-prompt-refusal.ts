import type { DefectReportDestination } from "./instance.js";

export type NativePromptRefusalKind = "task_description" | "newest_message" | "unread_message" | "unread_messages" | "queued_input" | "human_response" | "protected_input" | "protected_inputs" | "command" | "unmeasured_composition" | "stale_copy";
export type NativePromptRefusalRemedy = "edit_task_description" | "edit_message" | "delete_own_message" | "new_followup_task" | "report_defect" | "check_versions";

/** Saved diagnostic evidence, not an instruction or a permission grant.
 * Readers retain unknown kind/measure labels without guessing their meaning.
 * command.bytes names the measure: whole serialized command, pre-seal upper
 * bound with reserves, or command-encoded prompt/envelope/handoff-note bytes.
 * protected_inputs uses raw protected_parts or encoded envelope_with_reserve.
 * stale_copy.bytes is raw UTF-8 evidence, not an over-budget measurement. */
export interface NativePromptRefusalCause {
  kind: NativePromptRefusalKind | (string & {});
  bytes: number;
  count?: number;
  measure?: "command" | "command_upper_bound" | "prompt" | "envelope" | "handoff_note" | "protected_parts" | "envelope_with_reserve" | (string & {});
  /** Missing on legacy saved causes: preserve absence across save/read cycles.
   * Unmarked [] is also text-only: v11 normalized a missing field to []. */
  remedies?: NativePromptRefusalRemedy[];
  /** 2 marks modern action provenance. New nonempty writes carry this marker;
   * readers must not upgrade ambiguous legacy empties to action-bearing rows. */
  remediesVersion?: number;
  /** Exactly the messages counted by a message-specific measure. Optional for
   * legacy causes. These IDs never grant access or permission: the page must
   * re-read the targets and check author, queued/editable and deleted state.
   * edit_message requires the reader's editable queued message;
   * delete_own_message requires the reader's nonqueued, nondeleted message. */
  commentIds?: string[];
}

/** report_defect resolves the current instance setting, never a public default.
 * null means hand the run link and task title to the instance admin. */
export type NativePromptRefusalPresentationRemedy = Exclude<NativePromptRefusalRemedy, "report_defect">
  | { kind: "report_defect"; destination: DefectReportDestination | null };

/** Server-owned routes matching the displayed text, not permission grants.
 * command description edits apply only when the description is the long part;
 * defect reporting applies when task inputs are already small. Follow-up tasks
 * stay short and link to saved context, never split the same oversized text. */
export interface NativePromptRefusalPresentationCause extends Omit<NativePromptRefusalCause, "remedies"> {
  remedies: NativePromptRefusalPresentationRemedy[];
}
