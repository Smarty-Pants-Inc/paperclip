import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import type { PluginWorkerManager } from '../services/plugin-worker-manager.js';
import { pluginConfigDelivery } from '../services/plugin-config-delivery.js';

// Data-safety/failure-path instrumentation only. Process/HTTP proof is separate.
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/plugin-registry.js', () => ({ pluginRegistryService: () => ({ getConfig: read }) }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const worker = { status: 'running' };
  const callbacks: Array<(id: string) => void> = [];
  const call = vi.fn().mockResolvedValue(undefined);
  const manager = { getWorker: () => worker, call, onWorkerReady: (cb: (id: string) => void) => { callbacks.push(cb); return () => {}; } } as unknown as PluginWorkerManager;
  read.mockReset().mockResolvedValue({ id: 'row', updatedAt: new Date(1), configJson: { enabled: true } });
  const delivery = pluginConfigDelivery({} as Db, manager);
  const ready = () => callbacks.forEach(cb => cb('p'));
  ready();
  return { delivery, call, ready };
}

describe('RFL coordinator failure and queue observations', () => {
  it('a failure is retried on the next explicit event, not by an infinite internal loop', async () => {
    const f = fixture();
    f.call.mockRejectedValueOnce(new Error('temporary unavailability'));
    await expect(f.delivery.deliver('p','c')).rejects.toThrow('temporary');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.delivery.current('p')!.delivered.size).toBe(0);
    await f.delivery.deliver('p','c');
    await f.delivery.deliver('p','c');
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.delivery.current('p')!.pending.size).toBe(0);
  });

  it('coalesces 1000 same-revision events into at most one pending delivery', async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockReturnValueOnce(gate.promise);
    const first = f.delivery.deliver('p','c');
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    let completed = 0;
    const burst = Array.from({ length: 1000 }, () => f.delivery.deliver('p','c').then(() => { completed++; }));
    await Promise.resolve();
    expect(completed).toBe(0);
    gate.resolve(); await Promise.all([first, ...burst]);
    console.log('RFL_QUEUE_SUCCESS', JSON.stringify({ enqueued: burst.length, reads: read.mock.calls.length, rpcCalls: f.call.mock.calls.length, completed }));
    // RFL 09:08Z ruling: one active read and at most one pending read.
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it('coalesces 64 failure events into at most two reads and RPC attempts', async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockImplementation(async () => { await gate.promise; throw new Error('unavailable'); });
    const results = Array.from({ length: 64 }, () => f.delivery.deliver('p','c').catch(() => undefined));
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    gate.resolve(); await Promise.all(results);
    console.log('RFL_QUEUE_FAILURE', JSON.stringify({ events: results.length, reads: read.mock.calls.length, rpcCalls: f.call.mock.calls.length }));
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.call.mock.calls.length).toBeLessThanOrEqual(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.call.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.delivery.current('p')!.pending.size).toBe(0);
  });

  it('new-generation delivery does not await a retired generation or inherit its applied revision', async () => {
    const f = fixture(); const gate = deferred();
    f.call.mockReturnValueOnce(gate.promise);
    const first = f.delivery.deliver('p','c');
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    const oldQueue = Array.from({ length: 100 }, () => f.delivery.deliver('p','c'));
    f.ready();
    await f.delivery.deliver('p','c');
    expect(f.call).toHaveBeenCalledTimes(2);
    gate.resolve(); await Promise.all([first, ...oldQueue]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.call).toHaveBeenCalledTimes(2);
  });
});
