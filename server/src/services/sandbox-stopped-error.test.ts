import { expect, it } from "vitest";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { findSandboxStoppedError, isStoppedSandboxCommandRejection, isStoppedSandboxSyncRejection, SandboxStoppedError } from "./sandbox-stopped-error.js";

const stopped = "Boat POST /sandboxes/bx_1/commands failed (409): Sandbox bx_1 is stopped. Run `boat resume bx_1`, then retry.";
const rpc = (message: string) => new JsonRpcCallError({ code: -32000, message });

it("recognizes only the exact rejected Boat allocation's command RPC", () => {
  expect(isStoppedSandboxCommandRejection(rpc(stopped), "bx_1")).toBe(true);
  for (const error of [
    new Error(stopped),
    rpc(stopped.replace("(409)", "(502)")),
    rpc(stopped.replace("/commands", "/commands/process_1")),
    rpc(stopped.replace("Sandbox bx_1", "Sandbox bx_other")),
    rpc(stopped.replace("is stopped", "is stopping")),
    rpc(`Command output: ${stopped}`),
    rpc("Request timed out"),
    rpc("Conflict (409): lease is stopped"),
  ]) expect(isStoppedSandboxCommandRejection(error, "bx_1")).toBe(false);
  expect(isStoppedSandboxCommandRejection(rpc(stopped), "bx_other")).toBe(false);
});

it("recognizes the exact allocation's stopped file-transfer refusals", () => {
  for (const route of ["PUT /sandboxes/bx_1/files", "POST /sandboxes/bx_1/files/upload-url", "POST /sandboxes/bx_1/commands"]) {
    expect(isStoppedSandboxSyncRejection(rpc(stopped.replace("POST /sandboxes/bx_1/commands", route)), "bx_1")).toBe(true);
  }
  for (const error of [
    new Error(stopped.replace("/commands", "/files")),
    rpc(stopped.replace("/commands", "/files").replace("(409)", "(502)")),
    rpc(stopped.replace("/commands", "/files?path=x")),
    rpc(stopped.replace("Sandbox bx_1", "Sandbox bx_other")),
    rpc(stopped.replace("is stopped", "is stopping")),
    rpc("Boat upload upload failed (409)"),
    rpc(`Command output: ${stopped}`),
  ]) expect(isStoppedSandboxSyncRejection(error, "bx_1")).toBe(false);
});

it("finds the typed failure through cause wrappers, not forged message text", () => {
  const failure = new SandboxStoppedError("still_stopped", rpc(stopped));
  expect(findSandboxStoppedError(new Error("runner process failed", { cause: failure }))).toBe(failure);
  expect(findSandboxStoppedError(new Error(failure.message))).toBeNull();
  const circular = new Error("outer");
  circular.cause = circular;
  expect(findSandboxStoppedError(circular)).toBeNull();
});
