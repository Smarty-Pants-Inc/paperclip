/** TEMP: replaced by imports from ../index.js / pi-bind-protocol.ts.
 * Exact 07:23Z seam Origin: turnId is REQUIRED. No obsolete fd-3/Commit wire shapes.
 */
export interface Origin {
  readonly epoch: number;
  readonly runId: string;
  readonly turnId: string;
}
/** The host-announced outer subagent call is separate from every child's native call ID. */
export interface ParentOrigin extends Origin {
  readonly callId: string;
}
