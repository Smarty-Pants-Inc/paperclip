// TEMP: replace this import boundary with pi-bind-protocol.ts when code-lead lands it.
// No IPC implementation, prompt injection, or transaction authority lives in this lane.
// Only Origin is consumed here; the remaining names describe the agreed caller boundary.
export interface BindRequest {
  schema: string; nonce: string; expectedPriorEpoch: number; newEpoch: number;
  sessionId: string; runId: string; grantVersion: number; completionRevision: number;
  instructionHash: string; instructionLength: number; toolRevision: number;
  model: string; effort: string; mcp: { register: unknown[]; unregister: string[] };
}
export interface BindReceipt { nonce: string; sessionId: string; epoch: number; digest: string }
export interface Commit { nonce: string; epoch: number }
export interface Committed { nonce: string; epoch: number }
export interface Origin { readonly epoch: number; readonly runId: string; readonly turnId: string }
