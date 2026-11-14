import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertRoutineOrigin, fail, only, record, type MailConfig } from "./config.js";
import { cutoff, failedDelivery, isId, MAX_FAILURES, parkedWarning, parseState, prune, timestamp } from "./state.js";

type Context = Pick<PluginContext, "http" | "secrets"> & {
  state: Pick<PluginContext["state"], "get" | "set">;
  logger: Pick<PluginContext["logger"], "warn">;
};
export const INCOMING_QUERY = "-in:sent -in:drafts -in:chats";
// Fully frozen build-time allowlist. Configuration cannot add a destination.
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "gmail.googleapis.com", "oauth2.googleapis.com", "hq.smartypants.ai",
]);
export function seenKey(companyId: string, mailbox: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "mail-intake",
    stateKey: `seen:${createHash("sha256").update(mailbox).digest("hex")}` };
}
/** Pending explicit initialize-seen request for the same company and mailbox. */
export function initKey(companyId: string, mailbox: string) {
  return { ...seenKey(companyId, mailbox), stateKey: `init:${createHash("sha256").update(mailbox).digest("hex")}` };
}
/**
 * Fixed number of metadata reads in flight. The request count is unchanged (one per
 * new ID, at most 100 pages x 500 IDs); only wall time shrinks, by up to this factor.
 * Gmail's per-user limit is 250 quota units/s and messages.get costs 5, so 8 in
 * flight stays far below it. The whole read stays bounded by the caller's signal.
 */
