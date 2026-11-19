import { describe, expect, it } from "vitest";
import {
  createHostMutationDrain,
  currentHostMutationDrain,
  hostDeferredCleanup,
  hostMutation,
  joinHostMutationDrains,
  withHostMutationDrain,
} from "./host-mutation-drain.js";

// adopt-drain4 never-OK guard: work abandoned on REMOTE I/O at the owner's
// deadline (not a host fs call, so not awaited) still has its registered host
// cleanup run BY THE DRAIN before drained() resolves; its late finally is then
// a no-op. A drain that leaves the cleanup to the late finally either releases
// ownership with the cleanup still to come (a host mutation after drained())
// or waits on the remote I/O (the lock is not free at the deadline).
describe("host mutation drain: registered cleanups at close", () => {
  it("runs an abandoned work's registered cleanup itself, before drained(); the late finally is a no-op", async () => {
    const drain = createHostMutationDrain();
    const events: string[] = [];
    let releaseRemote!: () => void;
    const remote = new Promise<void>((resolve) => { releaseRemote = resolve; });
    const work = withHostMutationDrain(drain, async () => {
      const cleanup = hostDeferredCleanup(async () => { events.push("cleanup"); });
      try {
        await hostMutation(async () => { events.push("host-write"); });
        await remote; // stuck remote I/O: abandoned at the deadline
        await hostMutation(async () => { events.push("late-host-write"); });
      } finally {
        await cleanup();
        events.push("late-finally");
      }
    });
    work.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    const result = await drain.closeAndDrain(1_000);
    events.push("drained");
    expect(result).toEqual({ drained: true });
    expect(events).toEqual(["host-write", "cleanup", "drained"]);

    releaseRemote();
    await expect(work).rejects.toMatchObject({ code: "HOST_MUTATION_REFUSED" });
    // Nothing ran again after drained(): the late finally's cleanup call was a no-op.
    expect(events).toEqual(["host-write", "cleanup", "drained", "late-finally"]);
  });

  it("waits for an in-flight host call before it runs the cleanups (and holds past the cap until it returns)", async () => {
    const drain = createHostMutationDrain();
    const events: string[] = [];
    let finishWrite!: () => void;
    const work = withHostMutationDrain(drain, async () => {
      const cleanup = hostDeferredCleanup(async () => { events.push("cleanup"); });
      try {
        await hostMutation(() => new Promise<void>((resolve) => { finishWrite = () => { events.push("write-returned"); resolve(); }; }));
      } finally { await cleanup(); }
    });
    work.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await drain.closeAndDrain(20)).toMatchObject({ drained: false });
    expect(events).toEqual([]);
    const drained = drain.drained().then(() => { events.push("drained"); });
    finishWrite();
    await drained;
    expect(events).toEqual(["write-returned", "cleanup", "drained"]);
    await work;
    expect(events).toEqual(["write-returned", "cleanup", "drained"]);
  });

  it("outside a drain, the handle runs the cleanup once", async () => {
    let runs = 0;
    const cleanup = hostDeferredCleanup(async () => { runs += 1; });
    await cleanup();
    await cleanup();
    expect(runs).toBe(1);
  });
});

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

// adopt-drain-join never-OK guard: one mechanism. An inner owner's work joined
// to an outer owner, stuck on remote I/O when the OUTER closes: the outer's
// drain runs the inner's registered cleanup itself before the outer is
// drained (the inner gate stays open); whichever drain closes first runs it,
// exactly once.
describe("host mutation drain: a joined gate's registered cleanups", () => {
  it("the OUTER close runs the inner work's registered cleanup before the outer is drained; the late finally is a no-op", async () => {
    const outer = createHostMutationDrain(), inner = createHostMutationDrain();
    const events: string[] = [];
    let releaseRemote!: () => void;
    const remote = new Promise<void>((resolve) => { releaseRemote = resolve; });
    const work = withHostMutationDrain(inner, async () => {
      const cleanup = hostDeferredCleanup(async () => { events.push("cleanup"); });
      try {
        await hostMutation(async () => { events.push("host-write"); });
        await remote;
        await hostMutation(async () => { events.push("late-host-write"); });
      } finally {
        await cleanup();
        events.push("late-finally");
      }
    }, outer);
    work.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(await outer.closeAndDrain(1_000)).toEqual({ drained: true });
    events.push("outer-drained");
    expect(events).toEqual(["host-write", "cleanup", "outer-drained"]);
    expect(inner.closed).toBe(false);

    releaseRemote();
    await expect(work).rejects.toMatchObject({ code: "HOST_MUTATION_REFUSED" });
    expect(await inner.closeAndDrain(1_000)).toEqual({ drained: true });
    expect(events).toEqual(["host-write", "cleanup", "outer-drained", "late-finally"]);
  });

  it("the INNER close runs it first; the outer's later close waits for that same run and does not repeat it", async () => {
    const outer = createHostMutationDrain(), inner = createHostMutationDrain();
    const events: string[] = [];
    let finishCleanup!: () => void;
    const work = withHostMutationDrain(inner, async () => {
      hostDeferredCleanup(() => new Promise<void>((resolve) => {
        events.push("cleanup-start");
        finishCleanup = () => { events.push("cleanup-end"); resolve(); };
      }));
      await new Promise<void>(() => undefined); // abandoned on remote I/O
    }, outer);
    work.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    inner.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["cleanup-start"]);
    expect(await outer.closeAndDrain(20)).toMatchObject({ drained: false });
    finishCleanup();
    await outer.drained();
    events.push("outer-drained");
    await inner.drained();
    expect(events).toEqual(["cleanup-start", "cleanup-end", "outer-drained"]);
  });
});
