import type { NativeRunTrace } from "./native-run-trace.js";

export interface NativeDiagnosticOwner {
  companyId: string;
  sessionScope: string;
  runId: string;
}

export interface NativeDiagnosticLease {
  retire(): void;
}

export type NativeIdleDiagnosticKind = "transport_close_requested" | "session_diagnostic";

type Sink = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

const IDLE_REASON_CODE = /^[a-z]+(?:_[a-z]+){1,12}$/;
const IDLE_REASON_SCAN_TOKENS = 64;

/**
 * The bounded code an idle diagnostic is logged under: its first
 * whitespace-separated token (trailing `:` `,` `;` `.` removed) shaped like a
 * code, else "other". Never message text, paths or stderr (#20825).
 */
export function nativeIdleDiagnosticReason(chunk: string): string {
  const tokens = chunk.slice(0, 4_096).split(/\s+/, IDLE_REASON_SCAN_TOKENS);
  for (const token of tokens) {
    const candidate = token.replace(/[:,;.]+$/, "");
    if (candidate.length <= 128 && IDLE_REASON_CODE.test(candidate)) return candidate;
  }
  return "other";
}
type Epoch = { owner: NativeDiagnosticOwner; sink?: Sink; trace?: NativeRunTrace };
const sessions = new WeakMap<object, NativeSessionDiagnostics>();

export class NativeSessionDiagnostics {
  private active: Epoch | undefined;
  private lastOwner: NativeDiagnosticOwner;

  constructor(
    private readonly scope: Pick<NativeDiagnosticOwner, "companyId" | "sessionScope">,
    initialOwner: NativeDiagnosticOwner,
    private readonly idle: (owner: NativeDiagnosticOwner, kind: NativeIdleDiagnosticKind, reason?: string) => void,
    private readonly failed: (owner: NativeDiagnosticOwner) => void,
    /** Also pass `idle` the bounded reason code (nativeIdleDiagnosticReason). */
    private readonly options: { idleReasonCode?: boolean } = {},
  ) {
    if (!initialOwner.runId || initialOwner.companyId !== scope.companyId || initialOwner.sessionScope !== scope.sessionScope)
      throw new Error("native_diagnostic_owner_scope_mismatch");
    this.lastOwner = { ...initialOwner };
  }

  activate(owner: NativeDiagnosticOwner, sink?: Sink, trace?: NativeRunTrace): NativeDiagnosticLease {
    if (!owner.runId || owner.companyId !== this.scope.companyId || owner.sessionScope !== this.scope.sessionScope)
      throw new Error("native_diagnostic_owner_scope_mismatch");
    if (this.active && (this.active.owner.runId !== owner.runId || this.active.sink !== sink || this.active.trace !== trace))
      throw new Error("native_diagnostic_owner_busy");
    const epoch: Epoch = this.active ?? { owner: { ...owner }, sink, trace };
    this.active = epoch;
    this.lastOwner = epoch.owner;
    return {
      retire: () => { if (this.active === epoch) this.active = undefined; },
    };
  }

  /** A retained route resolves the current run at each operation, never its creator. */
  get trace(): NativeRunTrace | undefined { return this.active?.trace; }

  bind(session: object): void {
    const existing = sessions.get(session);
    if (existing && existing !== this) throw new Error("native_diagnostic_session_already_bound");
    sessions.set(session, this);
  }

  private report(operation: () => void): void {
    try { operation(); }
    catch { process.emitWarning("Native session diagnostic reporting failed"); }
  }

  record(chunk: string, stream: "stdout" | "stderr" = "stderr"): void {
    const epoch = this.active;
    if (!epoch?.sink) {
      const kind = chunk.startsWith("[paperclip-runner] runnerd diagnostic: runner transport close requested:")
        ? "transport_close_requested" : "session_diagnostic";
      const owner = epoch?.owner ?? this.lastOwner;
      this.report(() => this.options.idleReasonCode
        ? this.idle(owner, kind, nativeIdleDiagnosticReason(chunk)) : this.idle(owner, kind));
      return;
    }
    try {
      void epoch.sink(stream, chunk).catch(() => this.report(() => this.failed(epoch.owner)));
    } catch {
      this.report(() => this.failed(epoch.owner));
    }
  }
}

export function nativeSessionDiagnostics(session: object): NativeSessionDiagnostics | undefined {
  return sessions.get(session);
}
