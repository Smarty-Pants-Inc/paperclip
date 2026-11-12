/** TEMP: replaced by imports from ../index.js */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Origin } from "./bind-types.js";

export type ParkReady = { ready: boolean; reasons: string[] };
export type StoppedChildren = { settled: string[]; uncertain: string[] };
export interface SubagentSeam {
  announce(toolCallId: string, origin: Readonly<Origin>): boolean;
  registerParkReadyContributor(fn: (signal: AbortSignal) => ParkReady | Promise<ParkReady>): () => void;
  registerStopChildren(fn: (signal: AbortSignal) => StoppedChildren | Promise<StoppedChildren>): () => void;
}
// No authority is manufactured by the shim. Missing composition fails closed. Once the real
// extension exists, these three delegates become imports; only socketAnnounce remains local.
let seam: SubagentSeam | undefined;
export function installSubagentSeam(value: SubagentSeam): () => void {
  if (seam) throw new Error("Subagent seam is already installed.");
  seam = value;
  return () => { if (seam === value) seam = undefined; };
}
export function announce(toolCallId: string, origin: Readonly<Origin>): boolean {
  return seam?.announce(toolCallId, origin) === true;
}
export function registerParkReadyContributor(fn: (signal: AbortSignal) => ParkReady | Promise<ParkReady>): () => void {
  if (!seam) throw new Error("Subagent seam is not installed.");
  return seam.registerParkReadyContributor(fn);
}
export function registerStopChildren(fn: (signal: AbortSignal) => StoppedChildren | Promise<StoppedChildren>): () => void {
  if (!seam) throw new Error("Subagent seam is not installed.");
  return seam.registerStopChildren(fn);
}

/** One active request, not a background poller. The socket is inherited from the admitted
 * private runtime; no discovery, reconnect, fallback authority, or credential is introduced.
 * All missing/error/refused/timed-out acknowledgements deny the native tool call.
 */
export async function socketAnnounce(input: {
  sessionId: string;
  toolCallId: string;
  origin: Readonly<Origin>;
  socketPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<boolean> {
  const path = input.socketPath ?? process.env.PAPERCLIP_PI_BIND_SOCKET;
  if (!path || input.signal?.aborted || !input.sessionId || !input.toolCallId
      || !Number.isSafeInteger(input.origin.epoch) || input.origin.epoch < 0
      || !input.origin.runId || !input.origin.turnId) return false;
  const nonce = randomUUID();
  const request = { schema: 1, kind: "announce", nonce, sessionId: input.sessionId, toolCallId: input.toolCallId,
    origin: { epoch: input.origin.epoch, runId: input.origin.runId, turnId: input.origin.turnId } };
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ path });
    let done = false, buffer = "";
    const finish = (accepted: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(accepted && !input.signal?.aborted);
    };
    const abort = () => finish(false);
    // Safety net for an active socket request; normal completion is data/error/close/abort.
    const timer = setTimeout(abort, input.timeoutMs ?? 3000);
    input.signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (input.signal?.aborted) finish(false);
      else socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) { finish(false); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        finish(reply !== null && reply.ack === true
          && (reply.nonce === undefined || reply.nonce === nonce)
          && (reply.sessionId === undefined || reply.sessionId === input.sessionId)
          && (reply.schema === undefined || reply.schema === 1));
      } catch { finish(false); }
    });
    if (input.signal?.aborted) abort();
  });
}
