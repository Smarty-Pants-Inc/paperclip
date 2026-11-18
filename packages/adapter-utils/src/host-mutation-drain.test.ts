import { describe, expect, it } from "vitest";
import {
  createHostMutationDrain,
  hostDeferredCleanup,
  hostMutation,
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
