import { sql } from "drizzle-orm";
import { nativeHarnessBackups } from "@paperclipai/db";

/** Warm trace evidence is never proof of saved provider/controller state. */
export const NATIVE_SESSION_EVIDENCE_KIND = "paperclip.native-session-evidence.v1";
/** Shared by every SQL reader that makes a resumability/custody decision.
 * Legacy references without kind remain eligible for normal validation. */
export const resumableNativeHarnessBackupRow = sql`(${nativeHarnessBackups.reference}->>'kind') is distinct from ${NATIVE_SESSION_EVIDENCE_KIND}`;
