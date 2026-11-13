import { createHash } from "node:crypto";
import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { G12Config } from "./config.js";
import { GitHub, signAppJwt } from "./github.js";

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

/** One serialized host job. No agents.invoke, sessions, routine or model work. */
export async function runTick(host: Host, config: G12Config, now = Date.now()): Promise<Counts> {
  const counts: Counts = { repos: 0, prs: 0, eligible: 0, drafts: 0, unmapped: 0, checks: 0,
    missing: 0, failing: 0, wakes: 0, deduped: 0, refused: 0, unresolved: 0, errors: 0 };
  if (!config.enabled) {
    host.logger.info("G12 tick counts", { ...counts });
    return counts;
  }
  const deadline = Date.now() + 240_000;
  try {
    const github = new GitHub(host.http, deadline);
    // Resolve just this configured, company-bound reference. Neither key nor
    // JWT nor installation token is cached between ticks or stored in state.
    const jwt = signAppJwt(config.appId, await host.secrets.resolve(config.privateKeyRef, {
      companyId: config.companyId, configPath: "privateKeyRef",
    }), now);
    const token = await github.installationToken(config, jwt);
    const repos = config.repos === "all" ? await github.repositories(token) : config.repos;
    for (const repo of repos) {
      counts.repos++;
      for await (const pr of github.pulls(repo, token)) {
        counts.prs++;
        if (pr.draft) { counts.drafts++; continue; }
        const owner = pr.user ? config.owners[pr.user.login.toLowerCase()] : undefined;
        if (!owner) { counts.unmapped++; continue; }
        counts.eligible++;
        const head = pr.head.sha;
        const identity = `${repo}:${pr.number}:${head}`;
        const seenKey = stateKey(config.companyId, `seen:${hash(`${config.appId}:${config.installationId}:${identity}`)}`);
        let firstSeen = await host.state.get(seenKey);
        if (firstSeen === null || firstSeen === undefined) {
          firstSeen = now;
          await host.state.set(seenKey, firstSeen);
        }
        if (typeof firstSeen !== "number" || !Number.isFinite(firstSeen) || firstSeen < 0) {
          throw new Error("G12_FIRST_SEEN_INVALID");
        }
        const checks = (await github.checks(repo, head, token)).filter((check) => check.head_sha === head);
        counts.checks += checks.length;
        const keys: string[] = [];
        const hasReview = checks.some((check) => check.name === "Paperclip Review" && check.app?.id === config.appId);
        if (!hasReview && now - firstSeen >= config.missingReviewMinutes * 60_000) {
          counts.missing++;
          keys.push(`g12:missing:${identity}`);
        }
        for (const check of checks) {
          if (check.status !== "completed" || !["failure", "timed_out"].includes(check.conclusion ?? "")) continue;
          counts.failing++;
          keys.push(`g12:fail:${identity}:${check.name}:${check.conclusion}`);
        }
        for (const key of new Set(keys)) {
          const receiptKey = stateKey(config.companyId, `wake:${hash(key)}`);
          const prior = await host.state.get(receiptKey);
          if (prior != null) {
            counts.deduped++;
            if (typeof prior !== "object" || !("outcome" in prior) || prior.outcome !== "queued") counts.unresolved++;
            continue;
          }
          if (Date.now() >= deadline) throw new Error("G12_SCAN_BUDGET_EXCEEDED");
          // The shipped issue-wake API passes idempotencyKey to heartbeat but
          // does NOT enforce general g12:* replay dedupe. Reserve BEFORE send:
          // at most one attempt, including across restart after an ambiguous
          // response. This trades a crash-window missed wake for no duplicate.
          // No CAS is claimed: host scheduler admission serializes this job;
          // plugin.ts also rejects concurrent worker-local runJob calls.
          const receipt = { key, agentId: owner.agentId, issueId: owner.issueId, attemptedAt: now };
          await host.state.set(receiptKey, { ...receipt, outcome: "reserved" });
          let result;
          try {
            result = await host.issues.requestWakeup(owner.issueId, config.companyId, {
              reason: key,
              contextSource: "smarty.g12-backstop",
              idempotencyKey: key,
            });
          } catch {
            counts.errors++;
            await host.state.set(receiptKey, { ...receipt, outcome: "uncertain" });
            throw new Error("G12_WAKE_UNCERTAIN_RECONCILE_RECEIPT");
          }
          if (result.queued) counts.wakes++;
          else counts.refused++;
          await host.state.set(receiptKey, { ...receipt, outcome: result.queued ? "queued" : "refused", runId: result.runId });
        }
      }
    }
    if (counts.refused > 0) throw new Error("G12_WAKE_REFUSED_RECONCILE_RECEIPT");
    if (counts.unresolved > 0) throw new Error("G12_WAKE_UNRESOLVED_RECONCILE_RECEIPT");
    return counts;
  } catch (error) {
    if (counts.errors === 0) counts.errors++;
    // Host service failures may contain secrets. Only fixed plugin-owned error
    // codes (or numeric HTTP status) cross the worker's job error boundary.
    const message = error instanceof Error && /^G12_[A-Z0-9_]+$/.test(error.message) ? error.message : "G12_TICK_FAILED";
    throw new Error(message);
  } finally {
    host.logger.info("G12 tick counts", { ...counts });
  }
}
