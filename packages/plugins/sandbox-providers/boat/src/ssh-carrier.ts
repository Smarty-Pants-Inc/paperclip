import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch } from "node:fs";
import { lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { OwnedSshAgent, stopLocalProcess, type AgentIdentity } from "./ssh-agent.js";
import { editGuestKey, IMAGE_PREFLIGHT, type KeyApi, type KeyRegistration } from "./ssh-keys.js";
import { BoatDuplexError } from "./ssh-errors.js";
import type { DuplexLease, DuplexCallbacks, DuplexSession } from "./duplex.js";
import { guardianCommand, guardianRunner } from "./guardian-contract.js";
import { guardianHealthCommand } from "./guardian-stage.js";

export type ApiSshEndpoint = { host: string; port: number; user: string; hostKey: string };
export function parseSshEndpoint(raw: any): ApiSshEndpoint {
  if (typeof raw?.hostKey !== "string" || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$/.test(raw.hostKey)) throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
  let host = raw.machineIp, port = 22;
  if (raw.sshEndpoint != null && raw.sshEndpoint !== "") {
    if (typeof raw.sshEndpoint !== "string") throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
    const match = /^([0-9.]+):(\d{1,5})$/.exec(raw.sshEndpoint);
    if (!match) throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
    host = match[1]; port = Number(match[2]);
  }
  const user = raw.sshUser ?? "user";
  if (typeof host !== "string" || !isIP(host) || port < 1 || port > 65535 || typeof user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
  return { host, port, user, hostKey: raw.hostKey };
}
export type SshEndpoint = { args: string[]; env: NodeJS.ProcessEnv; controlPath: string; knownHosts: string; master: ChildProcessWithoutNullStreams; masterPid?: number; dead: boolean; command: string[] };
export const SSH_RETIRE_ATTEMPTS = 3;
export type SshRetireWarning = { code: "BOAT_SSH_RETIRE_FAILED"; attempts: number };
type LeaseState = { lease: DuplexLease; key?: KeyRegistration; address?: ApiSshEndpoint; endpoint?: SshEndpoint; pending?: Promise<SshEndpoint>; retirement?: Promise<void>; retiring: boolean; retireFailure?: SshRetireWarning; retirePending?: KeyRegistration; refreshedAt: number };
const scope = (lease: DuplexLease) => createHash("sha256").update(JSON.stringify([lease.driverKey, lease.companyId, lease.environmentId, lease.providerLeaseId, lease.config.apiKey])).digest("hex");

/** One agent per worker and one explicitly owned SSH master per exact lease.
 * No guest relay, port, process record, or cross-worker replacement authority. */
export class BoatSshCarrier {
  private readonly agent = new OwnedSshAgent();
  private readonly states = new Map<string, LeaseState>();
  private closed = false;
  constructor(private readonly apiFor: (lease: DuplexLease) => KeyApi) {}
  async start(): Promise<void> { await this.agent.start(); }
  prepare(lease: DuplexLease): Promise<SshEndpoint> {
    if (this.closed) return Promise.reject(new BoatDuplexError("BOAT_SSH_CLOSED"));
    if (lease.config.duplexCarrier !== "ssh") return Promise.reject(new BoatDuplexError("BOAT_SSH_DISABLED"));
    if (!lease.guardianPreflight?.usable || !lease.runnerId) return Promise.reject(new BoatDuplexError("BOAT_SSH_PREFLIGHT_FAILED"));
    guardianCommand(lease.runnerId);
    const id = scope(lease);
    let state = this.states.get(id);
    if (!state) {
      if (this.states.size >= 128) return Promise.reject(new BoatDuplexError("BOAT_SSH_PREPARE_FAILED"));
      state = { lease: { ...lease, config: { ...lease.config } }, retiring: false, refreshedAt: 0 }; this.states.set(id, state);
    }
    if (state.lease.runnerId !== lease.runnerId) return Promise.reject(new BoatDuplexError("BOAT_SSH_RUNNER_MISMATCH"));
    if (state.retiring) return Promise.reject(new BoatDuplexError("BOAT_SSH_CLOSED"));
    if (state.retireFailure) return Promise.reject(new BoatDuplexError(state.retirePending ? "BOAT_SSH_RETIRE_PENDING" : "BOAT_SSH_CLOSED"));
    if (state.pending) return state.pending;
    const current = state;
    const pending = this.prepareState(current).catch(error => {
      if (error instanceof BoatDuplexError) throw error;
      throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
    }).finally(() => { if (current.pending === pending) current.pending = undefined; });
    current.pending = pending; return pending;
  }
  /** Authentication requires the actual Core-selected Runner for the forced key.
   * Acquire/resume has no Runner ID; never invent one to prewarm a wider grant. */
  async prewarm(lease: DuplexLease): Promise<void> {
    const id = scope(lease), state = this.states.get(id);
    if (state) {
      await state.retirement?.catch(() => {});
      await state.pending?.catch(() => {});
      if (state.retirePending) {
        await this.removePendingKey(state);
        // No old authorization remains. Core may select a new Runner on this
        // authorized acquire/resume, but no command can be granted yet.
        this.states.delete(id);
      }
    }
    if (lease.runnerId) await this.prepare(lease);
  }
  private async removePendingKey(state: LeaseState): Promise<void> {
    if (!state.retirePending) return;
    try {
      if (state.endpoint) { await stopMaster(state.endpoint); state.endpoint = undefined; }
      await editGuestKey(this.apiFor(state.lease), state.lease.providerLeaseId, state.retirePending, true, AbortSignal.timeout(5000));
    } catch {
      state.retireFailure = { code: "BOAT_SSH_RETIRE_FAILED", attempts: 1 };
      throw new BoatDuplexError("BOAT_SSH_RETIRE_PENDING");
    }
    state.key = undefined; state.address = undefined; state.refreshedAt = 0;
    state.retirePending = undefined; state.retireFailure = undefined;
  }
  private async prepareState(state: LeaseState): Promise<SshEndpoint> {
    await this.removePendingKey(state);
    const fresh = Date.now() - state.refreshedAt < 23 * 3600_000;
    if (state.endpoint && !state.endpoint.dead && fresh && await liveMaster(state.endpoint)) return state.endpoint;
    const identity = await this.agent.start();
    const api = this.apiFor(state.lease), sandbox = state.lease.providerLeaseId;
    if (state.endpoint) { await stopMaster(state.endpoint); state.endpoint = undefined; }
    // A dead/idle master reuses only the already-registered exact command and API pin.
    let refreshedPin = false;
    if (state.address && state.key && fresh) {
      if (this.closed || state.retiring) throw new BoatDuplexError("BOAT_SSH_CLOSED");
      try {
        state.endpoint = await startMaster(identity, sandbox, scope(state.lease).slice(0, 12), state.address, guardianCommand(state.lease.runnerId!));
        return state.endpoint;
      } catch (error) {
        if (!(error instanceof BoatDuplexError) || error.code !== "BOAT_SSH_HOST_KEY_MISMATCH") throw error;
        refreshedPin = true;
      }
    }
    const preflight = await api.run(IMAGE_PREFLIGHT, 10_000);
    if (preflight.exitCode !== 0 || preflight.timedOut) throw new BoatDuplexError("BOAT_SSH_PREFLIGHT_FAILED");
    state.key = { workerId: identity.workerId, publicKey: identity.publicKey, expiresAt: Date.now() + 24 * 3600_000, runnerId: state.lease.runnerId! };
    for (let attempt = 0; attempt < (refreshedPin ? 1 : 2); attempt++) {
      if (this.closed || state.retiring) throw new BoatDuplexError("BOAT_SSH_CLOSED");
      // API response is the sole host-key authority. Never ssh-keyscan or TOFU.
      const raw = await api.request(`/sandboxes/${encodeURIComponent(sandbox)}/sshkey`, { method: "POST", body: JSON.stringify({ key: `${identity.publicKey} paperclip-boat-carrier:${identity.workerId}:${state.key.expiresAt}` }) });
      // Restrict even if metadata validation subsequently fails, so a partial
      // registration never leaves our key as an unrestricted login.
      await editGuestKey(api, sandbox, state.key, false);
      const address = parseSshEndpoint(raw);
      if (this.closed || state.retiring) throw new BoatDuplexError("BOAT_SSH_CLOSED");
      try {
        state.endpoint = await startMaster(identity, sandbox, scope(state.lease).slice(0, 12), address, guardianCommand(state.lease.runnerId!));
        state.address = address; state.refreshedAt = Date.now();
        return state.endpoint;
      } catch (error) {
        if (!(error instanceof BoatDuplexError) || error.code !== "BOAT_SSH_HOST_KEY_MISMATCH" || refreshedPin || attempt === 1) throw error;
        // Exactly one API refresh for a proven host-key rejection. A timeout,
        // connection refusal, or ordinary session loss never accepts a key.
      }
    }
    throw new BoatDuplexError("BOAT_SSH_CONNECT_FAILED");
  }
  async invalidate(lease: DuplexLease): Promise<void> {
    const state = this.states.get(scope(lease));
    if (!state) return;
    await state.retirement?.catch(() => {});
    await state.pending?.catch(() => {});
    if (state.endpoint) { await stopMaster(state.endpoint); state.endpoint = undefined; }
    // Resume invalidates transport, but never discards pending guest cleanup.
    state.refreshedAt = 0; state.address = undefined; state.retireFailure = undefined;
  }
  async retire(lease: DuplexLease): Promise<void> {
    const id = scope(lease), state = this.states.get(id);
    if (!state) return;
    if (state.retirement) return state.retirement;
    state.retiring = true;
    const retiring = (async () => {
      await state.pending?.catch(() => {});
      for (let attempt = 1; attempt <= SSH_RETIRE_ATTEMPTS; attempt++) {
        try {
          if (state.endpoint) { await stopMaster(state.endpoint); state.endpoint = undefined; }
          const key = state.retirePending ?? state.key;
          if (key) await editGuestKey(this.apiFor(state.lease), state.lease.providerLeaseId, key, true, AbortSignal.timeout(5000));
          this.states.delete(id);
          return;
        } catch {
          // A skipped retirement is not revocation. Preserve the OLD marker/key
          // separately so acquire/resume must remove it before any new install.
          if (state.key && !state.retirePending) state.retirePending = { ...state.key };
          state.retireFailure = { code: "BOAT_SSH_RETIRE_FAILED", attempts: attempt };
        }
      }
      throw new BoatDuplexError("BOAT_SSH_RETIRE_FAILED");
    })().finally(() => {
      state.retiring = false;
      if (state.retirement === retiring) state.retirement = undefined;
    });
    state.retirement = retiring;
    return retiring;
  }
  hasState(lease: DuplexLease): boolean { return this.states.has(scope(lease)); }
  async waitForPending(lease: DuplexLease): Promise<void> { await this.states.get(scope(lease))?.pending?.catch(() => {}); }
  /** Called on a confirmed stopped allocation: keep guest key removal pending for resume,
   * but stop local transport without issuing direct commands or file writes to the box. */
  async deferRetireUntilResume(lease: DuplexLease): Promise<void> {
    const state = this.states.get(scope(lease));
    if (!state) return;
    await state.pending?.catch(() => {});
    if (state.endpoint) { await stopMaster(state.endpoint); state.endpoint = undefined; }
    const key = state.retirePending ?? state.key;
    if (key) state.retirePending = { ...key };
    state.key = undefined; state.address = undefined; state.refreshedAt = 0;
    state.retireFailure = undefined;
  }
  /** Only after provider destruction: no surviving guest authorization to retry. */
  forgetDestroyed(lease: DuplexLease): void { this.states.delete(scope(lease)); }
  async retireAll(companyId?: string): Promise<void> {
    const results = await Promise.allSettled([...this.states.values()].filter(s => !companyId || s.lease.companyId === companyId).map(s => this.retire(s.lease)));
    if (results.some(r => r.status === "rejected")) throw new BoatDuplexError("BOAT_SSH_RETIRE_FAILED");
  }
  async close(): Promise<void> {
    this.closed = true;
    let retired = false;
    try { await this.retireAll(); retired = true; }
    finally {
      // Destroy signing authority even if remote revocation fails. Keep the
      // public-only control paths until retirement succeeds, so exact cleanup
      // retry can still address an unconfirmed local multiplex master.
      await this.agent.close(retired);
    }
  }
  async health(lease: DuplexLease): Promise<void> {
    // S9 has no public status verb. Probe the resident owner's private status
    // socket, not a forged S9 frame or a new key before Core selects a Runner.
    const response = await this.apiFor(lease).run(guardianHealthCommand(), 10_000);
    let status: any; try { status = JSON.parse(response.stdout); } catch { throw new BoatDuplexError("BOAT_SSH_SESSION_LOST"); }
    if (response.exitCode !== 0 || response.timedOut || status?.ok !== true || !["empty", "running", "exited"].includes(status.result?.state)) throw new BoatDuplexError("BOAT_SSH_SESSION_LOST");
  }
}
async function startMaster(identity: AgentIdentity, sandbox: string, id: string, remote: ApiSshEndpoint, command: string[]): Promise<SshEndpoint> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sandbox)) throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
  const controlPath = join(identity.dir, `m-${id}`), knownHosts = join(identity.dir, `h-${id}`);
  if (Buffer.byteLength(controlPath) > 100) throw new BoatDuplexError("BOAT_SSH_PREPARE_FAILED");
  await rm(controlPath, { force: true });
  await writeFile(knownHosts, `${sandbox} ${remote.hostKey}\n`, { mode: 0o600 });
  const args = ["-F", "/dev/null", "-T", "-p", String(remote.port), "-l", remote.user,
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=${sandbox}`, "-o", "UpdateHostKeys=no",
    "-o", "VerifyHostKeyDNS=no", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
    "-o", "IdentitiesOnly=yes", "-i", identity.publicFile, "-o", `IdentityAgent=${identity.socket}`,
    "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", `ControlPath=${controlPath}`, remote.host];
  const env = { PATH: "/usr/bin:/bin", LANG: "C", SSH_AUTH_SOCK: identity.socket };
  // OpenSSH backgrounds a ControlPersist master after authentication even with
  // -N. Own it through its private control socket, and retire via -O exit. Never
  // confuse its launcher's successful exit with loss of the multiplex master.
  const child = spawn("ssh", ["-N", "-o", "ControlMaster=auto", "-o", "ControlPersist=60", ...args], { env, stdio: "pipe" });
  const endpoint: SshEndpoint = { args, env, controlPath, knownHosts, master: child, dead: false, command };
  child.once("close", code => { if (code !== 0) endpoint.dead = true; }); child.stdout.resume();
  let diagnostic = "";
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const watcher = watch(identity.dir, () => { void ready(); });
      const timer = setTimeout(() => finish(false), 12_000);
      const finish = (ok: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer); watcher.close(); child.off("error", failed); child.off("close", failed);
        if (ok) resolve(); else reject(new BoatDuplexError(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(diagnostic) ? "BOAT_SSH_HOST_KEY_MISMATCH" : "BOAT_SSH_CONNECT_FAILED"));
      };
      const failed = () => { if (child.exitCode === 0) void ready(); else finish(false); };
      const ready = async () => { try { if ((await lstat(controlPath)).isSocket()) finish(true); } catch {} };
      child.once("error", failed); child.once("close", failed); void ready();
    });
    const check = await masterControl(endpoint, "check");
    const pid = /pid=(\d+)/.exec(check.text)?.[1];
    if (endpoint.dead || check.code !== 0 || !pid) throw new BoatDuplexError("BOAT_SSH_CONNECT_FAILED");
    endpoint.masterPid = Number(pid);
    return endpoint;
  } catch (error) { await stopMaster(endpoint); throw error; }
}
async function masterControl(endpoint: SshEndpoint, op: "check" | "exit"): Promise<{ code: number | null; text: string }> {
  // Local Unix-socket command; never fall back to a network handshake.
  const child = spawn("ssh", ["-O", op, "-o", "ProxyCommand=/bin/false", ...endpoint.args], { env: endpoint.env, stdio: "pipe" });
  let text = "";
  child.stdout.on("data", bytes => { text = (text + bytes).slice(-1024); });
  child.stderr.on("data", bytes => { text = (text + bytes).slice(-1024); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const code = await new Promise<number | null>(resolve => {
      child.once("close", resolve);
      child.once("exit", (code, signal) => { if (signal) resolve(code); });
      child.once("error", () => resolve(null));
    });
    return { code, text };
  } finally { clearTimeout(timer); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
}
async function liveMaster(endpoint: SshEndpoint): Promise<boolean> {
  const check = await masterControl(endpoint, "check");
  if (check.code !== 0) return false;
  const pid = Number(/pid=(\d+)/.exec(check.text)?.[1]);
  // Never adopt or replace a different process at this worker's private path.
  if (!pid || (endpoint.masterPid !== undefined && pid !== endpoint.masterPid)) throw new BoatDuplexError("BOAT_SSH_RETIRE_FAILED");
  return true;
}
async function stopMaster(endpoint: SshEndpoint): Promise<void> {
  if (await liveMaster(endpoint)) {
    const result = await masterControl(endpoint, "exit");
    if (result.code !== 0 && await liveMaster(endpoint)) throw new BoatDuplexError("BOAT_SSH_RETIRE_FAILED");
  }
  // A refused check means there is no usable master at this exact private path.
  // SIGKILL does not unlink sockets. Remove that stale entry before one restart.
  await stopLocalProcess(endpoint.master);
  await rm(endpoint.controlPath, { force: true });
  await rm(endpoint.knownHosts, { force: true });
  endpoint.dead = true;
}
export async function connectSsh(endpoint: SshEndpoint, command: readonly string[], callbacks: DuplexCallbacks): Promise<DuplexSession> {
  guardianRunner(command);
  if (JSON.stringify(command) !== JSON.stringify(endpoint.command)) throw new BoatDuplexError("BOAT_SSH_RUNNER_MISMATCH");
  if (endpoint.dead) throw new BoatDuplexError("BOAT_SSH_SESSION_LOST");
  // ProxyCommand=false refuses a new TCP connection if the master disappeared.
  // It cannot silently bypass prepare/host-key refresh on this slave path.
  const child = spawn("ssh", ["-o", "ControlMaster=no", "-o", "ProxyCommand=/bin/false", ...endpoint.args, command.join(" ")], { env: endpoint.env, stdio: "pipe" });
  let ended = false, input = 0, output = 0, failed = false, replyLf = false, settled = false;
  const finish = (code: number | null, lost: boolean) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    callbacks.exit({ exitCode: code, transportClosed: lost });
    if (lost) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
  };
  // Process exit is the event path; the deadline also settles held-open pipes.
  const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); finish(null, true); }, 40_000);
  child.stderr.resume();
  child.stdin.on("error", () => { failed = true; });
  child.stdout.on("data", bytes => {
    if (settled) return;
    output += bytes.length;
    if (output > 16 * 1024) { failed = true; child.kill("SIGKILL"); return; }
    replyLf ||= bytes.includes(10); callbacks.data(bytes);
  });
  child.once("exit", (code, signal) => {
    if (failed || code === 255 || signal !== null) finish(code, true);
  });
  // Structured guardian errors still drain stdout before delivery.
  child.once("close", (code, signal) => finish(code, failed || code === 255 || signal !== null || !replyLf));
  child.once("error", () => { failed = true; finish(null, true); });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new BoatDuplexError("BOAT_SSH_CONNECT_FAILED"))); });
  return {
    async write(bytes) {
      if (ended || failed || child.exitCode !== null || child.signalCode !== null) throw new BoatDuplexError("BOAT_SSH_SESSION_LOST");
      input += bytes.length;
      if (input > 16 * 1024) throw new BoatDuplexError("BOAT_SSH_INPUT_LIMIT");
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(new BoatDuplexError("BOAT_SSH_SESSION_LOST")) : resolve()));
      if (bytes.includes(10)) { ended = true; child.stdin.end(); }
    },
    async close() { child.stdin.end(); await stopLocalProcess(child); },
  };
}
export async function sshRoundTrip(endpoint: SshEndpoint, request: Buffer): Promise<string> {
  let text = "", session: DuplexSession | undefined;
  let resolve!: (value: string) => void, reject!: (error: unknown) => void;
  const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // Attach a rejection handler before asynchronous write/connect can fail.
  void result.catch(() => {});
  try {
    session = await connectSsh(endpoint, endpoint.command, {
      data: bytes => { text += Buffer.from(bytes).toString("utf8"); },
      exit: status => status.transportClosed ? reject(new BoatDuplexError("BOAT_SSH_SESSION_LOST")) : resolve(text),
    });
    await session.write(request); return await result;
  } finally { await session?.close(); }
}
