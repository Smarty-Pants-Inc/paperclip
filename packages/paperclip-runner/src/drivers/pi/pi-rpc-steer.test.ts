import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import { createPiSteerRecordingPeer } from "../../../test-support/pi-rpc-steer-peer.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";

// Keep reason: cross-protocol ownership/data-safety boundary. A queued ACK is
// not consumption, and neither stale input nor Pi's low-level turn_end may
// redirect input to a different admitted turn (rung 4 / C3).
describe("Pi RPC same-turn steering", () => {
  it("sends native steer, then projects recorded consumption once under the original turn and origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-steer-"));
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"));
    const driver = new PiRpcDriver({ ...peer.driverOptions, runtimeDirectory: root, runnerInstanceId: "steer-runner" });
    const session = await driver.openSession({ runId: "steer-run", normalizedSessionId: "steer-session", workingDirectory: root });
    const admittedCommands = await peer.commands();
    expect(admittedCommands.filter(command => command.type === "get_available_models")).toHaveLength(1);
    expect(admittedCommands.some(command => ["prompt", "steer"].includes(command.type))).toBe(false);
    const events: PrpEvent[] = [];
    const pump = (async () => { for await (const event of session.events()) events.push(event); })();
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "scenario:queue" } });
      expect(session.steer).toBeTypeOf("function");
      await session.steer!({ turnId, message: { role: "user", text: "steering-marker" } });
      expect(events.some(event => event.eventType === "item.completed" && event.payload.kind === "userMessage" && event.payload.text === "steering-marker")).toBe(false);
      expect((await session.snapshot()).activeTurnId).toBe(turnId);
      await peer.releaseConsumption();
      await expect.poll(() => events.some(event => event.eventType === "turn.completed")).toBe(true);
      const consumed = events.filter(event => event.eventType === "item.completed" && event.payload.kind === "userMessage" && event.payload.text === "steering-marker");
      expect(consumed).toHaveLength(1);
      expect(consumed[0]).toMatchObject({ turnId, runId: "steer-run", normalizedSessionId: "steer-session", sourceInstanceId: "steer-runner" });
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      expect(events.filter(event => event.eventType.startsWith("turn.") && event.eventType !== "turn.started")).toHaveLength(1);
      const admissionEvents = events.filter(event => event.eventType === "session.started");
      expect(admissionEvents).toHaveLength(1);
      expect(admissionEvents[0]).toMatchObject({ runId: "steer-run", payload: { context: { piMetadata: { providers: ["paperclip"], promptSent: false } } } });
      expect(admissionEvents[0].turnId).toBeUndefined();
      expect(events.every(event => event.runId === "steer-run" && (event.eventType === "session.started" || event.turnId === turnId))).toBe(true);
      for (const event of events) expect(validatePrpEvent(event)).toMatchObject({ ok: true });
      expect((await peer.commands()).filter(command => ["prompt", "steer", "abort", "follow_up"].includes(command.type))).toEqual([
        expect.objectContaining({ type: "prompt", message: "scenario:queue" }),
        expect.objectContaining({ type: "steer", message: "steering-marker" }),
      ]);
    } finally {
      await session.close({ reason: "test" });
      await pump;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses wrong-turn, follow-up, and already-settled steering without writing Pi commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-steer-stale-"));
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"));
    const session = await new PiRpcDriver({ ...peer.driverOptions, runtimeDirectory: root })
      .openSession({ runId: "run", normalizedSessionId: "session", workingDirectory: root });
    const events: PrpEvent[] = [];
    const pump = (async () => { for await (const event of session.events()) events.push(event); })();
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "scenario:queue" } });
      expect(session.steer).toBeTypeOf("function");
      await expect(session.steer!({ turnId: "wrong-turn", message: { role: "user", text: "steering-marker" } })).rejects.toMatchObject({ code: "stale_turn" });
      await expect(session.steer!({ mode: "follow_up", turnId, message: { role: "user", text: "steering-marker" } })).rejects.toThrow(/follow.up.*unavailable/i);
      await peer.releaseConsumption();
      await expect.poll(() => events.some(event => event.eventType === "turn.completed")).toBe(true);
      await expect(session.steer!({ turnId, message: { role: "user", text: "steering-marker" } })).rejects.toMatchObject({ code: "already_terminal" });
      expect((await peer.commands()).filter(command => ["steer", "follow_up"].includes(command.type))).toEqual([]);
    } finally {
      await session.close({ reason: "test" });
      await pump;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["started", "handled", ""])("does not acknowledge steer unless Pi reports queued (got %j)", async disposition => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-steer-ack-"));
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"), disposition);
    const session = await new PiRpcDriver({ ...peer.driverOptions, runtimeDirectory: root })
      .openSession({ runId: "run", normalizedSessionId: "session", workingDirectory: root });
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "scenario:queue" } });
      expect(session.steer).toBeTypeOf("function");
      await expect(session.steer!({ turnId, message: { role: "user", text: "steering-marker" } })).rejects.toThrow(/did not queue/);
      expect((await session.snapshot()).activeTurnId).toBe(turnId);
    } finally {
      await session.close({ reason: "test" });
      await rm(root, { recursive: true, force: true });
    }
  });
});
