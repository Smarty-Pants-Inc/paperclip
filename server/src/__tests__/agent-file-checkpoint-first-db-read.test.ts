import { expect, it } from "vitest";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { drainAgentFileCheckpoints } from "../services/agent-directory-working-copies.js";

// Independent judge check: hold the first lookup, before directory capture exists.
// Keep: the shutdown/DB-close race must cover the initial lookup, not only capture.
it.each(["checkpointWarm", "collectStopped"] as const)("RF2 first DB read is joined for %s", async method => {
  const lookup = Promise.withResolvers<never[]>();
  const events: string[] = [];
  const db = { select: () => ({ from: () => ({ where: () => { events.push("lookup_started"); return lookup.promise; } }) }) };
  const copies = agentInstructionWorkingCopyService(db as never);
  const save = copies[method]({ companyId: "judge-company", runId: "judge-run" });
  let joined = false;
  const join = drainAgentFileCheckpoints().then(() => { joined = true; events.push("join_completed"); });
  try {
    for (let n = 0; n < 5; n++) await new Promise<void>(resolve => setImmediate(resolve));
    console.log("RF2_INITIAL_LOOKUP", JSON.stringify({ method, events, joined }));
    expect(events).toContain("lookup_started");
    expect(joined, "shutdown must not finish joining while the first DB lookup is held").toBe(false);
  } finally {
    lookup.resolve([]);
    await Promise.allSettled([save, join]);
  }
  expect(joined).toBe(true);
});
