import { loopbackTokenMatches, type LoopbackRouteAdapter } from "./broker.js";

/** Chat-compatible gateways keep their configured API prefix, usually /v1. */
export const chatLoopbackAdapter: LoopbackRouteAdapter = {
  protocol: "chat",
  localPath: "/v1/chat/completions",
  upstreamUrl: baseUrl => new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`),
  authorize: (headers, token) => loopbackTokenMatches(headers.authorization, `Bearer ${token}`),
  upstreamHeaders: ({ key, auth }): Record<string, string> => auth !== "none" && key ? { Authorization: `Bearer ${key}` } : {},
  harnessBaseUrl: port => `http://127.0.0.1:${port}/v1`,
};
