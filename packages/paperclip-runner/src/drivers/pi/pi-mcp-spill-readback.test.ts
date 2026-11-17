import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piProcessEnvironment } from "./pi-rpc-driver.js";

// B7 (pack-n5): Pi's own MCP 20 KiB model-facing spill is upstream Pi and is
// kept. Our runner must let the agent read the spilled file back on the box:
// the Pi child inherits the runner's TMPDIR (where Pi writes the spill) and
// Pi's real read tool, rooted at a different workspace, pages it back whole.
const piRoot = realpathSync(new URL("../../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const scratch: string[] = [];
const savedTmp = process.env.TMPDIR;
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("B7 Pi MCP spill file is readable by the agent's read tool", () => {
  it("spills a 100 KiB MCP text result and reads it back byte-equal with paged reads", async () => {
    const runnerTmp = await mkdtemp(join(tmpdir(), "pn5-runner-tmp-"));
    const workspace = await mkdtemp(join(tmpdir(), "pn5-workspace-"));
    scratch.push(runnerTmp, workspace);
    process.env.TMPDIR = runnerTmp;
    // The environment the runner gives the Pi child carries the same TMPDIR.
    expect(piProcessEnvironment().TMPDIR).toBe(runnerTmp);

    const { createReadTool } = await import(join(piRoot, "dist/index.js"));
    const { saveToTempFile } = await import(join(piRoot, "dist/extensions/mcp/tools.js"));
    const { limitMcpContent } = await import(join(dirname(piRoot), "pi-mcp/dist/index.js"));
    const original = Array.from({ length: 2400 }, (_, i) => `row ${i} ${"é🦀x".repeat(10)} ${"y".repeat(i % 17)}`).join("\n");
    expect(Buffer.byteLength(original)).toBeGreaterThan(100 * 1024);

    const limited = await limitMcpContent([{ type: "text", text: original }], saveToTempFile);
    const path: string = limited.fullOutputPath;
    expect(path).toBeTruthy();
    expect(dirname(path)).toBe(runnerTmp);
    expect(limited.content[0].text).toContain(`[Full output: ${path} (read it with offset/limit)]`);
    expect(await readFile(path, "utf8")).toBe(original);

    const read = createReadTool(workspace);
    const lines: string[] = [];
    let offset: number | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await read.execute(`read-${page}`, { path, ...(offset ? { offset } : {}) });
      const text: string = result.content[0].text;
      const next = /\n\n\[Showing lines (\d+)-(\d+) of (\d+)[^\]]*Use offset=(\d+) to continue\.\]$/u.exec(text);
      lines.push(...(next ? text.slice(0, next.index) : text).split("\n"));
      if (!next) break;
      offset = Number(next[4]);
    }
    expect(lines.join("\n")).toBe(original);
  });
});
