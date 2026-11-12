/** TEMP: replaced by pi-bind-protocol.ts when code-lead supplies it; private fd-3 JSON lines.
 * This lane only consumes Origin. Unused shared revision/schema/registration values
 * remain opaque rather than guessing the forthcoming protocol's wire literals.
 */
export interface BindRequest {
  readonly schema: unknown; readonly nonce: string;
  readonly expectedPriorEpoch: number; readonly newEpoch: number;
  readonly sessionId: string; readonly runId: string;
  readonly grantVersion: unknown; readonly completionRevision: unknown;
  readonly instructionHash: string; readonly instructionLength: number;
  readonly toolRevision: unknown; readonly model: string; readonly effort: string;
  readonly mcp: { readonly register: readonly unknown[]; readonly unregister: readonly unknown[] };
}
export interface BindReceipt { readonly nonce: string; readonly sessionId: string; readonly epoch: number; readonly digest: string }
export interface Commit { readonly nonce: string; readonly epoch: number }
export interface Committed extends Commit {}
export interface Origin {
  readonly epoch: number;
  readonly runId: string;
  readonly turnId: string;
}
/** The host-announced outer subagent call is separate from every child's native call ID. */
export interface ParentOrigin extends Origin {
  readonly callId: string;
}
