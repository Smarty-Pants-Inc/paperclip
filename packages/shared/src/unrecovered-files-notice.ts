import { ISSUE_COMMENT_PRESENTATION_KINDS } from "./constants.js";

/** Shared by the recovery receipt producer and legacy comment consumers.
 * Keep wording here: changing the producer independently must fail its UI contract test.
 */
export const UNRECOVERED_FILES_NOTICE_PREFIX = "Paperclip could not recover the unsaved files from the previous run:";
export const UNRECOVERED_FILES_NOTICE_KIND = "unrecovered_files_notice";

/** Known presentation kinds keep their own rendering. Generic, absent and newer
 * kinds fall back to the producer's statement so version skew cannot hide it.
 */
export function matchesUnrecoveredFilesNotice(text: string, kind?: string | null): boolean {
  if (kind === UNRECOVERED_FILES_NOTICE_KIND) return true;
  if (kind != null && kind !== "system_notice" &&
    (ISSUE_COMMENT_PRESENTATION_KINDS as readonly string[]).includes(kind)) return false;
  return text.trimStart().startsWith(UNRECOVERED_FILES_NOTICE_PREFIX);
}
