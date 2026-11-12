import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { NATIVE_EXECUTION_INPUT_SCHEMA, NATIVE_EXECUTION_INPUT_SCHEMA_V7, NATIVE_EXECUTION_INPUT_SCHEMA_V9, NATIVE_EXECUTION_INPUT_SCHEMA_V10 } from "../contracts/native-execution.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import { PiRpcDriver, type PiRpcDriverOptions } from "../drivers/pi/pi-rpc-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import { nativeSystemInstructions, nativeTaskConstraints } from "./runtime-context.js";

export function createPiNativeSessionBackend(
  input: NativeExecutionInput,
  options: Omit<PiRpcDriverOptions, "model" | "taskEnvelope">,
): NativeSessionBackend {
  if (input.provider.kind !== "pi_rpc" || !input.provider.model) {
    throw new Error("Pi native backend requires a persisted Pi provider/model selection");
  }
  const preparedContext = input.schema === NATIVE_EXECUTION_INPUT_SCHEMA
    || input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V7
    || input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V9 || input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V10;
  const constraints = nativeTaskConstraints(input);

  return new HarnessDriverBackend(new PiRpcDriver({
    ...options,
    systemInstructions: nativeSystemInstructions(input),
    runtimeContext: "runtimeContext" in input ? input.runtimeContext : null,
    model: input.provider.model,
    permissionMode: "allow",
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints,
    }),
    conversationMode: preparedContext ? "prepared" : "task",
  }), preparedContext ? constraints : undefined);
}
