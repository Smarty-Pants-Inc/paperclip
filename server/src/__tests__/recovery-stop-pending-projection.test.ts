import { describe, expect, it } from "vitest";
import { STOP_PENDING_SCHEMA, withTaskStopPendingInstruction } from "../services/recovery/stop-pending.js";

// Keep reason: #20807 J3 caught the real issue API hiding Stop behind a
// saved-work projection. These controls protect ordering, secondary copy and
// idempotence of the instruction composer used by that same read model.
describe("Stop-pending instruction projection", () => {
  const held = { evidence: { stopPending: { schema: STOP_PENDING_SCHEMA } } };
  it("keeps Stop primary and the independent workspace instruction secondary", () => {
    const workspace = "Paperclip could not recover the agent's saved files after 6 tries. Press Retry to try again; the agent will not repeat its work.";
    const projected = withTaskStopPendingInstruction(held, workspace);
    expect(projected).toMatch(/^Stop pending \(execution_stop_pending\):/);
    expect(projected).toContain("The task stays held until Stop is proved");
    expect(projected.endsWith(`\n\n${workspace}`)).toBe(true);
  });
  it("does not duplicate an existing protected instruction or discard the independent instruction", () => {
    const projected = withTaskStopPendingInstruction(held, "Inspect the independent saved-work receipt.");
    expect(withTaskStopPendingInstruction(held, projected)).toBe(projected);
    expect(projected.match(/execution_stop_pending/g)).toHaveLength(1);
    expect(projected).toContain("Inspect the independent saved-work receipt.");
  });
  it.each([{ evidence: {} }, { evidence: { stopPending: null } }, { evidence: { stopPending: { schema: "unknown" } } }])(
    "leaves the ordinary projection unchanged without a recognized Stop obligation: %j", action => {
      expect(withTaskStopPendingInstruction(action, "Ordinary saved-work instruction.")).toBe("Ordinary saved-work instruction.");
    });
});
