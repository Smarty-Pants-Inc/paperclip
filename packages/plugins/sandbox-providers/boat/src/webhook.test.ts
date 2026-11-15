import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoatLifecycleReceiver, trackBoatSandbox, resetBoatLifecycleForTests, waitForBoatLifecycle } from "./webhook.js";

const secret = "whsec_test_must_never_be_logged";
const rawBody = JSON.stringify({ id: "evt_1", type: "sandbox.ready", createdAt: "2026-01-01T00:00:00.000Z", data: { sandbox: { id: "bx_23456789" }, state: "ready" } });
function input(body = rawBody, eventType = "sandbox.ready", delivery = "evt_1", timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac("sha256", secret).update(`${delivery}.${timestamp}.`).update(body).digest("hex");
  return { endpointKey: "boat-lifecycle", requestId: "req", rawBody: body, headers: {
    "x-ascii-event": eventType, "x-ascii-delivery": delivery, "x-ascii-timestamp": timestamp, "x-ascii-signature": `v1=${signature}`,
  } };
}
afterEach(() => resetBoatLifecycleForTests());

describe("Boat lifecycle webhook receiver", () => {
  it("accepts valid signed fixture and wakes a waiter", async () => {
    trackBoatSandbox("bx_23456789");
    const receiver = createBoatLifecycleReceiver(async () => secret);
    const waiter = waitForBoatLifecycle("bx_23456789", ["ready"], 1_000);
    await receiver(input());
    await expect(waiter).resolves.toMatchObject({ sandboxId: "bx_23456789", event: "ready" });
  });
  it.each(["tampered body", "bad signature", "stale timestamp"])("rejects %s without logging secret", async kind => {
    const logger = vi.fn();
    const receiver = createBoatLifecycleReceiver(async () => secret, { logger });
    const event = input(kind === "tampered body" ? rawBody : rawBody, "sandbox.ready", `delivery-${kind}`, kind === "stale timestamp" ? "1" : undefined);
    if (kind === "bad signature") event.headers["x-ascii-signature"] = "v1=" + "0".repeat(64);
    const altered = kind === "tampered body" ? { ...event, rawBody: rawBody + " " } : event;
    await expect(receiver(altered)).rejects.toThrow();
    expect(logger.mock.calls.flat().join(" ")).not.toContain(secret);
  });
  it("deduplicates the same delivery id", async () => {
    trackBoatSandbox("bx_23456789");
    const receiver = createBoatLifecycleReceiver(async () => secret);
    const first = waitForBoatLifecycle("bx_23456789", ["ready"], 50);
    await receiver(input()); await expect(first).resolves.toBeDefined();
    await receiver(input());
    await expect(waitForBoatLifecycle("bx_23456789", ["ready"], 10)).rejects.toThrow(/timed out/i);
  });
  it("does not resurrect an archived sandbox from an older ready event", async () => {
    trackBoatSandbox("bx_23456789");
    const receiver = createBoatLifecycleReceiver(async () => secret);
    const archive = { id: "evt_2", type: "sandbox.archived", createdAt: "2026-01-01T00:00:02.000Z", data: { sandbox: { id: "bx_23456789" }, state: "archived" } };
    const ready = { ...archive, id: "evt_1", type: "sandbox.ready", createdAt: "2026-01-01T00:00:01.000Z", data: { sandbox: { id: "bx_23456789" }, state: "ready" } };
    await receiver(input(JSON.stringify(archive), "sandbox.archived", "delivery-2"));
    await receiver(input(JSON.stringify(ready), "sandbox.ready", "delivery-1"));
    await expect(waitForBoatLifecycle("bx_23456789", ["ready"], 10)).rejects.toThrow(/timed out/i);
  });
  it("rejects unknown lifecycle event types", async () => {
    const receiver = createBoatLifecycleReceiver(async () => secret);
    const body = JSON.stringify({ id: "evt_x", type: "sandbox.unknown", createdAt: "2026-01-01T00:00:00Z", data: { sandbox: { id: "bx_23456789" } } });
    await expect(receiver(input(body, "sandbox.unknown", "unknown-event"))).rejects.toThrow(/unknown/i);
  });
  it("ignores unknown sandbox ids", async () => {
    const receiver = createBoatLifecycleReceiver(async () => secret);
    await expect(receiver(input(JSON.stringify({ id: "evt_1", type: "sandbox.ready", createdAt: "2026-01-01T00:00:00Z", data: { sandbox: { id: "bx_23456789" }, state: "ready" } })))).resolves.toBeUndefined();
  });
  it("does not leak signing secret in any log line", async () => {
    const logger = vi.fn(); const receiver = createBoatLifecycleReceiver(async () => secret, { logger });
    await expect(receiver(input("bad json", "sandbox.ready", "bad"))).rejects.toThrow();
    expect(logger.mock.calls.flat().join(" ")).not.toContain(secret);
  });
});
