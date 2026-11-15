import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";

export type BoatLifecycleKind = "ready" | "hydrated" | "archived" | "error";
export interface BoatLifecycleWake { sandboxId: string; event: BoatLifecycleKind; eventId: string; createdAt: string }
const EVENT_KIND: Record<string, BoatLifecycleKind> = {
  "sandbox.ready": "ready", "sandbox.hydrated": "hydrated", "sandbox.archived": "archived", "sandbox.error": "error",
  "sandbox.degraded": "error", "sandbox.recovered": "ready",
};
const knownSandboxes = new Set<string>();
const lastObserved = new Map<string, number>();
const waiters = new Map<string, Set<{ events: Set<BoatLifecycleKind>; resolve: (value: BoatLifecycleWake) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>();
const deliveries = new Map<string, number>();
const DELIVERY_LIMIT = 4096;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_SECONDS = 300;

export function trackBoatSandbox(id: string): void { if (id) knownSandboxes.add(id); }
export function untrackBoatSandbox(id: string): void { knownSandboxes.delete(id); }
export function waitForBoatLifecycle(sandboxId: string, events: BoatLifecycleKind[], timeoutMs = 120_000): Promise<BoatLifecycleWake> {
  return new Promise((resolve, reject) => {
    const row = { events: new Set(events), resolve, reject, timer: setTimeout(() => {
      const listeners = waiters.get(sandboxId); listeners?.delete(row); if (!listeners?.size) waiters.delete(sandboxId);
      reject(new Error("Boat lifecycle wait timed out"));
    }, timeoutMs) };
    const listeners = waiters.get(sandboxId) ?? new Set(); listeners.add(row); waiters.set(sandboxId, listeners);
  });
}
function wake(sandboxId: string, event: BoatLifecycleKind, eventId: string, createdAt: string): void {
  const listeners = waiters.get(sandboxId); if (!listeners) return;
  const value = { sandboxId, event, eventId, createdAt };
  for (const listener of listeners) if (listener.events.has(event)) {
    clearTimeout(listener.timer); listeners.delete(listener); listener.resolve(value);
  }
  if (!listeners.size) waiters.delete(sandboxId);
}
function getHeader(headers: Record<string, string | string[]>, wanted: string): string {
  const key = Object.keys(headers).find(name => name.toLowerCase() === wanted);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
function reject(message: string): never { throw new Error(`Boat webhook rejected: ${message}`); }
export function createBoatLifecycleReceiver(resolveSigningSecret: () => Promise<string>, options: { logger?: (message: string, details?: Record<string, unknown>) => void; now?: () => number } = {}) {
  return async function onBoatWebhook(input: PluginWebhookInput): Promise<void> {
    const headers = input.headers ?? {};
    const delivery = getHeader(headers, "x-ascii-delivery");
    const timestamp = getHeader(headers, "x-ascii-timestamp");
    const supplied = getHeader(headers, "x-ascii-signature");
    const headerEvent = getHeader(headers, "x-ascii-event");
    const issuedAt = Number(timestamp);
    if (!delivery || !timestamp || !Number.isFinite(issuedAt) || Math.abs((options.now?.() ?? Date.now()) / 1000 - issuedAt) > MAX_AGE_SECONDS) {
      options.logger?.("Boat webhook rejected", { reason: "invalid_or_stale_timestamp" }); reject("invalid or stale timestamp");
    }
    if (!/^v1=[a-f0-9]{64}$/i.test(supplied)) { options.logger?.("Boat webhook rejected", { reason: "invalid_signature" }); reject("invalid signature"); }
    let secret: string;
    try { secret = await resolveSigningSecret(); } catch { options.logger?.("Boat webhook rejected", { reason: "secret_unavailable" }); reject("secret unavailable"); }
    const expected = createHmac("sha256", secret!).update(`${delivery}.${timestamp}.`).update(input.rawBody, "utf8").digest();
    const received = Buffer.from(supplied.slice(3), "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      options.logger?.("Boat webhook rejected", { reason: "invalid_signature" }); reject("invalid signature");
    }
    let payload: any;
    try { payload = JSON.parse(input.rawBody); } catch { options.logger?.("Boat webhook rejected", { reason: "invalid_json" }); reject("invalid JSON"); }
    if (!EVENT_KIND[headerEvent] || payload?.type !== headerEvent) {
      options.logger?.("Boat webhook rejected", { reason: "unknown_or_mismatched_event" }); reject("unknown or mismatched event");
    }
    const sandboxId = payload?.data?.sandbox?.id;
    if (typeof sandboxId !== "string" || !sandboxId || !knownSandboxes.has(sandboxId)) {
      options.logger?.("Boat webhook ignored", { reason: "unknown_sandbox" }); return;
    }
    const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : "";
    const eventTime = Date.parse(createdAt);
    if (!Number.isFinite(eventTime)) { options.logger?.("Boat webhook rejected", { reason: "invalid_event_time" }); reject("invalid event time"); }
    const now = options.now?.() ?? Date.now();
    for (const [id, expires] of deliveries) if (expires <= now) deliveries.delete(id);
    if (deliveries.has(delivery)) { deliveries.delete(delivery); deliveries.set(delivery, now + DELIVERY_TTL_MS); return; }
    deliveries.set(delivery, now + DELIVERY_TTL_MS);
    while (deliveries.size > DELIVERY_LIMIT) deliveries.delete(deliveries.keys().next().value!);
    if (eventTime <= (lastObserved.get(sandboxId) ?? Number.NEGATIVE_INFINITY)) return;
    lastObserved.set(sandboxId, eventTime);
    wake(sandboxId, EVENT_KIND[headerEvent], String(payload.id ?? delivery), createdAt);
  };
}
export function resetBoatLifecycleForTests(): void {
  knownSandboxes.clear(); lastObserved.clear(); deliveries.clear();
  for (const listeners of waiters.values()) for (const listener of listeners) { clearTimeout(listener.timer); listener.reject(new Error("reset")); }
  waiters.clear();
}

/** Code-only helper. Boat returns the signing secret exactly once; callers must store it as a Paperclip secret. */
export async function registerBoatLifecycleWebhook(input: { apiKey: string; url: string; name?: string; fetcher?: typeof fetch }): Promise<{ webhookId: string; signingSecret: string }> {
  if (!input.apiKey || !input.url.startsWith("https://")) throw new Error("Boat webhook registration requires an API key and HTTPS URL.");
  const response = await (input.fetcher ?? fetch)("https://boat.dev/api/v1/webhooks", {
    method: "POST", redirect: "error", headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.name ?? "Paperclip Boat lifecycle", url: input.url,
      events: Object.keys(EVENT_KIND) }),
  });
  if (!response.ok) throw new Error(`Boat webhook registration failed (${response.status}).`);
  const result = await response.json() as any;
  const webhookId = result?.webhook?.id, signingSecret = result?.secret;
  if (typeof webhookId !== "string" || typeof signingSecret !== "string") throw new Error("Boat webhook registration response omitted required fields.");
  return { webhookId, signingSecret };
}
