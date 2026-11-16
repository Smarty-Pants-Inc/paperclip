import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Keep reason: data safety + event/checkpoint availability. N-1 caused a V8
// regexp stack overflow on actual output-shaped fields; isolate RED probes.
const inputsAt = (bytes: number) => [
  { name: "complete PEM (tempered framing repetition)", text: `-----BEGIN PRIVATE KEY-----\n${"Ab9/".repeat(bytes / 4)}\n-----END PRIVATE KEY-----` },
  { name: "complete PEM with dash-heavy contents", text: `-----BEGIN PRIVATE KEY-----\n${"-".repeat(bytes)}\n-----END PRIVATE KEY-----` },
  { name: "orphan BEGIN (body-line repetition)", text: `-----BEGIN PRIVATE KEY-----\n${("Ab9/".repeat(16) + "\n").repeat(Math.ceil(bytes / 65))}` },
  { name: "orphan BEGIN with long escaped separator", text: `-----BEGIN PRIVATE KEY-----${String.raw`\n`.repeat(bytes / 2)}${"Ab9/".repeat(16)}` },
  { name: "orphan END with long escaped separator", text: `${"Ab9/".repeat(16)}${String.raw`\n`.repeat(bytes / 2)}-----END PRIVATE KEY-----` },
  { name: "identity mark with escaped slashes", text: `***REDACTED***${String.raw`\/`.repeat(bytes / 2)}`, fast: true },
  { name: "identity mark with long base64", text: `***REDACTED***${"Ab9/".repeat(bytes / 4)}`, fast: true },
  { name: "escaped JSON assignment (quoted-value repetition)", text: `"KEY": "${String.raw`\x`.repeat(bytes / 2)}"` },
  { name: "escaped shell assignment (quoted-value repetition)", text: `KEY="${String.raw`\x`.repeat(bytes / 2)}"` },
];

describe.each([4, 8, 16])("secret-shape %i MiB stack safety", mib => {
  it.for(inputsAt(mib * 1024 * 1024))("returns safely and leaks nothing: $name", ({ name, text, fast }) => {
    const moduleUrl = new URL("./secret-shapes.ts", import.meta.url).href;
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { redactSecretShapes } from ${JSON.stringify(moduleUrl)};
      const input = readFileSync(0, 'utf8');
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const output = redactSecretShapes(input);
        samples.push(performance.now() - start);
        if (!/^(?:\\*{3}REDACTED\\*{3})?(?:\\[REDACTED:(?:pem|unscannable)\\]|(?:"KEY": "|KEY=")\\[REDACTED:assignment\\]")\\s*$/.test(output)) {
          throw new Error('field was not completely masked: output length ' + output.length);
        }
        if (redactSecretShapes(output) !== output) throw new Error('not idempotent');
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ medianMs: samples[1], samples }));
    `], { input: text, encoding: "utf8", timeout: 15_000 });
    expect(probe.error, name).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const timing = JSON.parse(probe.stdout);
    console.info(`${name}: ${text.length} bytes, ${JSON.stringify(timing)}`);
    if (mib === 4 && fast) expect(timing.medianMs, name).toBeLessThan(100);
  });
});
