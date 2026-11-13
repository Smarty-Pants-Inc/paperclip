import { createHash } from "node:crypto";
import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { G12Config } from "./config.js";
import { GitHub, ScanPaused, signAppJwt } from "./github.js";
import { errorCode, G12Error, G12ErrorCode as Code } from "./errors.js";

type Host = Pick<PluginContext, "http" | "secrets" | "state" | "issues" | "logger">;
export interface Counts {
  repos: number; prs: number; eligible: number; drafts: number; unmapped: number;
  checks: number; missing: number; failing: number; wakes: number; deduped: number;
  refused: number; unresolved: number; errors: number;
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function stateKey(companyId: string, key: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, namespace: "g12-v1", stateKey: key };
}

// Persist only numeric positions/IDs, a config digest, the active head SHA, a
// review-presence bit and a retry timestamp. Never persist whole provider rows.
interface Cursor {
  fingerprint: string;
  repoIndex: number;
  pullPage: number;
  pullOffset: number;
  prNumber: number;
  headSha: string;
  checkPage: number;
  reviewFound: boolean;
  retryAt: number;
}
function freshCursor(fingerprint: string, retryAt = 0): Cursor {
  return { fingerprint, repoIndex: 0, pullPage: 1, pullOffset: 0, prNumber: 0,
    headSha: "", checkPage: 1, reviewFound: false, retryAt };
}
function resetChecks(cursor: Cursor) {
  cursor.prNumber = 0; cursor.headSha = ""; cursor.checkPage = 1; cursor.reviewFound = false;
}
function readCursor(value: unknown, fingerprint: string, repoCount: number): Cursor {
  if (value == null) return freshCursor(fingerprint);
  if (typeof value !== "object" || Array.isArray(value)) throw new G12Error(Code.ScanStateInvalid);
  const c = value as Cursor;
  const expected = Object.keys(freshCursor(fingerprint));
  if (Object.keys(c).length !== expected.length || Object.keys(c).some((key) => !expected.includes(key)) ||
      typeof c.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(c.fingerprint) ||
      ![c.repoIndex, c.pullPage, c.pullOffset, c.prNumber, c.checkPage, c.retryAt].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      c.pullPage < 1 || c.checkPage < 1 || c.pullOffset > 100 ||
      typeof c.headSha !== "string" || (c.headSha !== "" && !/^[a-fA-F0-9]{40,64}$/.test(c.headSha)) ||
      typeof c.reviewFound !== "boolean") throw new G12Error(Code.ScanStateInvalid);
  // Rebinding/reordering configuration cannot reuse another scan's positions,
  // but must not evade an already observed GitHub backoff.
  if (c.fingerprint !== fingerprint) return freshCursor(fingerprint, c.retryAt);
  if (c.repoIndex >= repoCount) throw new G12Error(Code.ScanStateInvalid);
  return { ...c };
}

