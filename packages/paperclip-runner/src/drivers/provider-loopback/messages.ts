import { loopbackTokenMatches, type LoopbackRouteAdapter } from "./broker.js";

/** Messages clients append /v1/messages to the provider's host-root base URL. */
export const messagesLoopbackAdapter: LoopbackRouteAdapter = {
  protocol: "messages",
  localPath: "/v1/messages",
  upstreamUrl: baseUrl => new URL(`${baseUrl.replace(/\/+$/, "")}/v1/messages`),
  authorize: (headers, token) => {
    const apiKey = loopbackTokenMatches(headers["x-api-key"], token);
    const bearer = loopbackTokenMatches(headers.authorization, `Bearer ${token}`);
    return apiKey || bearer;
  },
  upstreamHeaders: ({ key, auth, incoming }) => {
    const headers: Record<string, string> = {};
    if (key && auth === "bearer") headers.Authorization = `Bearer ${key}`;
    if (key && auth === "api_key") headers["x-api-key"] = key;
    for (const name of ["anthropic-version", "anthropic-beta"]) {
      const value = incoming[name];
      if (typeof value === "string") headers[name] = value;
    }
    return headers;
  },
  harnessBaseUrl: port => `http://127.0.0.1:${port}`,
};
