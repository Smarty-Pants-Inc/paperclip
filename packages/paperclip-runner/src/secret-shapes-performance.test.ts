import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { judgeSecretShapePerformanceInputsAt, secretShapePerformanceInputsAt } from "./secret-shapes-performance.test-fixture.js";

// Keep reason: data safety / event-loop availability at the server output trust
// boundary. Isolate RED so a quadratic regexp cannot hang the test coordinator.
// The 100 ms budget covers the original corpus and explicit identity rows,
// not every possible input. Judge-shaped assignment rows use 250 ms/MiB.
// Use the median of three scans per input to tolerate one scheduler interruption.
describe.each([1, 4])("secret-shape %i MiB adversarial budget", mib => {
  it.for([...secretShapePerformanceInputsAt(mib * 1024 * 1024).map(row => ({ ...row, budgetMs: 100 })),
    ...judgeSecretShapePerformanceInputsAt(mib * 1024 * 1024)])("finishes $name within its committed-input budget", ({ name, text, budgetMs }) => {
    const moduleUrl = new URL("./secret-shapes.ts", import.meta.url).href;
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { redactSecretShapes } from ${JSON.stringify(moduleUrl)};
      const input = readFileSync(0, 'utf8');
      const samples = Array.from({ length: 3 }, () => {
        const start = performance.now();
        redactSecretShapes(input);
        return performance.now() - start;
      }).sort((a, b) => a - b);
      console.log(samples[1]);
    `], { input: text, encoding: "utf8", timeout: 5_000 });
    expect(probe.error, `${name}: isolated probe exceeded 5 seconds`).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const elapsedMs = Number(probe.stdout.trim());
    expect(Number.isFinite(elapsedMs)).toBe(true);
    console.info(`${name}: ${text.length} bytes, ${elapsedMs.toFixed(3)} ms`);
    if (budgetMs === 100) expect(elapsedMs, name).toBeLessThan(100);
    else expect(elapsedMs, `${name}: explicit linear assignment budget`).toBeLessThan(budgetMs);
  });
});