const RECONCILE_AFTER_MS = 1_800_000;
const OWNER_INSTRUCTION = "Before acting, check GitHub for an existing review/comment or action at this PR head sha (or for this check run); if one exists, stop.";
interface WakeContext {
  repo: string;
  prNumber: number;
  headSha: string;
  checkRunId?: number;
  conclusion?: string;
}
const RETRY_BASE_MS = 300_000;
const RETRY_CAP_MS = 3_600_000;
interface AcceptedWake { acceptedAt: number; agentId: string; issueId: string }
interface PendingWake { pendingAt: number; reconcileAt: number; agentId: string; issueId: string; unresolvedAt?: number }
type Receipt = AcceptedWake | PendingWake;
interface Retry { attempts: number; retryAt: number }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function readReceipt(value: unknown): Receipt | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new G12Error(Code.WakeReceiptInvalid);
  const receipt = value as Receipt;
  const allowed = "acceptedAt" in receipt ? ["acceptedAt", "agentId", "issueId"] : ["pendingAt", "reconcileAt", "agentId", "issueId", "unresolvedAt"];
  if (Object.keys(receipt).some((key) => !allowed.includes(key)) ||
      typeof receipt.agentId !== "string" || !receipt.agentId || typeof receipt.issueId !== "string" || !receipt.issueId ||
      ("acceptedAt" in receipt ? !timestamp(receipt.acceptedAt) :
        !timestamp(receipt.pendingAt) || !timestamp(receipt.reconcileAt) || receipt.reconcileAt < receipt.pendingAt ||
        (receipt.unresolvedAt !== undefined && (!timestamp(receipt.unresolvedAt) || receipt.unresolvedAt < receipt.reconcileAt)))) {
    throw new G12Error(Code.WakeReceiptInvalid);
  }
  return receipt;
}
function readRetry(value: unknown): Retry | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new G12Error(Code.WakeRetryInvalid);
  const retry = value as Retry;
  if (Object.keys(retry).length !== 2 || Object.keys(retry).some((key) => !["attempts", "retryAt"].includes(key)) ||
      !Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 5 || !timestamp(retry.retryAt)) {
    throw new G12Error(Code.WakeRetryInvalid);
  }
  return retry;
}
function nextRetry(prior: Retry | null, now: number): Retry {
  const attempts = Math.min((prior?.attempts ?? 0) + 1, 5);
  return { attempts, retryAt: now + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS) };
}
// A refusal is reported after advancing the scan, not by pinning the cursor to
// the first refused PR. Other failures still stop the scan at its checkpoint.
class WakeRefusal extends G12Error {}

async function wake(host: Host, config: G12Config, owner: G12Config["owners"][string], key: string, context: WakeContext, now: number, counts: Counts, deadline: number) {
  if (Date.now() >= deadline) throw new ScanPaused();
  const receiptKey = stateKey(config.companyId, `wake:${hash(key)}`);
  const prior = readReceipt(await host.state.get(receiptKey));
  if (prior && ("acceptedAt" in prior || now < prior.reconcileAt)) {
    counts.deduped++;
    return;
  }
  // A stale pending receipt may have dispatched or crashed before dispatch.
  // Re-arm once on this observation: delivery is at-least-once; the owner must
  // check GitHub before acting. Legacy unresolved receipts recover here too.
  const retryKey = stateKey(config.companyId, `retry:${hash(key)}`);
  const retry = readRetry(await host.state.get(retryKey));
  if (retry && retry.retryAt > now) { counts.refused++; return; }
  async function refuse(code: Code, clearPending = false): Promise<never> {
    await host.state.set(retryKey, nextRetry(retry, now));
    // Throws and queued:false can both hide an admission. Retrying is safe only
    // under the owner effect contract. Persist backoff before clearing pending.
    if (clearPending) await host.state.set(receiptKey, null);
    counts.refused++;
    host.logger.warn("G12 wake refused", { code });
    throw new WakeRefusal(code);
  }
  let issue;
  try { issue = await host.issues.get(owner.issueId, config.companyId); }
  catch { return refuse(Code.IssueReadFailed); }
  // The issue path remains host-owned (budget, blockers, activity, admission).
  // Verify intended ownership immediately before requesting its wake. The SDK
  // has no atomic expected-assignee option; see INSTALL.md for that race limit.
  if (!issue || issue.id !== owner.issueId || issue.companyId !== config.companyId || issue.assigneeAgentId !== owner.agentId) {
    return refuse(Code.IssueAssigneeMismatch);
  }
  if (Date.now() >= deadline) throw new ScanPaused();
  // The host has no general g12:* replay fence or reliable admission receipt.
  // Persist a bounded reservation before dispatch, not an exactly-once claim.
  await host.state.set(receiptKey, { pendingAt: now, reconcileAt: now + RECONCILE_AFTER_MS, agentId: owner.agentId, issueId: owner.issueId });
  if (Date.now() >= deadline) throw new ScanPaused();
  let result;
  try {
    result = await host.issues.requestWakeup(owner.issueId, config.companyId, {
      reason: `${JSON.stringify({ dedupeKey: key, ...context })}\n${OWNER_INSTRUCTION}`,
      contextSource: "smarty.g12-backstop", idempotencyKey: key,
    });
  } catch {
    // Both pre-dispatch refusals and lost accepted responses are retryable.
    // Never inspect upstream error text/type or expose it in state/logs.
    return refuse(Code.WakeFailed, true);
  }
  if (result?.queued === false) return refuse(Code.WakeRefused, true);
  if (result?.queued !== true) return refuse(Code.WakeFailed, true);
  counts.wakes++;
  // Sent receipt (legacy acceptedAt shape). A failed write leaves pending,
  // which suppresses replay only until its bounded recovery deadline.
  await host.state.set(receiptKey, { acceptedAt: now, agentId: owner.agentId, issueId: owner.issueId });
}

