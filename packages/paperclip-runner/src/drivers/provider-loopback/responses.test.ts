import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { responsesLoopbackAdapter } from "./responses.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// Keep these tests at the trust boundary: the child has only a session token,
// and its headers must never choose or override the reusable upstream key.
describe("responsesLoopbackAdapter", () => {
  const token = "session-scoped-capability";

  beforeEach(() => {
    vi.mocked(timingSafeEqual).mockClear();
  });

  it("selects the Responses route and the /v1 harness base", () => {
    expect(responsesLoopbackAdapter.protocol).toBe("responses");
    expect(responsesLoopbackAdapter.localPath).toBe("/v1/responses");
    expect(responsesLoopbackAdapter.harnessBaseUrl(43123)).toBe("http://127.0.0.1:43123/v1");
  });

  it.each([
    ["https://provider.example/v1", "https://provider.example/v1/responses"],
    ["https://provider.example/v1/", "https://provider.example/v1/responses"],
    ["https://provider.example/v1///", "https://provider.example/v1/responses"],
    ["http://127.0.0.1:8080/custom/v1", "http://127.0.0.1:8080/custom/v1/responses"],
  ])("appends /responses without losing the base path: %s", (base, expected) => {
    const url = responsesLoopbackAdapter.upstreamUrl(base);
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe(expected);
  });

  it("accepts the session Bearer token using a timing-safe byte comparison", () => {
    expect(responsesLoopbackAdapter.authorize({ authorization: `Bearer ${token}` }, token)).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledOnce();
    const [actual, expected] = vi.mocked(timingSafeEqual).mock.calls[0]!;
    expect(actual).toEqual(Buffer.from(`Bearer ${token}`, "utf8"));
    expect(actual).toEqual(expected);
  });

  it("rejects a same-length wrong token using the same timing-safe comparison", () => {
    const wrongToken = `${token.slice(0, -1)}X`;
    expect(responsesLoopbackAdapter.authorize({ authorization: `Bearer ${wrongToken}` }, token)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { "x-api-key": token },
    { authorization: token },
    { authorization: `Basic ${token}` },
    { authorization: `Bearer ${token}extra` },
    { authorization: `Bearer ${token.slice(1)}` },
    { authorization: `Bearer ${token}, Bearer ${token}` },
    { authorization: `Bearer ${token}\n` },
    { authorization: `Bearer ${token}`, "x-api-key": "ignored" },
  ])("requires exactly the Bearer capability for %j", (headers) => {
    const authorized = responsesLoopbackAdapter.authorize(headers, token);
    expect(authorized).toBe(headers.authorization === `Bearer ${token}`);
  });

  it("rejects unexpected array-valued authorization without throwing", () => {
    const headers = { authorization: [`Bearer ${token}`] } as unknown as IncomingHttpHeaders;
    expect(responsesLoopbackAdapter.authorize(headers, token)).toBe(false);
  });

  it("rejects different UTF-8 byte lengths without throwing", () => {
    expect(responsesLoopbackAdapter.authorize({ authorization: "Bearer éaaa" }, "aaaa")).toBe(false);
  });

  it("compares equal-byte-length non-ASCII tokens without accepting a mismatch", () => {
    expect(responsesLoopbackAdapter.authorize({ authorization: "Bearer éaa" }, "aaaa")).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledOnce();
  });

  it("does not authorize an empty session token", () => {
    expect(responsesLoopbackAdapter.authorize({ authorization: "Bearer " }, "")).toBe(false);
  });

  it.each(["bearer", "api_key"] as const)("uses upstream Bearer auth for %s without forwarding child headers", (auth) => {
    expect(responsesLoopbackAdapter.upstreamHeaders({
      key: "upstream-key", auth,
      incoming: {
        authorization: `Bearer ${token}`,
        "x-api-key": "child-key",
        cookie: "child-cookie",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "child-beta",
      },
    })).toEqual({ Authorization: "Bearer upstream-key" });
  });

  it("sends no upstream authorization for none, even with a key and child headers", () => {
    expect(responsesLoopbackAdapter.upstreamHeaders({
      key: "must-not-leak", auth: "none",
      incoming: { authorization: `Bearer ${token}`, "x-api-key": "must-not-leak-either" },
    })).toEqual({});
  });

  it("does not mutate incoming headers", () => {
    const incoming = Object.freeze({ authorization: `Bearer ${token}`, accept: "text/event-stream" });
    responsesLoopbackAdapter.authorize(incoming, token);
    responsesLoopbackAdapter.upstreamHeaders({ key: "upstream-key", auth: "bearer", incoming });
    expect(incoming).toEqual({ authorization: `Bearer ${token}`, accept: "text/event-stream" });
  });
});
