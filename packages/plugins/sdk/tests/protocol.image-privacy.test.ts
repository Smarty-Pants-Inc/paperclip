// Keep: data safety when parse errors escape a worker/host error sink (R1).
import { describe, expect, it } from "vitest";
import { JsonRpcParseError, parseMessage } from "../src/protocol.js";

const data = Buffer.from("private malformed frame bytes: never preview this").toString("base64");
const frame = { jsonrpc: "2.0", id: 1, result: { mcpContent: [{ type: "image", data, mimeType: "image/png" }] } };

describe("protocol parse error privacy", () => {
  it.each([
    JSON.stringify(frame).slice(0, -1),
    JSON.stringify({ ...frame, jsonrpc: `data:image/png;base64,${data}` }),
    JSON.stringify({ ...frame, jsonrpc: { image: data } }),
  ])("does not echo any payload fragment in a surfaced parse error", line => {
    let error: unknown;
    try { parseMessage(line); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(JsonRpcParseError);
    const surfaced = String(error);
    expect({ body: surfaced.includes(data), fragment: surfaced.includes(data.slice(0, 16)), dataUrl: surfaced.includes("data:image/") })
      .toEqual({ body: false, fragment: false, dataUrl: false });
  });
});
