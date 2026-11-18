// RFL judge: which predicate clauses refuse the REAL state measured after a real mid-turn Stop?
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isQuiescentRetainedPiSource } from "../services/native-runtime/native-retained-pi-source.js";

function find(root: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink() && !["node_modules", "provider-pack", "authority-epochs"].includes(entry.name)) out.push(...find(path, name));
    else if (entry.isFile() && entry.name === name && path.endsWith(join("runner", name))) out.push(path);
  }
  return out;
}
it.skipIf(!process.env.JUDGE_EVIDENCE).each(["judge-midturn-second", "judge-midturn-first", "green-head"])("clauses for %s", label => {
  const root = join(process.env.JUDGE_EVIDENCE!, label);
  if (!existsSync(root)) return;
  const sandbox = readdirSync(root).filter(name => name.startsWith("native-pi-new-sandbox-lease-")).map(name => join(root, name, "simulated-sandbox"))[0]!;
  // For green-head the live runner-state belongs to the successor; use the retained predecessor copy instead.
  const runnerPath = label === "green-head" ? join(sandbox, "..", "predecessor-runner-state.json") : find(sandbox, "runner-state.json")[0]!;
  const providerPath = find(sandbox, "codex-provider-state.json")[0]!;
  const runnerState = JSON.parse(readFileSync(runnerPath, "utf8")), providerState = JSON.parse(readFileSync(providerPath, "utf8"));
  const identity = Object.fromEntries(["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"].map(key => [key, runnerState[key]]));
  const evaluate = (patch: Record<string, unknown> = {}) => isQuiescentRetainedPiSource({
    owner: { phase: "terminal_failure", leaseOwner: null, resultId: null, recoveryState: null }, runStatus: "cancelled",
    terminationReceipt: true, leaseHandoff: true, processesAbsent: true, identity, providerSessionId: providerState.providerSessionId,
    runnerState, providerState: { ...providerState, ...patch } });
  const result = { label, measured: { runnerLifecycle: runnerState.lifecycle, providerLifecycle: providerState.lifecycle, completedTurnAuthoritative: providerState.completedTurnAuthoritative,
      pendingEventsIsArray: Array.isArray(providerState.pendingEvents), queuedEventsIsArray: Array.isArray(providerState.queuedEvents), toolBridgePending: providerState.toolBridge?.pending },
    asMeasured: evaluate(), ifLifecycleWereSessionOpen: evaluate({ lifecycle: "session_open" }),
    ifCompletedTurnWereAuthoritative: evaluate({ completedTurnAuthoritative: true }),
    ifBoth: evaluate({ lifecycle: "session_open", completedTurnAuthoritative: true }) };
  writeFileSync(join(process.env.JUDGE_EVIDENCE!, `judge-midturn-clauses-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  expect(typeof result.asMeasured).toBe("boolean");
});
