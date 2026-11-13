import { createHash, randomUUID } from "node:crypto";
import { decodeChannelBytes } from "@paperclipai/plugin-sdk/protocol";
import type { PluginDuplexChannelOpenParams, PluginDuplexChannelOpenResult, PluginDuplexChannelWriteParams,
  PluginDuplexChannelStopParams, PluginDuplexChannelCloseParams, PluginDuplexChannelCloseResult } from "@paperclipai/plugin-sdk/protocol";

import { GUARDIAN_COMMAND, guardianRunner } from "./guardian-contract.js";
import { BoatDuplexError } from "./ssh-errors.js";
import type { SshEndpoint } from "./ssh-carrier.js";
export { GUARDIAN_COMMAND, BoatDuplexError };
export const DUPLEX_MAX_BYTES = 16 * 1024;
export type DuplexLease = { driverKey: string; companyId: string; environmentId: string; providerLeaseId: string; config: Record<string, unknown>; guardianPreflight?: { usable: true }; runnerId?: string };
export type DuplexSession = { write(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
export type DuplexCallbacks = { data(bytes: Uint8Array): void; exit(result: { exitCode: number | null; transportClosed?: boolean }): void };
type Dependencies = {
  prepare(lease: DuplexLease): Promise<SshEndpoint>;
  connect(endpoint: SshEndpoint, command: readonly string[], callbacks: DuplexCallbacks): Promise<DuplexSession>;
  notify: { data(route: string, session: string, bytes: Uint8Array): void; exit(route: string, session: string, code: number | null, transportClosed?: boolean): void };
  activity<T>(lease: DuplexLease, run: () => Promise<T>): Promise<T>;
};
type Lease = DuplexLease & { active: boolean; admissionError?: BoatDuplexError };
type Entry = { hostRouteId: string; workerSessionId?: string; lease?: Lease; cancelled: boolean; exited: boolean;
  session?: DuplexSession; opening?: Promise<void>; closing?: Promise<void>; closed: boolean; written: number; output: number };
const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sameScope = (a: DuplexLease, b: Omit<DuplexLease, "config">) => a.driverKey === b.driverKey && a.companyId === b.companyId
  && a.environmentId === b.environmentId && a.providerLeaseId === b.providerLeaseId;
const account = (lease: DuplexLease) => createHash("sha256").update(String(lease.config.apiKey ?? "")).digest("hex");
export function assertGuardianCommand(command: readonly string[]): void {
  try { guardianRunner(command); } catch { throw new BoatDuplexError("BOAT_SSH_COMMAND_REFUSED"); }
}

/** Worker-local authority only. Acquire/resume is the sole way to bind a lease.
 * Reserve routes before any await. Keep bounded tombstones rather than allowing
 * a delayed open to resurrect a route that Core already closed. */
export class BoatDuplexChannels {
  private readonly leases = new Map<string, Lease>();
  private readonly routes = new Map<string, Entry>();
  private shuttingDown = false;
  constructor(private readonly deps: Dependencies) {}
  bind(lease: DuplexLease): void {
    // Sandbox Core sends its fully qualified provider key here, not necessarily
    // the manifest-local "boat" key. Preserve it exactly through every hook.
    if (this.shuttingDown || typeof lease.driverKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(lease.driverKey)
      || ![lease.companyId, lease.environmentId, lease.providerLeaseId].every(safeId)
      || typeof lease.config.apiKey !== "string" || !lease.config.apiKey) throw new Error("Boat duplex lease scope is invalid.");
    const previous = this.leases.get(lease.providerLeaseId);
    if (previous && (!sameScope(previous, lease) || account(previous) !== account(lease))) throw new Error("Boat duplex lease scope cannot be replaced.");
    if (!previous && this.leases.size >= 128) throw new Error("Boat duplex lease limit reached.");
    if (previous) { previous.config = { ...lease.config }; previous.guardianPreflight = lease.guardianPreflight; previous.runnerId = undefined; previous.active = true; previous.admissionError = undefined; }
    else this.leases.set(lease.providerLeaseId, { ...lease, config: { ...lease.config }, active: true });
  }
  private reserve(hostRouteId: string): Entry {
    if (!safeId(hostRouteId)) throw new Error("Boat duplex route is invalid.");
    if (this.routes.has(hostRouteId)) throw new Error("Boat duplex route has already been used or closed.");
    if (this.routes.size >= 4096) {
      // FIFO tombstones keep recent delayed-open fences without a lifetime cap.
      // Never evict a pending open, an unconfirmed close, or a live channel.
      for (const [id, entry] of this.routes) {
        if (entry.closed && !entry.closing) { this.routes.delete(id); break; }
      }
      if (this.routes.size >= 4096) throw new BoatDuplexError("BOAT_SSH_ROUTE_LIMIT");
    }
    const entry: Entry = { hostRouteId, cancelled: false, exited: false, closed: false, written: 0, output: 0 };
    this.routes.set(hostRouteId, entry); return entry;
  }
  async open(params: PluginDuplexChannelOpenParams): Promise<PluginDuplexChannelOpenResult> {
    if (this.shuttingDown) throw new Error("Boat duplex worker is shutting down.");
    const lease = this.leases.get(params.providerLeaseId);
    if (!lease || !sameScope(lease, params)) throw new BoatDuplexError("BOAT_SSH_LEASE_UNBOUND");
    if (!lease.active) throw lease.admissionError ?? new BoatDuplexError("BOAT_SSH_LEASE_UNBOUND");
    if (lease.config.duplexCarrier !== "ssh") throw new BoatDuplexError("BOAT_SSH_DISABLED");
    if (!lease.guardianPreflight?.usable) throw new BoatDuplexError("BOAT_SSH_PREFLIGHT_FAILED");
    assertGuardianCommand(params.command);
    const runnerId = guardianRunner(params.command);
    if (lease.runnerId && lease.runnerId !== runnerId) throw new BoatDuplexError("BOAT_SSH_RUNNER_MISMATCH");
    lease.runnerId = runnerId;
    if ([...this.routes.values()].filter(entry => entry.lease && !entry.closed && !entry.exited).length >= 32) throw new Error("Boat duplex live channel limit reached.");
    const entry = this.reserve(params.hostRouteId);
    entry.lease = lease;
    entry.workerSessionId = `duplex-${randomUUID()}`;
    const active = () => {
      if (entry.cancelled || !lease.active || this.shuttingDown) throw new Error("Boat duplex open was closed or its lease is inactive.");
    };
    entry.opening = this.deps.activity(lease, async () => {
      active();
      const endpoint = await this.deps.prepare(lease); active();
      const callbacks: DuplexCallbacks = {
        data: bytes => {
          if (entry.cancelled || entry.exited) return;
          entry.output += bytes.byteLength;
          if (entry.output > DUPLEX_MAX_BYTES) { void this.close({ hostRouteId: entry.hostRouteId }).catch(() => {}); return; }
          this.deps.notify.data(entry.hostRouteId, entry.workerSessionId!, bytes);
        },
        exit: result => {
          if (entry.exited) return;
          entry.exited = true;
          this.deps.notify.exit(entry.hostRouteId, entry.workerSessionId!, result.exitCode, result.transportClosed);
        },
      };
      entry.session = await this.deps.connect(endpoint, params.command, callbacks);
      active();
    });
    try { await entry.opening; return { hostRouteId: entry.hostRouteId, workerSessionId: entry.workerSessionId }; }
    catch (error) {
      entry.cancelled = true;
      // entry.opening is the settled setup promise, not this outer open call.
      // Retain an unconfirmed session for the host's exact route close retry.
      await this.close({ hostRouteId: entry.hostRouteId }).catch(() => {});
      // Preserve only our closed set of body-free typed transport failures.
      if (error instanceof BoatDuplexError) throw error;
      throw new Error("Boat duplex open failed or was closed.");
    }
  }
  private pair(params: PluginDuplexChannelStopParams): Entry {
    const entry = this.routes.get(params.hostRouteId);
    if (!entry?.session || entry.cancelled || entry.exited || !entry.lease?.active || entry.workerSessionId !== params.workerSessionId) throw new Error("Boat duplex route pair is not live.");
    return entry;
  }
  async write(params: PluginDuplexChannelWriteParams): Promise<void> {
    const entry = this.pair(params);
    if (typeof params.data !== "string" || params.data.length > Math.ceil(DUPLEX_MAX_BYTES / 3) * 4) throw new Error("Boat duplex bytes exceed the limit.");
    const bytes = decodeChannelBytes(params.data);
    if (bytes === null || bytes.byteLength > DUPLEX_MAX_BYTES || entry.written + bytes.byteLength > DUPLEX_MAX_BYTES) throw new Error("Boat duplex bytes are invalid or exceed the limit.");
    entry.written += bytes.byteLength;
    await this.deps.activity(entry.lease!, async () => {
      this.pair(params);
      try { await entry.session!.write(bytes); } catch (error) {
        if (error instanceof BoatDuplexError) throw error;
        throw new BoatDuplexError("BOAT_SSH_SESSION_LOST");
      }
    });
  }
  async stop(params: PluginDuplexChannelStopParams): Promise<void> { this.pair(params); await this.close(params); }
  async close(params: PluginDuplexChannelCloseParams): Promise<PluginDuplexChannelCloseResult> {
    const entry = this.routes.get(params.hostRouteId) ?? this.reserve(params.hostRouteId);
    entry.cancelled = true;
    if (!entry.closed && !entry.closing) {
      entry.closing = (async () => {
        await entry.opening?.catch(() => {});
        if (entry.session) await entry.session.close();
        entry.session = undefined;
        entry.closed = true;
      })();
    }
    const closing = entry.closing;
    try { await closing; }
    catch { throw new Error("Boat duplex close is unconfirmed; retry the exact route."); }
    finally { if (entry.closing === closing) entry.closing = undefined; }
    return { hostRouteId: entry.hostRouteId, ...(entry.workerSessionId ? { workerSessionId: entry.workerSessionId } : {}) };
  }
  async suspend(scope: Omit<DuplexLease, "config"> & { config?: Record<string, unknown> }, admissionError?: BoatDuplexError): Promise<void> {
    const lease = this.leases.get(scope.providerLeaseId);
    if (!lease) return;
    if (!sameScope(lease, scope) || (scope.config && account({ ...scope, config: scope.config }) !== account(lease))) throw new Error("Boat duplex lease scope does not match teardown.");
    lease.active = false; lease.admissionError = admissionError;
    const results = await Promise.allSettled([...this.routes.values()].filter(entry => entry.lease === lease && !entry.closed).map(entry => this.close({ hostRouteId: entry.hostRouteId })));
    if (results.some(result => result.status === "rejected")) throw new Error("Boat duplex lease clients did not close; retry teardown.");
  }
  forgetDestroyed(scope: DuplexLease): void {
    const lease = this.leases.get(scope.providerLeaseId);
    if (!lease) return;
    if (!sameScope(lease, scope) || account(lease) !== account(scope) || lease.active
      || [...this.routes.values()].some(entry => entry.lease === lease && !entry.closed)) throw new Error("Boat duplex destroyed lease is not settled.");
    for (const entry of this.routes.values()) if (entry.lease === lease) entry.lease = undefined;
    this.leases.delete(scope.providerLeaseId);
  }
  isActive(scope: DuplexLease): boolean {
    const lease = this.leases.get(scope.providerLeaseId);
    return !!lease?.active && sameScope(lease, scope) && account(lease) === account(scope);
  }
  activeLeases(): DuplexLease[] { return [...this.leases.values()].filter(lease => lease.active); }
  async suspendAll(companyId?: string): Promise<void> {
    const results = await Promise.allSettled([...this.leases.values()].filter(lease => !companyId || lease.companyId === companyId).map(lease => this.suspend(lease)));
    if (results.some(result => result.status === "rejected")) throw new Error("Boat duplex clients did not close.");
  }
  present(): boolean { return [...this.routes.values()].some(entry => !entry.closed && !entry.exited); }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const results = await Promise.allSettled([...this.leases.values()].map(lease => this.suspend(lease)));
    if (results.some(result => result.status === "rejected")) throw new Error("Boat duplex shutdown is unconfirmed.");
    this.leases.clear(); this.routes.clear();
  }
}
