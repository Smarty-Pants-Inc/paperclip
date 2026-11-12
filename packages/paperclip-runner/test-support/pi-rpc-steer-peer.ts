import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcTransport } from "../src/drivers/pi/pi-rpc-transport.js";

/** Real JSONL transport, controlled peer replaying the captured Pi 1.5.2 queue run.
 * get_messages is the test's release gate, not a new prompt or another agent run.
 * Only the steer slice is replayed: follow_up is not admitted by the executor.
 */
export function createPiSteerRecordingPeer(commandLog: string, disposition = "queued") {
  const fixture = fileURLToPath(new URL("../test-fixtures/pi-rpc/queue-1.5.2.jsonl", import.meta.url));
  const transport = new PiRpcTransport({
    command: process.execPath,
    cwd: process.cwd(),
    args: ["-e", `
      const { readFileSync, appendFileSync } = require("node:fs");
      const { createInterface } = require("node:readline");
      const wire = readFileSync(process.argv[1], "utf8").trim().split("\\n").map(JSON.parse);
      const log = process.argv[2];
      const disposition = JSON.parse(process.argv[3]);
      const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
      const response = (request, data) => emit({ id: request.id, type: "response", command: request.type, success: true, data });
      const firstQueue = wire.findIndex(event => event.type === "queue_update");
      const followUp = wire.findIndex(event => event.type === "message_start" && JSON.stringify(event.message).includes("followup-marker"));
      let end = followUp;
      while (wire[end].type !== "turn_start") end--;
      const consumption = wire.slice(firstQueue + 1, end).filter(event => event.type !== "response" && event.type !== "queue_update");
      let queued = false;
      createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        appendFileSync(log, JSON.stringify(request) + "\\n");
        if (request.type === "get_state") response(request, wire.find(event => event.command === "get_state").data);
        else if (request.type === "get_available_models") response(request, { models: [wire.find(event => event.command === "get_state").data.model] });
        else if (request.type === "set_model") response(request, wire.find(event => event.command === "set_model").data);
        else if (request.type === "get_available_thinking_levels") response(request, { levels: ["off"] });
        else if (request.type === "set_thinking_level") response(request);
        else if (request.type === "prompt" && request.message === "scenario:queue") {
          response(request, { disposition: "started" });
          wire.slice(0, firstQueue).filter(event => event.type !== "response").forEach(emit);
        } else if (request.type === "steer" && request.message === "steering-marker") {
          queued = disposition === "queued";
          emit(wire[firstQueue]);
          response(request, { disposition });
        } else if (request.type === "get_messages") {
          response(request, { messages: [] });
          (queued ? consumption : consumption.slice(0, consumption.findIndex(event => event.type === "turn_start"))).forEach(emit);
          emit(wire.find(event => event.type === "agent_settled"));
        } else emit({ id: request.id, type: "response", command: request.type, success: false, error: "Unexpected recording peer command" });
      }).on("close", () => process.exit(0));
    `, fixture, commandLog, JSON.stringify(disposition)],
    shutdownTimeoutMs: 250,
    killTimeoutMs: 250,
  });
  return {
    transport,
    driverOptions: {
      model: "paperclip/neutral/vendor-model-not-in-bundled-catalog",
      piRpcThinkingLevel: "off" as const,
      environment: { PI_CODING_AGENT_DIR: join(dirname(commandLog), "agent") },
      transportFactory: () => transport,
    },
    async releaseConsumption() { await transport.request("get_messages"); },
    async commands(): Promise<Array<{ type: string; message?: string }>> {
      return (await readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
  };
}
