import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createUnboundServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { DurablePrpControlPlane } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  queueLiveRunnerPrpCommand,
  queueRunnerPrpRuntimeRequestResolution,
  registerRunnerPrpAuthority,
  RunnerPrpRuntimeRequestResolutionError,
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "./runner-prp-ws.js";

// Routing-only fixtures expose a bound address; HTTP server tests exercise the
// real listen/close and DNS boundaries without replacing this router's logic.
function createBoundServer(port: number) {
  const server = createUnboundServer();
  vi.spyOn(server, "listening", "get").mockReturnValue(true);
  vi.spyOn(server, "address").mockReturnValue({ address: "127.0.0.1", family: "IPv4", port });
  setupRunnerPrpWebSocketServer(server);
  return server;
}

describe("runner PRP websocket route", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("routes only the registered run and releases it by generation", async () => {
    const server = createBoundServer(3210);
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });

    expect(registration.connectUrl).toBe(
      `ws://127.0.0.1:3210/api/runner/v1/connect/${runId}`,
    );
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(true);

    const socket = new PassThrough();
    const request = { url: `/api/runner/v1/connect/${runId}`, headers: {} };
    server.emit("upgrade", request, socket, Buffer.alloc(0));
    expect(request).toMatchObject({ paperclipWebSocketHandled: true });
    expect(handleUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: `/api/runner/v1/connect/${runId}` }),
      socket,
      `/api/runner/v1/connect/${runId}`,
      expect.any(Buffer),
    );

    await registration.release();
    expect(
      runnerPrpWebSocketInternals.activeRegistration({
        companyId: "company-1",
        runId,
      }),
    ).toBe(false);
    server.close();
  });

  it.each([
    ["/api/runner/v1/connect/not-a-run", "400 Bad Request"],
    [
      "/api/runner/v1/connect/00000000-0000-4000-8000-000000000778",
      "404 Not Found",
    ],
  ])("fails closed for %s", (path, expectedStatus) => {
    const server = createBoundServer(3211);
    const socket = new PassThrough();
    const writes: Buffer[] = [];
    socket.on("data", (chunk) => writes.push(Buffer.from(chunk)));
    server.emit("upgrade", { url: path, headers: {} }, socket, Buffer.alloc(0));
    expect(Buffer.concat(writes).toString("utf8")).toContain(expectedStatus);
    server.close();
  });

  // b1-prp-revoke (RFL rf-4 fence (c)): the route registry is where every
  // registered run's PRP authority is finalized or superseded.
  it("R1 wiring: finalizing a run's route (Stop) revokes that run's PRP credentials once", async () => {
    const server = createBoundServer(3216);
    const runId = "00000000-0000-4000-8000-000000000791";
    const revokeRunCredentials = vi.fn(async () => 1);
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1", issueId: "issue-1", agentId: "agent-1", runId,
      authority: { revokeRunCredentials } as unknown as DurablePrpControlPlane,
    });
    expect(revokeRunCredentials).not.toHaveBeenCalled();
    await registration.release("finalize");
    expect(revokeRunCredentials).toHaveBeenCalledExactlyOnceWith(runId, "run_finalized");
    await registration.release("finalize");
    expect(revokeRunCredentials).toHaveBeenCalledTimes(1);
    server.close();
  });

  it.each([undefined, "detach"] as const)("keeps credentials when the route is released without finalize (%s)", async (reason) => {
    const server = createBoundServer(3217);
    const runId = "00000000-0000-4000-8000-000000000792";
    const revokeRunCredentials = vi.fn(async () => 1);
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1", runId,
      authority: { revokeRunCredentials } as unknown as DurablePrpControlPlane,
    });
    await registration.release(reason);
    expect(revokeRunCredentials).not.toHaveBeenCalled();
    server.close();
  });

  it("R2 wiring: a successor's registration revokes only the predecessor's credentials", async () => {
    const server = createBoundServer(3218);
    const oldRunId = "00000000-0000-4000-8000-000000000793";
    const newRunId = "00000000-0000-4000-8000-000000000794";
    const oldRevoke = vi.fn(async () => 1);
    const newRevoke = vi.fn(async () => 1);
    const binding = { companyId: "company-1", issueId: "issue-1", agentId: "agent-1" };
    const oldRegistration = await registerRunnerPrpAuthority({ ...binding, runId: oldRunId,
      authority: { revokeRunCredentials: oldRevoke } as unknown as DurablePrpControlPlane });
    const newRegistration = await registerRunnerPrpAuthority({ ...binding, runId: newRunId,
      authority: { revokeRunCredentials: newRevoke } as unknown as DurablePrpControlPlane });
    expect(oldRevoke).toHaveBeenCalledExactlyOnceWith(oldRunId, "run_superseded");
    expect(newRevoke).not.toHaveBeenCalled();
    await oldRegistration.release("finalize");
    expect(oldRevoke).toHaveBeenCalledTimes(2);
    expect(newRevoke).not.toHaveBeenCalled();
    await newRegistration.release("finalize");
    expect(newRevoke).toHaveBeenCalledExactlyOnceWith(newRunId, "run_finalized");
    server.close();
  });

  it("does not revoke through an authority a warm transition still routes for another run", async () => {
    const server = createBoundServer(3219);
    const oldRunId = "00000000-0000-4000-8000-000000000795";
    const newRunId = "00000000-0000-4000-8000-000000000796";
    const revokeRunCredentials = vi.fn(async () => 1);
    const authority = { revokeRunCredentials } as unknown as DurablePrpControlPlane;
    const binding = { companyId: "company-1", issueId: "issue-1", agentId: "agent-1", authority };
    const oldRegistration = await registerRunnerPrpAuthority({ ...binding, runId: oldRunId });
    const newRegistration = await registerRunnerPrpAuthority({ ...binding, runId: newRunId });
    await oldRegistration.release("finalize");
    expect(revokeRunCredentials).not.toHaveBeenCalled();
    await newRegistration.release("finalize");
    expect(revokeRunCredentials).toHaveBeenCalledExactlyOnceWith(newRunId, "run_finalized");
    server.close();
  });

  it("does not replace an active registration", async () => {
    const server = createBoundServer(3212);
    const runId = "00000000-0000-4000-8000-000000000779";
    const authority = {
      handleUpgrade: vi.fn(),
    } as unknown as DurablePrpControlPlane;
    const first = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority,
    });
    await expect(
      registerRunnerPrpAuthority({ companyId: "company-2", runId, authority }),
    ).rejects.toThrow("runner_prp_authority_already_registered");
    await first.release();
    server.close();
  });

  it("routes live commands only to the newest generation", async () => {
    const server = createBoundServer(3214);
    const oldRunId = "00000000-0000-4000-8000-000000000781";
    const newRunId = "00000000-0000-4000-8000-000000000782";
    const oldQueueCommand = vi.fn(() => ({
      commandId: "old-command",
      controllerSeq: 1,
    }));
    const newQueueCommand = vi.fn(() => ({
      commandId: "new-command",
      controllerSeq: 2,
    }));
    const oldRegistration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: oldRunId,
      authority: {
        queueCommand: oldQueueCommand,
        commandOutcome: vi.fn(() => ({ status: "completed", result: null })),
      } as unknown as DurablePrpControlPlane,
    });
    const newRegistration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: newRunId,
      authority: {
        queueCommand: newQueueCommand,
        commandOutcome: vi.fn(() => ({ status: "completed", result: null })),
      } as unknown as DurablePrpControlPlane,
    });

    expect(
      queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      }),
    ).toMatchObject({ runId: newRunId, commandId: "new-command" });
    expect(oldQueueCommand).not.toHaveBeenCalled();
    expect(newQueueCommand).toHaveBeenCalledOnce();

    await oldRegistration.release();
    expect(
      queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      }),
    ).toMatchObject({ runId: newRunId, commandId: "new-command" });
    expect(newQueueCommand).toHaveBeenCalledTimes(2);

    await newRegistration.release();
    expect(
      queueLiveRunnerPrpCommand({
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
        type: "session.goal.get",
      }),
    ).toBeNull();
    server.close();
  });

  it("queues one company-bound, idempotent runtime request resolution", async () => {
    const server = createBoundServer(3213);
    const queueCommand = vi.fn(() => ({ commandId: "command-resolution-1" }));
    const runId = "00000000-0000-4000-8000-000000000780";
    const registration = await registerRunnerPrpAuthority({
      companyId: "company-1",
      runId,
      authority: {
        queueCommand,
        store: { state: { identity: { runId } } },
      } as unknown as DurablePrpControlPlane,
    });
    const input = {
      companyId: "company-1",
      runId,
      pendingRequest: {
        companyId: "company-1",
        runId,
        requestId: "request-1",
        requestKind: "command_approval" as const,
        turnId: "turn-1",
        resolverPolicy: "instance_admin" as const,
      },
      actor: {
        type: "user" as const,
        userId: "instance-admin",
        isInstanceAdmin: true,
      },
      resolution: { action: "accept" as const },
    };

    expect(queueRunnerPrpRuntimeRequestResolution(input)).toEqual({
      commandId: "command-resolution-1",
    });
    expect(queueRunnerPrpRuntimeRequestResolution(input)).toEqual({
      commandId: "command-resolution-1",
    });
    expect(queueCommand).toHaveBeenCalledTimes(1);
    expect(queueCommand).toHaveBeenCalledWith(
      "request.resolve",
      {
        requestId: "request-1",
        requestKind: "command_approval",
        turnId: "turn-1",
        resolution: { action: "accept" },
        resolutionActor: {
          type: "user",
          userId: "instance-admin",
          isInstanceAdmin: true,
        },
      },
      undefined,
      true,
    );

    expect(() =>
      queueRunnerPrpRuntimeRequestResolution({
        ...input,
        companyId: "company-2",
      }),
    ).toThrowError("runner_prp_authority_not_active");
    expect(() =>
      queueRunnerPrpRuntimeRequestResolution({
        ...input,
        resolution: { action: "decline" },
      }),
    ).toThrowError(RunnerPrpRuntimeRequestResolutionError);

    expect(() =>
      queueRunnerPrpRuntimeRequestResolution({
        ...input,
        actor: {
          type: "user",
          userId: "ordinary-member",
          isInstanceAdmin: false,
        },
      }),
    ).toThrowError("native_runtime_request_resolver_denied");
    for (const pendingRequest of [
      { ...input.pendingRequest, companyId: "company-2" },
      { ...input.pendingRequest, runId: "00000000-0000-4000-8000-000000000783" },
    ]) {
      expect(() => queueRunnerPrpRuntimeRequestResolution({
        ...input,
        pendingRequest,
      })).toThrowError("runner_prp_authority_not_active");
    }
    expect(queueCommand).toHaveBeenCalledTimes(1);

    await registration.release();
    expect(() => queueRunnerPrpRuntimeRequestResolution(input)).toThrowError(
      "runner_prp_authority_not_active",
    );
    server.close();
  });

  it.each([false, true])(
    "rejects a retained old route after real authority rotation (cached=%s)",
    async (cached) => {
      const directory = mkdtempSync(join(tmpdir(), "runner-route-rotation-"));
      const server = createBoundServer(3214);
      const identity = {
        runnerInstanceId: "runner-route-test",
        environmentLeaseId: "environment-route-test",
        normalizedSessionId: "session-route-test",
        runId: "00000000-0000-4000-8000-000000000781",
        turnId: "turn-route-old",
        itemId: "item-route-old",
      };
      const nextIdentity = {
        ...identity,
        runId: "00000000-0000-4000-8000-000000000782",
        turnId: "turn-route-new",
        itemId: "item-route-new",
      };
      try {
        const authority = new DurablePrpControlPlane({
          stateDirectory: directory,
          identity,
          expectedRunnerVersion: "0.3.0",
          expectedRunnerDigest: `sha256:${"a".repeat(64)}`,
        });
        const oldRoute = await registerRunnerPrpAuthority({
          companyId: "company-1",
          runId: identity.runId,
          authority,
        });
        // Warm attach registers the next route before rotating the same core.
        const nextRoute = await registerRunnerPrpAuthority({
          companyId: "company-1",
          runId: nextIdentity.runId,
          authority,
        });
        const input = {
          companyId: "company-1",
          runId: identity.runId,
          pendingRequest: {
            companyId: "company-1",
            runId: identity.runId,
            requestId: "request-old",
            requestKind: "command_approval" as const,
            turnId: "provider-turn-old",
            resolverPolicy: "instance_admin" as const,
          },
          actor: {
            type: "user" as const,
            userId: "instance-admin",
            isInstanceAdmin: true,
          },
          resolution: { action: "accept" as const },
        };
        const nextInput = {
          ...input,
          runId: nextIdentity.runId,
          pendingRequest: {
            ...input.pendingRequest,
            runId: nextIdentity.runId,
            requestId: "request-new",
            turnId: "provider-turn-new",
          },
        };
        // Registering the future URL cannot dispatch into the old authority.
        expect(() =>
          queueRunnerPrpRuntimeRequestResolution(nextInput),
        ).toThrowError(
          "runner_prp_authority_not_active",
        );
        expect(authority.store.state.commands).toEqual([]);
        if (cached) {
          const queued = queueRunnerPrpRuntimeRequestResolution(input);
          const command = authority.store.state.commands.find(
            (candidate) => candidate.commandId === queued.commandId,
          )!;
          // Represent a completed old response before the warm attachment.
          command.status = "completed";
          command.result = { status: "completed" };
        }
        authority.rotateRunIdentity(nextIdentity);
        expect(authority.store.state.identity).toEqual(nextIdentity);
        expect(authority.store.state.commands).toEqual([]);
        const statePath = join(directory, "control-plane-state.json");
        const before = readFileSync(statePath, "utf8");

        expect(() => queueRunnerPrpRuntimeRequestResolution(input)).toThrowError(
          "runner_prp_authority_not_active",
        );
        expect(authority.store.state.commands).toEqual([]);
        expect(readFileSync(statePath, "utf8")).toBe(before);

        const next = queueRunnerPrpRuntimeRequestResolution(nextInput);
        expect(queueRunnerPrpRuntimeRequestResolution(nextInput)).toEqual(next);
        expect(authority.store.state.commands).toHaveLength(1);
        expect(authority.store.state.commands[0]).toMatchObject({
          commandId: next.commandId,
          type: "request.resolve",
          payload: { requestId: "request-new", turnId: "provider-turn-new" },
        });
        await oldRoute.release();
        expect(
          runnerPrpWebSocketInternals.activeRegistration({
            companyId: "company-1",
            runId: nextIdentity.runId,
          }),
        ).toBe(true);
        await nextRoute.release();
      } finally {
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