export interface WakeReconciliation {
  pendingAt: number;
  agentId: string;
  issueId: string;
  outcome: "accepted" | "not-dispatched";
}
/**
 * Bounded, single-key ADMIN maintenance helper, not a worker tool or retry loop.
 * Caller MUST disable/drain the job and obtain positive host evidence first.
 * An empty history query or a timeout is NOT proof of not-dispatched. Unknown
 * outcomes need no operator action: pending automatically re-arms after its
 * bounded wait. No new host capability is required.
 */
export async function reconcileWake(state: Pick<Host["state"], "get" | "set">, companyId: string, key: string, proof: WakeReconciliation, now = Date.now()): Promise<void> {
  try {
    const receiptKey = stateKey(companyId, `wake:${hash(key)}`);
    const prior = readReceipt(await state.get(receiptKey));
    if (!prior || !("pendingAt" in prior) || prior.pendingAt !== proof.pendingAt ||
        prior.agentId !== proof.agentId || prior.issueId !== proof.issueId || !timestamp(now) || now < prior.pendingAt ||
        !["accepted", "not-dispatched"].includes(proof.outcome)) throw new G12Error(Code.WakeReconcileInvalid);
    if (proof.outcome === "accepted") {
      await state.set(receiptKey, { acceptedAt: now, agentId: prior.agentId, issueId: prior.issueId });
    } else {
      const retryKey = stateKey(companyId, `retry:${hash(key)}`);
      await state.set(retryKey, nextRetry(readRetry(await state.get(retryKey)), now));
      await state.set(receiptKey, null);
    }
  } catch (error) { throw new G12Error(errorCode(error, Code.WakeReconcileInvalid)); }
}

