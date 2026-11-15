// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectivityProvider, createConnectivityStore } from "@/lib/connectivity";
import { pendingSendKeyFor, writePendingSend, type PendingSend } from "@/lib/pending-send";
import { DETACHED_DRAFT_OWNER } from "./useDraftOwner";
import { useBackgroundSubmitQueue } from "./useBackgroundSubmitQueue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Payload = { body: string; companyId?: string };
const isPayload = (value: unknown): value is Payload =>
  !!value && typeof value === "object" && typeof (value as Payload).body === "string";
const KEY = "test:background-send";
const stores: Array<ReturnType<typeof createConnectivityStore>> = [];
const roots = new Set<Root>();

beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  for (const store of stores) store.dispose();
  stores.length = 0;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mountTab(send: (payload: Payload, key: string) => Promise<string>, options: {
  companyId?: string;
  onAttention?: (record: PendingSend<Payload>, error: unknown) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.add(root);
  const store = createConnectivityStore({ browserOnline: true, probe: async () => ({ reachable: true, retryAfterMs: null }) });
  stores.push(store);
  let current!: ReturnType<typeof useBackgroundSubmitQueue<Payload, string>>;
  function Harness() {
    current = useBackgroundSubmitQueue({
      sourceId: `tab-${stores.indexOf(store)}`, storageKey: KEY, isPayload, send,
      canAutoResend: payload => !options.companyId || payload.companyId === options.companyId,
      onAttention: options.onAttention ?? (() => {}),
    });
    return null;
  }
  act(() => root.render(<ConnectivityProvider store={store}><Harness /></ConnectivityProvider>));
  return {
    get queue() { return current; },
    selectCompany(companyId: string) {
      options.companyId = companyId;
      act(() => root.render(<ConnectivityProvider store={store}><Harness /></ConnectivityProvider>));
    },
    unmount() { act(() => root.unmount()); roots.delete(root); },
  };
}

const queuedCreate = {
  payload: { body: "Task submitted in A", companyId: "company-a" },
  idempotencyKey: "original-create-key",
  createdAt: 1,
};
const queueStorageKey = pendingSendKeyFor(`${KEY}:queue`, DETACHED_DRAFT_OWNER);
const requestStorageKey = `${queueStorageKey}:request:${queuedCreate.idempotencyKey}`;
function seedQueuedCreate() {
  localStorage.setItem(requestStorageKey, JSON.stringify(queuedCreate));
}

it("holds a company A create in company B, raises attention, and sends explicitly with the original key", async () => {
  seedQueuedCreate();
  const send = vi.fn().mockResolvedValue("saved");
  const onAttention = vi.fn();
  let tab!: ReturnType<typeof mountTab>;
  await act(async () => { tab = mountTab(send, { companyId: "company-b", onAttention }); });
  expect(send).not.toHaveBeenCalled();
  expect(onAttention).toHaveBeenCalledExactlyOnceWith(queuedCreate, null);
  expect(JSON.parse(localStorage.getItem(requestStorageKey)!)).toEqual(queuedCreate);
  await act(async () => { await tab.queue.submit(queuedCreate.payload, { idempotencyKey: queuedCreate.idempotencyKey }); });
  expect(send).toHaveBeenCalledExactlyOnceWith(queuedCreate.payload, queuedCreate.idempotencyKey);
  expect(localStorage.getItem(requestStorageKey)).toBeNull();
});

it("discards a different-company create without sending, including after reload", async () => {
  seedQueuedCreate();
  const send = vi.fn().mockResolvedValue("saved");
  const onAttention = vi.fn();
  let tab!: ReturnType<typeof mountTab>;
  await act(async () => { tab = mountTab(send, { companyId: "company-b", onAttention }); });
  expect(send).not.toHaveBeenCalled();
  expect(onAttention).toHaveBeenCalledExactlyOnceWith(queuedCreate, null);
  await act(async () => { tab.queue.discard(queuedCreate.idempotencyKey); });
  expect(localStorage.getItem(requestStorageKey)).toBeNull();
  tab.unmount();
  await act(async () => { mountTab(send, { companyId: "company-a" }); });
  expect(send).not.toHaveBeenCalled();
});

it("still automatically resends a same-company create with its original key, regardless of age", async () => {
  seedQueuedCreate();
  const send = vi.fn().mockResolvedValue("saved");
  const onAttention = vi.fn();
  await act(async () => { mountTab(send, { companyId: "company-a", onAttention }); });
  expect(send).toHaveBeenCalledExactlyOnceWith(queuedCreate.payload, queuedCreate.idempotencyKey);
  expect(onAttention).not.toHaveBeenCalled();
  expect(localStorage.getItem(requestStorageKey)).toBeNull();
});

it("does not let a held create block later same-company queued creates", async () => {
  seedQueuedCreate();
  const send = vi.fn().mockResolvedValue("saved");
  const onAttention = vi.fn();
  let tab!: ReturnType<typeof mountTab>;
  await act(async () => { tab = mountTab(send, { companyId: "company-b", onAttention }); });
  const payload = { body: "Task submitted in B", companyId: "company-b" };
  await act(async () => { tab.queue.enqueue(payload, "company-b-create-key"); });
  expect(send).toHaveBeenCalledExactlyOnceWith(payload, "company-b-create-key");
  expect(onAttention).toHaveBeenCalledExactlyOnceWith(queuedCreate, null);
  expect(localStorage.getItem(requestStorageKey)).not.toBeNull();
  await act(async () => { tab.selectCompany("company-a"); });
  expect(send).toHaveBeenLastCalledWith(queuedCreate.payload, queuedCreate.idempotencyKey);
});

it("does not bypass company attention through a restored durable retry timer", async () => {
  vi.useFakeTimers();
  seedQueuedCreate();
  writePendingSend(pendingSendKeyFor(KEY, DETACHED_DRAFT_OWNER), queuedCreate);
  const send = vi.fn().mockResolvedValue("saved");
  const onAttention = vi.fn();
  let tab!: ReturnType<typeof mountTab>;
  await act(async () => { tab = mountTab(send, { companyId: "company-b", onAttention }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(send).not.toHaveBeenCalled();
  expect(onAttention).toHaveBeenCalledExactlyOnceWith(queuedCreate, null);
  await act(async () => { tab.queue.resendNow(); });
  expect(send).toHaveBeenCalledExactlyOnceWith(queuedCreate.payload, queuedCreate.idempotencyKey);
  expect(localStorage.getItem(requestStorageKey)).toBeNull();
});

it("stops automatic retries when the selected company changes after an offline create", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  const onAttention = vi.fn();
  const tab = mountTab(send, { companyId: "company-a", onAttention });
  await act(async () => { tab.queue.enqueue(queuedCreate.payload, queuedCreate.idempotencyKey); });
  expect(send).toHaveBeenCalledOnce();
  onAttention.mockClear();
  await act(async () => { tab.selectCompany("company-b"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(send).toHaveBeenCalledOnce();
  expect(onAttention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ idempotencyKey: queuedCreate.idempotencyKey }), null);
  expect(localStorage.getItem(requestStorageKey)).not.toBeNull();
});

it("retains another tab's queued tasks through submission, completion, and reload", async () => {
  const firstSend = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockImplementation(() => new Promise(() => {}));
  let finishOther!: (result: string) => void;
  const otherSend = vi.fn<(payload: Payload, key: string) => Promise<string>>()
    .mockImplementation(() => new Promise(resolve => { finishOther = resolve; }));
  const first = mountTab(firstSend);
  const other = mountTab(otherSend);
  await act(async () => {
    first.queue.enqueue({ body: "First slow save" }, "first-key");
    first.queue.enqueue({ body: "Second waiting task" }, "second-key");
  });
  expect(firstSend).toHaveBeenCalledOnce();
  await act(async () => { other.queue.enqueue({ body: "Other tab's task" }, "other-key"); });
  await act(async () => { finishOther("saved"); });
  first.unmount();
  other.unmount();

  const reloadedSend = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockResolvedValue("saved");
  await act(async () => { mountTab(reloadedSend); });
  expect(reloadedSend.mock.calls.map(([payload, key]) => [payload.body, key])).toEqual([
    ["First slow save", "first-key"], ["Second waiting task", "second-key"],
  ]);
});

it("migrates the previous queue format and restores rejected requests without sending them", async () => {
  const storageKey = pendingSendKeyFor(`${KEY}:queue`, DETACHED_DRAFT_OWNER);
  const rejection = { title: "Task failed", body: "Fix the saved request.", retryable: false };
  localStorage.setItem(storageKey, JSON.stringify([
    { payload: { body: "Legacy rejected task" }, idempotencyKey: "legacy-key", createdAt: 1, rejection },
  ]));
  const send = vi.fn<(payload: Payload, key: string) => Promise<string>>().mockResolvedValue("saved");
  const first = mountTab(send);
  expect(first.queue.rejected[0]).toMatchObject({ idempotencyKey: "legacy-key", rejection });
  expect(send).not.toHaveBeenCalled();
  first.unmount();
  const reloaded = mountTab(send);
  expect(reloaded.queue.rejected[0]).toMatchObject({ idempotencyKey: "legacy-key", rejection });
  await act(async () => { reloaded.queue.enqueue({ body: "Legacy rejected task" }, "legacy-key"); });
  expect(send).toHaveBeenCalledWith({ body: "Legacy rejected task" }, "legacy-key");
  reloaded.unmount();
  const afterReceipt = mountTab(send);
  expect(afterReceipt.queue.rejected).toEqual([]);
  expect(send).toHaveBeenCalledOnce();
});