export const METADATA_CONCURRENCY = 8;
/** Every request, including refresh and delivery, passes this fail-closed boundary. */
export function safeHttp(ctx: Pick<Context, "http">, config: MailConfig, signal: AbortSignal) {
  const fireUrl = `${config.routineOrigin}/api/routine-triggers/public/${config.routinePublicId}/fire`;
  return async (url: string, init: RequestInit): Promise<Response> => {
    try {
      assertRoutineOrigin(config.routineOrigin); // Do not trust even a forged typed config.
      if (signal.aborted) fail();
      const u = new URL(url);
      if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !ALLOWED_HOSTS.includes(u.hostname)) fail();
      const allowed = (u.hostname === "gmail.googleapis.com" && init.method === "GET" &&
          /^\/gmail\/v1\/users\/[^/]+\/messages(?:\/[0-9a-f]{1,64})?$/.test(u.pathname)) ||
        (url === "https://oauth2.googleapis.com/token" && init.method === "POST") ||
        (url === fireUrl && init.method === "POST");
      if (!allowed) fail();
      const response = await ctx.http.fetch(url, { ...init, redirect: "error", signal });
      // SDK RPC omits signal/redirect; host returns redirects and bounds a call
      // to 30 seconds. Enforce our budget before AND after that host operation.
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
interface MailMessage { id: string; threadId: string; internalDate: number }
/** Shared bounded scanner for ticks and explicit initialize-seen. No state writes. */
export async function readMailbox(ctx: Pick<Context, "http" | "secrets">, companyId: string,
  config: MailConfig, http: ReturnType<typeof safeHttp>, skip = new Set<string>()): Promise<MailMessage[]> {
  const grantValue = await ctx.secrets.resolve(config.gmailGrantRef, { companyId, configPath: "gmailGrantRef" });
  const grant: unknown = JSON.parse(grantValue);
  if (!record(grant)) fail();
  only(grant, ["client_id", "client_secret", "refresh_token"]);
  if (![grant.client_id, grant.client_secret, grant.refresh_token].every(v => typeof v === "string" && v.length > 0)) fail();
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
    const query = new URLSearchParams({ q: `${INCOMING_QUERY} newer_than:${config.scanWindowDays}d`, maxResults: "500",
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
  const todo = all.filter(m => !skip.has(m.id));
  const messages: MailMessage[] = new Array(todo.length);
  let next = 0, failed = false;
  const readOne = async (m: { id: string; threadId: string }): Promise<MailMessage> => {
    const query = new URLSearchParams({ format: "metadata", fields: "id,threadId,internalDate" });
    const meta: unknown = await (await http(`${base}/${m.id}?${query}`, { method: "GET", headers })).json();
    if (!record(meta)) fail();
    only(meta, ["id", "threadId", "internalDate"]);
    if (meta.id !== m.id || meta.threadId !== m.threadId || typeof meta.internalDate !== "string" ||
        !/^\d{1,16}$/.test(meta.internalDate)) fail();
    const internalDate = Number(meta.internalDate);
    if (!timestamp(internalDate)) fail();
    return { ...m, internalDate };
  };
  // Bounded pool; the first failure stops new requests and fails the whole read.
  const lane = async () => {
    while (!failed && next < todo.length) {
      const i = next++;
      try { messages[i] = await readOne(todo[i]!); } catch (error) { failed = true; throw error; }
    }
  };
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(METADATA_CONCURRENCY, todo.length) }, lane));
  if (failed || lanes.some(l => l.status === "rejected")) fail();
  return messages;
}
// Plugin-state steps inside an enabled tick keep their own code (review-fleet-2
// F2 residual); everything else in the tick stays the caller's "mailbox read failed".
const STATE_CODES: readonly string[] = Object.freeze(["state read failed", "state invalid", "state write failed"]);
async function stateStep<T>(code: string, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch { fail(code); }
}
export async function runTick(ctx: Context, companyId: string, config: MailConfig): Promise<void> {
  if (!config.enabled) return;
  const write = (key: ReturnType<typeof seenKey>, value: unknown) =>
    stateStep("state write failed", () => ctx.state.set(key, value));
  try {
    const key = seenKey(companyId, config.mailbox);
    const raw = await stateStep("state read failed", () => ctx.state.get(key));
    const stored = await stateStep("state invalid", () => parseState(raw));
    const since = cutoff(config.scanWindowDays);
    const state = prune(stored, since);
    const skip = new Set([...state.seen.map(m => m.id), ...state.failures
      .filter(m => m.attempts >= MAX_FAILURES || m.nextRetryAt > Date.now()).map(m => m.id)]);
    const http = safeHttp(ctx, config, AbortSignal.timeout(240_000));
    // Finish ALL reads before any fire or pruning write. Backoff cannot block later IDs.
    const pending = (await readMailbox(ctx, companyId, config, http, skip)).filter(m => m.internalDate >= state.notBefore);
    if (stored.notBefore !== state.notBefore || stored.seen.length !== state.seen.length ||
        stored.failures.length !== state.failures.length) await write(key, state);
    if (pending.length) {
      const secret = await ctx.secrets.resolve(config.routineFireSecretRef, { companyId, configPath: "routineFireSecretRef" });
      if (!secret || /[\r\n]/.test(secret)) fail();
      for (const message of pending) {
        const idempotencyKey = `mail-intake:${createHash("sha256").update(JSON.stringify([companyId, config.mailbox, message.id])).digest("hex")}`;
        const prior = state.failures.find(m => m.id === message.id);
        let accepted = false;
        try {
          await http(`${config.routineOrigin}/api/routine-triggers/public/${config.routinePublicId}/fire`, {
            method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey, "X-Paperclip-Idempotency-Scope": "routine" },
            body: JSON.stringify({ messageId: message.id, threadId: message.threadId, receivedTime: new Date(message.internalDate).toISOString() }),
          });
          accepted = true;
        } catch { /* Per-message delivery failure only; never store provider text. */ }
        state.failures = state.failures.filter(m => m.id !== message.id);
        if (accepted) state.seen.push({ id: message.id, internalDate: message.internalDate });
        else state.failures.push(failedDelivery(message.id, message.internalDate, prior));
        // State failure is fatal, not a delivery failure. Commit each result before continuing.
        await write(key, state);
      }
    }
    const parked = state.failures.filter(m => m.attempts >= MAX_FAILURES);
    if (parked.length) ctx.logger.warn(parkedWarning(parked));
  } catch (error) {
    // Only a fixed state code passes through; no provider body, error cause, URL,
    // mail text, or secret escapes.
    const code = error instanceof Error ? error.message : "";
    fail(STATE_CODES.includes(code) ? code : undefined);
  }
}