/** One serialized host job. No agents.invoke, sessions, routine or model work. */
export async function runTick(host: Host, config: G12Config, now = Date.now()): Promise<Counts> {
  const counts: Counts = { repos: 0, prs: 0, eligible: 0, drafts: 0, unmapped: 0, checks: 0,
    missing: 0, failing: 0, wakes: 0, deduped: 0, refused: 0, unresolved: 0, errors: 0 };
  if (!config.enabled) {
    host.logger.info("G12 tick counts", { ...counts });
    return counts;
  }
  const deadline = Date.now() + 240_000;
  const cursorKey = stateKey(config.companyId, "scan");
  const fingerprint = hash(JSON.stringify({ appId: config.appId, installationId: config.installationId,
    repos: config.repos, owners: config.owners, missingReviewMinutes: config.missingReviewMinutes }));
  let cursor: Cursor | undefined;
  let github: GitHub | undefined;
  let complete = false;
  let refusal: WakeRefusal | undefined;
  async function tryWake(owner: G12Config["owners"][string], key: string, context: WakeContext) {
    try { await wake(host, config, owner, key, context, now, counts, deadline); }
    catch (error) {
      if (!(error instanceof WakeRefusal)) throw error;
      refusal ??= error;
    }
  }
  try {
    if (!Array.isArray(config.repos) || config.repos.length === 0) throw new G12Error(Code.ConfigRepos);
    cursor = readCursor(await host.state.get(cursorKey), fingerprint, config.repos.length);
    if (cursor.retryAt > now) return counts; // No token, secret resolution or HTTP during backoff.
    cursor.retryAt = 0;
    github = new GitHub(host.http, deadline, config.maxGetsPerTick, now);
    const jwt = signAppJwt(config.appId, await host.secrets.resolve(config.privateKeyRef, {
      companyId: config.companyId, configPath: "privateKeyRef",
    }), now);
    const token = await github.installationToken(config, jwt);
    for (; cursor.repoIndex < config.repos.length; cursor.repoIndex++) {
      const repo = config.repos[cursor.repoIndex];
      counts.repos++;
      for (;;) {
        // Refresh the resumed PR page; don't persist PR payloads or wake using a
        // head captured in a previous tick without re-observing it on GitHub.
        const prs = await github.pullsPage(repo, token, cursor.pullPage);
        for (; cursor.pullOffset < prs.length; cursor.pullOffset++) {
          const pr = prs[cursor.pullOffset];
          counts.prs++;
          if (pr.draft) { counts.drafts++; resetChecks(cursor); continue; }
          const owner = pr.user ? config.owners[pr.user.login.toLowerCase()] : undefined;
          if (!owner) { counts.unmapped++; resetChecks(cursor); continue; }
          counts.eligible++;
          const head = pr.head.sha;
          if (cursor.prNumber !== pr.number || cursor.headSha !== head) {
            resetChecks(cursor); cursor.prNumber = pr.number; cursor.headSha = head;
          }
          const identity = `${pr.base.repo.id}:${pr.number}:${head}`;
          const seenKey = stateKey(config.companyId, `seen:${hash(`${config.appId}:${config.installationId}:${identity}`)}`);
          let firstSeen = await host.state.get(seenKey);
          if (firstSeen == null) { firstSeen = now; await host.state.set(seenKey, firstSeen); }
          if (typeof firstSeen !== "number" || !Number.isFinite(firstSeen) || firstSeen < 0) throw new G12Error(Code.FirstSeenInvalid);
          for (;;) {
            const page = await github.checksPage(repo, head, token, cursor.checkPage);
            const checks = page.filter((check) => check.head_sha === head);
            counts.checks += checks.length;
            cursor.reviewFound ||= checks.some((check) => check.name === "Paperclip Review" && check.app.id === config.appId);
            const keys = new Map<string, WakeContext>();
            for (const check of checks) {
              if (check.status !== "completed" || !["failure", "timed_out"].includes(check.conclusion ?? "")) continue;
              counts.failing++;
              keys.set(`g12:fail:${identity}:${check.app.id}:${check.id}:${check.conclusion}`, {
                repo, prNumber: pr.number, headSha: head, checkRunId: check.id, conclusion: check.conclusion!,
              });
            }
            for (const [key, context] of keys) await tryWake(owner, key, context);
            if (page.length < 100) break;
            cursor.checkPage++;
          }
          if (!cursor.reviewFound && now - firstSeen >= config.missingReviewMinutes * 60_000) {
            counts.missing++;
            await tryWake(owner, `g12:missing:${identity}`, { repo, prNumber: pr.number, headSha: head });
          }
          resetChecks(cursor);
        }
        cursor.pullOffset = 0;
        if (prs.length < 100) break;
        cursor.pullPage++;
      }
      cursor.pullPage = 1;
    }
    complete = true;
    if (refusal) throw refusal;
    return counts;
  } catch (error) {
    if (error instanceof ScanPaused && !refusal) return counts; // Never sleep; checkpoint and resume.
    counts.errors++;
    throw new G12Error(errorCode(error instanceof ScanPaused ? refusal : error, Code.TickFailed));
  } finally {
    try {
      if (cursor) {
        cursor.retryAt = Math.max(cursor.retryAt, github?.retryAt ?? 0);
        // After a full sweep, start a new one next tick. Preserve a rate-limit
        // deadline even if it arrived with the very last successful response.
        const saved = complete ? (cursor.retryAt > now ? freshCursor(fingerprint, cursor.retryAt) : null) : cursor;
        await host.state.set(cursorKey, saved);
      }
    } catch {
      counts.errors++;
      throw new G12Error(Code.TickFailed);
    } finally { host.logger.info("G12 tick counts", { ...counts }); }
  }
}
