import { describe, it, expect } from "vitest";
import { registerCleanupSettledResumer, resetCleanupSettledWakesForTest, wakeAfterCleanupSettled } from "./native-runtime/cleanup-settled-wake.js";

describe("S048 judge R-ONCE acceptance", () => {
  it("duplicate same-event triggers invoke the resumer only once", async () => {
    resetCleanupSettledWakesForTest();
    let calls = 0;
    const unregister = registerCleanupSettledResumer(async () => { calls++; });
    try {
      await Promise.all([1, 2].map(() => wakeAfterCleanupSettled({ companyId: "company", runId: "same-event", event: "export_finalized" })));
      expect(calls).toBe(1);
    } finally { unregister(); }
  });
  it("export-finalized plus lease-released are two triggers but only ONE wake for a settled run", async () => {
    resetCleanupSettledWakesForTest();
    let calls = 0;
    const unregister = registerCleanupSettledResumer(async () => { calls++; });
    try {
      await wakeAfterCleanupSettled({ companyId: "company", runId: "both-events", event: "export_finalized" });
      await wakeAfterCleanupSettled({ companyId: "company", runId: "both-events", event: "lease_released" });
      expect(calls).toBe(1);
    } finally { unregister(); }
  });
});
