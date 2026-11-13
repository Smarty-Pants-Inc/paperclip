import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readCheckpointStallEvidence } from "./native-checkpoint-stall-evidence.js";

// Trust boundary / data safety: a controller checkpoint is evidence, never a
// grant to ignore a missing containment receipt or a different source history.
it.each(["valid", "uncontained", "foreign_identity", "changed_checkpoint", "replay_conflict"] as const)(
  "keeps checkpoint-stall evidence fail-closed: %s", scenario => {
    const root = mkdtempSync(resolve(tmpdir(), "checkpoint-stall-evidence-"));
    const name = `checkpoint-stall-${Date.now()}-${randomUUID()}`;
    const directory = resolve(root, "diagnostics", name);
    const committedDirectory = resolve(directory, "committed", "control-plane");
    mkdirSync(committedDirectory, { recursive: true });
    const identity = { runId: randomUUID(), normalizedSessionId: randomUUID(), runnerInstanceId: randomUUID(),
      environmentLeaseId: randomUUID(), turnId: randomUUID(), itemId: randomUUID() };
    const bytes = JSON.stringify({ identity, ackedSourceSeq: 7 });
    writeFileSync(resolve(committedDirectory, "control-plane-state.json"), scenario === "changed_checkpoint" ? `${bytes} ` : bytes);
    writeFileSync(resolve(directory, "receipt.json"), JSON.stringify({ schema: "paperclip.checkpoint-only-stall.v1", identity,
      ackedSourceSeq: 7, reason: scenario === "replay_conflict" ? "source_event_replay_conflict" : "runner_event_commit_stalled",
      detail: "checkpoint_flush_failed:ECONNREFUSED at source seq 8", committedSha256: createHash("sha256").update(bytes).digest("hex") }));
    if (scenario !== "uncontained") writeFileSync(resolve(directory, "contained.json"), JSON.stringify({
      schema: "paperclip.checkpoint-only-stall-contained.v1", identity, runnerPid: 12345 }));
    const expected = scenario === "foreign_identity" ? { ...identity, runId: randomUUID() } : identity;
    const proof = readCheckpointStallEvidence(root, expected);
    if (scenario === "valid") expect(proof).toMatchObject({ name, identity, runnerPid: 12345, bytes });
    else expect(proof).toBeNull();
    if (scenario === "uncontained") expect(readCheckpointStallEvidence(root, identity, false)).not.toBeNull();
  });
