import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fail, only, record, type MailConfig } from "./config.js";

type Context = Pick<PluginContext, "http" | "secrets"> & {
  state: Pick<PluginContext["state"], "get" | "set">;
};
export const INCOMING_QUERY = "-in:sent -in:drafts -in:chats";
// The sole authoritative host list. Resolve the company-configured third entry per tick.
export const ALLOWED_HOSTS = (routineOrigin: string): readonly string[] => Object.freeze([
  "gmail.googleapis.com", "oauth2.googleapis.com", new URL(routineOrigin).hostname,
]);
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{1,64}$/.test(v);
export function seenKey(companyId: string, mailbox: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "mail-intake",
    stateKey: `seen:${createHash("sha256").update(mailbox).digest("hex")}` };
}
/** Every request, including refresh and delivery, passes this fail-closed boundary. */
export function safeHttp(ctx: Pick<Context, "http">, config: MailConfig, signal: AbortSignal) {
  const hosts = ALLOWED_HOSTS(config.routineOrigin);
  const fireUrl = `${config.routineOrigin}/api/routine-triggers/public/${config.routinePublicId}/fire`;
  return async (url: string, init: RequestInit): Promise<Response> => {
    try {
      if (signal.aborted) fail();
      const u = new URL(url);
      if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !hosts.includes(u.hostname)) fail();
      const allowed = (u.hostname === hosts[0] && init.method === "GET" &&
          /^\/gmail\/v1\/users\/[^/]+\/messages(?:\/[0-9a-f]{1,64})?$/.test(u.pathname)) ||
        (url === "https://oauth2.googleapis.com/token" && init.method === "POST") ||
        (url === fireUrl && init.method === "POST");
      if (!allowed) fail();
      const response = await ctx.http.fetch(url, { ...init, redirect: "error", signal });
      // SDK RPC currently omits RequestInit.signal/redirect. The host returns
      // redirects (never follows them) and bounds a request to 30 seconds.
      // Check our tick budget on BOTH sides of that awaited host operation.
      if (signal.aborted || !response.ok || response.redirected || (response.url && response.url !== url)) fail();
      return response;
    } catch { fail(); }
  };
}
function listPage(raw: unknown): { messages: { id: string; threadId: string }[]; next?: string } {
  if (!record(raw)) fail();
  only(raw, ["messages", "nextPageToken", "resultSizeEstimate"]);
  if (raw.resultSizeEstimate !== undefined &&
      !(typeof raw.resultSizeEstimate === "number" && Number.isSafeInteger(raw.resultSizeEstimate) && raw.resultSizeEstimate >= 0)) fail();
  if (raw.nextPageToken !== undefined &&
      !(typeof raw.nextPageToken === "string" && raw.nextPageToken.length > 0 && raw.nextPageToken.length <= 4096)) fail();
  const messages = raw.messages === undefined ? [] : raw.messages;
  if (!Array.isArray(messages) || messages.length > 500) fail();
  return { messages: messages.map(m => {
    if (!record(m)) fail();
    only(m, ["id", "threadId"]);
    if (!isId(m.id) || !isId(m.threadId)) fail();
    return { id: m.id, threadId: m.threadId };
  }), next: raw.nextPageToken as string | undefined };
}
export async function runTick(ctx: Context, companyId: string, config: MailConfig): Promise<void> {
  if (!config.enabled) return;
  try {
    const key = seenKey(companyId, config.mailbox);
    const stored = await ctx.state.get(key);
    // Missing/corrupt state never silently baselines or replays the mailbox.
    if (!Array.isArray(stored) || !stored.every(isId) || new Set(stored).size !== stored.length) fail();
    const seen = new Set<string>(stored);
    const grantValue = await ctx.secrets.resolve(config.gmailGrantRef, { companyId, configPath: "gmailGrantRef" });
    const grant: unknown = JSON.parse(grantValue);
    if (!record(grant)) fail();
    only(grant, ["client_id", "client_secret", "refresh_token"]);
    if (![grant.client_id, grant.client_secret, grant.refresh_token].every(v => typeof v === "string" && v.length > 0)) fail();
    const http = safeHttp(ctx, config, AbortSignal.timeout(240_000));
    const token: unknown = await (await http("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: grant.client_id as string,
        client_secret: grant.client_secret as string, refresh_token: grant.refresh_token as string }).toString(),
    })).json();
    if (!record(token) || typeof token.access_token !== "string" || !/^[\x21-\x7e]+$/.test(token.access_token) ||
        token.token_type !== "Bearer" || (token.scope !== undefined && token.scope !== "https://www.googleapis.com/auth/gmail.readonly")) fail();
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(config.mailbox)}/messages`;
    const all: { id: string; threadId: string }[] = [];
    const ids = new Set<string>(), pageTokens = new Set<string>();
    let pageToken: string | undefined;
    // Page/time bounds are failed reads, never partial success.
    for (let page = 0; ; page++) {
      if (page >= 100) fail();
      const query = new URLSearchParams({ q: INCOMING_QUERY, maxResults: "500",
        fields: "messages(id,threadId),nextPageToken,resultSizeEstimate" });
      if (pageToken) query.set("pageToken", pageToken);
      const result = listPage(await (await http(`${base}?${query}`, { method: "GET", headers })).json());
      for (const m of result.messages) {
        if (ids.has(m.id)) fail();
        ids.add(m.id); all.push(m);
      }
      if (!result.next) break;
      if (pageTokens.has(result.next)) fail();
      pageTokens.add(result.next); pageToken = result.next;
    }
    const pending: { messageId: string; threadId: string; receivedTime: string }[] = [];
    // Finish ALL reads before firing: a metadata failure also leaves seen untouched.
    for (const m of all) {
      if (seen.has(m.id)) continue;
      const query = new URLSearchParams({ format: "metadata", fields: "id,threadId,internalDate" });
      const meta: unknown = await (await http(`${base}/${m.id}?${query}`, { method: "GET", headers })).json();
      if (!record(meta)) fail();
      only(meta, ["id", "threadId", "internalDate"]);
      if (meta.id !== m.id || meta.threadId !== m.threadId || typeof meta.internalDate !== "string" ||
          !/^\d{1,16}$/.test(meta.internalDate)) fail();
      const milliseconds = Number(meta.internalDate);
      if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) fail();
      pending.push({ messageId: m.id, threadId: m.threadId, receivedTime: new Date(milliseconds).toISOString() });
    }
    if (pending.length === 0) return;
    const secret = await ctx.secrets.resolve(config.routineFireSecretRef, { companyId, configPath: "routineFireSecretRef" });
    if (!secret || /[\r\n]/.test(secret)) fail();
    for (const message of pending) {
      const idempotencyKey = `mail-intake:${createHash("sha256").update(JSON.stringify([companyId, config.mailbox, message.messageId])).digest("hex")}`;
      await http(`${config.routineOrigin}/api/routine-triggers/public/${config.routinePublicId}/fire`, {
        method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey, "X-Paperclip-Idempotency-Scope": "routine" },
        body: JSON.stringify(message),
      });
      seen.add(message.messageId);
      await ctx.state.set(key, [...seen]); // Commit each 2xx before attempting the next message.
    }
  } catch { fail(); } // No provider body, error cause, URL, mail text, or secret escapes.
}
