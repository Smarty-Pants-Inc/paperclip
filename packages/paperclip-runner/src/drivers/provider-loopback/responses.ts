import { timingSafeEqual } from "node:crypto";

import type { LoopbackRouteAdapter } from "./broker.js";

export const responsesLoopbackAdapter: LoopbackRouteAdapter = {
  protocol: "responses",
  localPath: "/v1/responses",
  upstreamUrl: (baseUrl) => new URL(`${baseUrl.replace(/\/+$/, "")}/responses`),
  authorize(headers, token) {
    if (!token || typeof headers.authorization !== "string") return false;
    const actual = Buffer.from(headers.authorization, "utf8");
    const expected = Buffer.from(`Bearer ${token}`, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
  upstreamHeaders: ({ key, auth }): Record<string, string> => auth === "none" ? {} : { Authorization: `Bearer ${key}` },
  harnessBaseUrl: (port) => `http://127.0.0.1:${port}/v1`,
};
