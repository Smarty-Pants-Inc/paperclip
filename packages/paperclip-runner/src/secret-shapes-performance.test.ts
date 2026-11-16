import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { secretShapePerformanceInputs } from "./secret-shapes-performance.test-fixture.js";

// Keep reason: data safety / event-loop availability at the server output trust
// boundary. Isolate RED so a quadratic regexp cannot hang the test coordinator.
describe("secret-shape 1 MiB adversarial budget", () => {
  it.for(secretShapePerformanceInputs)("finishes $name in less than 100 ms", ({ name, text }) => {
    const moduleUrl = new URL("./secret-shapes.ts", import.meta.url).href;
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { redactSecretShapes } from ${JSON.stringify(moduleUrl)};
      const input = readFileSync(0, 'utf8');
      const start = performance.now();
      redactSecretShapes(input);
      console.log(performance.now() - start);
    `], { input: text, encoding: "utf8", timeout: 2_000 });
    expect(probe.error, `${name}: isolated probe exceeded 2 seconds`).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const elapsedMs = Number(probe.stdout.trim());
    expect(Number.isFinite(elapsedMs)).toBe(true);
    console.info(`${name}: ${text.length} bytes, ${elapsedMs.toFixed(3)} ms`);
    expect(elapsedMs, name).toBeLessThan(100);
  });
});
