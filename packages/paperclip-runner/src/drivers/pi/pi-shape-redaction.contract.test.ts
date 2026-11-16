import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistant, attrs, createPiObservabilityTest, spans, terminal, tool } from "./pi-observability.test-fixture.js";
import { fakePemBody, shapeAssignments, shapeNegatives, shapePems, shapeTokens } from "./pi-shape-redaction.test-fixture.js";

type Capture = ReturnType<typeof createPiObservabilityTest>;
let capture: Capture;
beforeEach(() => { capture = createPiObservabilityTest(); vi.stubGlobal("fetch", capture.transport); });
afterEach(async () => { try { await capture.close(); } finally { vi.unstubAllGlobals(); } });

const surfaces = ["result", "answer", "args", "prompt", "error"] as const;
async function exportText(surface: typeof surfaces[number], value: string) {
  const pi = await capture.openPi();
  try {
    await pi.start(surface === "prompt" ? `safe prompt ${value}` : undefined);
    const args = { command: surface === "args" ? `safe command ${value}` : "safe command" };
    const records = tool("shape", "bash", ["result", "error"].includes(surface) ? `safe result ${value}` : "safe result", args);
    if (surface === "error") records[1]!.isError = true;
    pi.peer.send(...assistant("shape", { tool: "bash", args, text: surface === "answer" ? `safe answer ${value}` : "safe answer" }), ...records, ...terminal);
    await pi.settled();
  } finally { await pi.close(); }
  expect(capture.transport).toHaveBeenCalledOnce();
  // Prove the requested field was actually exported, not dropped by the fixture.
  const field = surface === "prompt" ? attrs(spans(capture.bodies)[0])["langfuse.observation.input"]
    : surface === "answer" ? attrs(spans(capture.bodies)[0])["langfuse.observation.output"]
      : surface === "args" ? spans(capture.bodies).find(span => span.name.startsWith("tool "))?.name
        : attrs(spans(capture.bodies).find(span => span.name.startsWith("tool ")))["langfuse.observation.output"];
  expect(field).toContain(`safe ${surface === "error" ? "result" : surface === "args" ? "command" : surface}`);
  return capture.bodies.map(body => JSON.stringify(body));
}

describe("SHAPE: unknown values through the real Pi sink", () => {
  for (const surface of surfaces) {
    it.for(shapeTokens)(`${surface}: redacts $kind ($value)`, async ({ kind, value }) => {
      const bodies = await exportText(surface, value);
      for (const wire of bodies) {
        expect(wire).not.toContain(value);
        if (kind === "bearer") expect(wire).not.toContain(value.slice("Bearer ".length));
        expect(wire.includes(`[REDACTED:${kind}]`) || wire.includes("[REDACTED]")).toBe(true);
      }
    });
    it.for(shapeAssignments)(`${surface}: redacts assignment $value and retains its name`, async ({ value, secret, retained }) => {
      const bodies = await exportText(surface, value);
      for (const wire of bodies) {
        expect(wire).not.toContain(secret);
        expect(wire).toMatch(/\[REDACTED(?::assignment)?\]/);
      }
      expect(JSON.stringify(capture.bodies)).toContain(JSON.stringify(retained).slice(1, -1));
    });
    it.for(shapePems)(`${surface}: redacts unknown PEM $label including its body`, async ({ value, label }) => {
      const bodies = await exportText(surface, value);
      for (const wire of bodies) {
        expect(wire).not.toMatch(/-----BEGIN .*PRIVATE KEY-----|-----END .*PRIVATE KEY-----/);
        for (let offset = 0; offset + 64 <= fakePemBody.length; offset++) expect(wire, `${label}: body window ${offset}`).not.toContain(fakePemBody.slice(offset, offset + 64));
        expect(wire).toContain("[REDACTED:pem]");
      }
    });
    it.for(shapeNegatives)(`${surface}: preserves ordinary text %s`, async value => {
      await exportText(surface, value);
      expect(JSON.stringify(capture.bodies)).toContain(JSON.stringify(value).slice(1, -1));
    });
  }
  it("redacts before truncation, including a block straddling the 8 KiB boundary", async () => {
    const value = `${"ordinary output ".repeat(505)}${shapePems[0]!.value}`;
    await exportText("result", value);
    expect(JSON.stringify(capture.bodies)).not.toContain("-----BEGIN");
    expect(JSON.stringify(capture.bodies)).toContain("[REDACTED:pem]");
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, "shape-truncation-otlp.json"), JSON.stringify(capture.bodies, null, 2));
  });
  it("retains existing redaction marks unchanged", async () => {
    const value = 'TOOL_KEY=[REDACTED] "privateMaterial": "[REDACTED:github]" TOOL_KEY=***REDACTED***';
    await exportText("answer", value);
    expect(attrs(spans(capture.bodies)[0])["langfuse.observation.output"]).toBe(`safe answer ${value}`);
  });
});
