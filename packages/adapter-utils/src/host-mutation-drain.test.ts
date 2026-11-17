import { describe, expect, it } from "vitest";
import {
  createHostMutationDrain,
  currentHostMutationDrain,
  hostMutation,
  joinHostMutationDrains,
  withHostMutationDrain,
} from "./host-mutation-drain.js";

describe("host mutation drain: a joined (nested) gate", () => {
  it("an OUTER close refuses the inner work's new host calls and aborts its signal", async () => {
    const outer = createHostMutationDrain(), inner = createHostMutationDrain();
    const joined = joinHostMutationDrains(outer, inner);
    outer.close(new Error("outer lost"));
    expect(joined.signal.aborted).toBe(true);
    expect((joined.signal.reason as Error).message).toBe("outer lost");
    let called = false;
    await expect(withHostMutationDrain(inner, () => hostMutation(async () => { called = true; }), outer))
      .rejects.toMatchObject({ code: "HOST_MUTATION_REFUSED" });
    expect(called).toBe(false);
    expect(inner.closed).toBe(false);
  });

  it("an inner in-flight call is counted by BOTH gates: the outer drain waits for it", async () => {
    const outer = createHostMutationDrain(), inner = createHostMutationDrain();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const call = withHostMutationDrain(inner, () => {
      expect(currentHostMutationDrain()?.signal.aborted).toBe(false);
      return hostMutation(() => held);
    }, outer);
    expect(outer.inFlight).toBe(1);
    expect(inner.inFlight).toBe(1);
    expect(await outer.closeAndDrain(20)).toEqual({ drained: false, inFlight: 1 });
    finish();
    await call;
    expect(await outer.closeAndDrain(20)).toEqual({ drained: true });
    expect(inner.inFlight).toBe(0);
  });

  it("without a parent the gate is unchanged; the drain's own close aborts its signal", async () => {
    const drain = createHostMutationDrain();
    expect(drain.signal.aborted).toBe(false);
    await withHostMutationDrain(drain, () => hostMutation(async () => undefined));
    drain.close();
    expect(drain.signal.aborted).toBe(true);
    await expect(withHostMutationDrain(drain, () => hostMutation(async () => undefined))).rejects.toMatchObject({ code: "HOST_MUTATION_REFUSED" });
  });
});
