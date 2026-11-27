import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { withHumanDirectedWork } from "./human-directed-work.js";
import { getNativeReviewAssignment } from "./native-runtime/native-review-participant.js";
import {
  resolveCoreTrustPreset,
  type ResolveCoreTrustPresetInput,
} from "./trust-preset-resolver.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Retain dispatch's effective boundary before exposing any execution capability. */
export async function resolveAndRetainRunTrustPreset(
  db: Db,
  input: Omit<ResolveCoreTrustPresetInput, "run"> & {
    agentId: string;
    runId: string;
  },
) {
  return db.transaction(async (tx) => {
    const scope = and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "running"),
    );
    const [run] = await tx
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(scope)
      .for("update");
    if (!run) throw conflict("Cannot retain policy for an inactive execution");

    // Use the durable run policy, not a caller's possibly stale launch snapshot.
    // Resuming or editing a live policy may tighten this boundary, never erase it.
    const existingPolicy = run.contextSnapshot?.executionPolicy;
    let trustPreset = resolveCoreTrustPreset({
      ...input,
      run: { companyId: input.companyId, executionPolicy: existingPolicy },
    });
    if (trustPreset.kind === "denied" && trustPreset.reason === "missing_low_trust_boundary_scope") {
      const issueId = run.contextSnapshot?.issueId;
      const [issue] = typeof issueId === "string" ? await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, input.companyId),
        eq(issues.executionRunId, input.runId),
      )).for("update") : [];
      if (issue && await getNativeReviewAssignment(tx as unknown as Db, {
        companyId: input.companyId, issueId: issue.id, agentId: input.agentId,
        contextSnapshot: run.contextSnapshot,
      })) {
        const policy = asRecord(existingPolicy);
        const authorizationPolicy = asRecord(policy.authorizationPolicy);
        trustPreset = resolveCoreTrustPreset({
          ...input,
          run: { companyId: input.companyId, executionPolicy: {
            ...policy,
            authorizationPolicy: {
              ...authorizationPolicy,
              trustBoundary: {
                ...asRecord(authorizationPolicy.trustBoundary),
                mode: "low_trust_review",
                issueIds: asRecord(authorizationPolicy.trustBoundary).issueIds ?? [issue.id],
              },
            },
          } },
        });
      }
    }
    if (trustPreset.kind !== "low_trust_review") {
      return { trustPreset, executionPolicy: existingPolicy };
    }

    const executionPolicy = {
      ...asRecord(existingPolicy),
      trustPreset: trustPreset.preset,
      authorizationPolicy: {
        ...asRecord(asRecord(existingPolicy).authorizationPolicy),
        trustPreset: trustPreset.preset,
        trustBoundary: trustPreset.boundary,
      },
    };
    await tx
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{executionPolicy}', ${JSON.stringify(executionPolicy)}::jsonb, true)`,
        updatedAt: new Date(),
      })
      .where(scope);
    return { trustPreset: await withHumanDirectedWork(tx, trustPreset, {
      companyId: input.companyId, agentId: input.agentId,
      runId: input.runId,
    }), executionPolicy };
  });
}
