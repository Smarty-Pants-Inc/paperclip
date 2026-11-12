import type { HarnessDriver, HarnessDriverDescriptor, HarnessSession, OpenHarnessSessionInput } from "../../contracts/harness-driver.js";
import type { OpenCodeServerDriverOptions } from "../opencode/opencode-server-driver.js";

/** Exact native OpenCode options seam; code-lead replaces this file's body. */
export type PiRpcDriverOptions = OpenCodeServerDriverOptions;
export class PiRpcDriver implements HarnessDriver {
  constructor(readonly options: PiRpcDriverOptions) {}
  async descriptor(): Promise<HarnessDriverDescriptor> {
    throw new Error("pi_rpc_driver_not_integrated: native Pi RPC driver body is required");
  }
  async openSession(_input: OpenHarnessSessionInput): Promise<HarnessSession> {
    throw new Error("pi_rpc_driver_not_integrated: refusing an unimplemented native Pi RPC session");
  }
}
