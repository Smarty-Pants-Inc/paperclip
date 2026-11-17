import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({ limit: Infinity, fail: false, zero: false }));

// Exercise the real child pipes, capture and workspace file tools on hosts without
// bubblewrap. Only the sandbox launcher is replaced; containment is qualified by
// runner-bridge-tools.test.ts on a Linux host with /usr/bin/bwrap.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const writeSync: typeof fs.writeSync = (...args: any[]) => {
    if (writes.fail) throw new Error("ENOSPC output capture test");
    if (writes.zero) return 0;
    if (typeof args[3] === "number") args[3] = Math.min(args[3], writes.limit);
    return Reflect.apply(fs.writeSync, fs, args) as number;
  };
  return { ...fs, existsSync: (file: string) => file === "/usr/bin/bwrap" || fs.existsSync(file), writeSync };
});
vi.mock("node:child_process", async importOriginal => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return { ...childProcess, spawn: (program: string, args: string[], options: any) => {
    if (program !== "/usr/bin/bwrap") throw new Error("Expected the sandbox launcher");
    const command = args.slice(args.indexOf("--") + 1);
    return childProcess.spawn(command[0]!, command.slice(1), options);
  } };
});
import { executeWorkspaceTool } from "./runner-bridge-tools.js";

const roots: string[] = [];
afterEach(async () => {
  writes.limit = Infinity; writes.fail = false; writes.zero = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const authorize = async () => {};
async function run(script: string, timeoutMs = 10000) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-output-"));
  roots.push(directory);
  await writeFile(join(directory, "command.cjs"), script);
  const result = await executeWorkspaceTool(directory, "workspace_run", {
    program: process.execPath, args: ["command.cjs"], timeoutMs,
  }, authorize) as any;
  return { directory, result };
}
async function completeOutput(directory: string, result: any) {
  return typeof result.outputPath === "string" ? readFile(join(directory, result.outputPath)) : Buffer.from(result.output);
}

describe("workspace_run lossless output (real child pipes; launcher replaced)", () => {
  // Data-safety regression for Note 5 / E1: the old capture permanently lost
  // everything after 24,000 bytes, including both sentinels below.
  it("preserves all 200,000 bytes and the middle and final sentinels", async () => {
    const expected = Buffer.alloc(200000, "x");
    expected.write("E1_MIDDLE_SENTINEL", 150000);
    expected.write("E1_FINAL_SENTINEL", expected.length - "E1_FINAL_SENTINEL".length);
    const { directory, result } = await run(`const b = Buffer.alloc(200000, 'x'); b.write('E1_MIDDLE_SENTINEL', 150000); b.write('E1_FINAL_SENTINEL', b.length - 'E1_FINAL_SENTINEL'.length); process.stdout.write(b);`);
    expect(result.exitCode).toBe(0);
    const complete = await completeOutput(directory, result);
    expect({
      middle: complete.includes(Buffer.from("E1_MIDDLE_SENTINEL")),
      final: complete.includes(Buffer.from("E1_FINAL_SENTINEL")),
    }).toEqual({ middle: true, final: true });
    expect(complete).toEqual(expected);
    expect(result.output).not.toMatch(/\[truncated\]/i);
  });

  it("keeps a bounded head and tail and saves stdout and stderr beyond 16 MiB", async () => {
    const { directory, result } = await run(`const fs = require('node:fs'); fs.writeSync(1, 'START'); const b = Buffer.alloc(65536, 'x'); for (let i=0; i<272; i++) fs.writeSync(1, b); fs.writeSync(2, 'STDERR_END');`);
    expect(result.exitCode).toBe(0);
    expect(result.outputPath).toEqual(expect.any(String));
    expect(result.outputPath).not.toContain("/");
    expect((await stat(join(directory, result.outputPath))).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(result.output)).toBeLessThan(40000);
    expect(result.output).toContain("START");
    expect(result.output).toContain("STDERR_END");
    expect(result.output).toContain(result.outputPath);
    const complete = await completeOutput(directory, result);
    expect(complete.length).toBe(5 + 272 * 65536 + 10);
    expect(complete.subarray(0, 5).toString()).toBe("START");
    expect(complete.subarray(-10).toString()).toBe("STDERR_END");
    expect(complete.subarray(5, -10).every(byte => byte === 120)).toBe(true);
    // Large output is still accessible through the advertised command tool,
    // without relying on workspace_read's 16 MiB whole-file read limit.
    const read = await executeWorkspaceTool(directory, "workspace_run", {
      program: process.execPath, args: ["-e", `const fs=require('node:fs');const f=fs.openSync(process.argv[1],'r');const b=Buffer.alloc(10);fs.readSync(f,b,0,10,${complete.length - 10});process.stdout.write(b);`, result.outputPath],
    }, authorize) as any;
    expect(read.output).toBe("STDERR_END");
  });

  it("returns small Unicode output intact even when a character spans pipe writes", async () => {
    const { directory, result } = await run(`process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x8c,0x8d])), 50);`);
    expect(result.output).toBe("🌍");
    expect((await completeOutput(directory, result)).toString()).toBe("🌍");
  });

  it.each([0, 1, 16384, 16385, 32768, 32769, 65535])("preserves exactly %i bytes around preview boundaries", async size => {
    const { directory, result } = await run(`require('node:fs').writeSync(1, Buffer.alloc(${size}, 120));`);
    expect(await completeOutput(directory, result)).toEqual(Buffer.alloc(size, 120));
    if (size <= 32768) expect(result.output).toBe("x".repeat(size));
    expect(Buffer.byteLength(result.output)).toBeLessThan(40000);
  });

  it("keeps escaped control-character previews within the Runner wire budget", async () => {
    const { directory, result } = await run(`require('node:fs').writeSync(1, Buffer.alloc(500000, 0));`);
    expect(await completeOutput(directory, result)).toEqual(Buffer.alloc(500000, 0));
    const wire = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(500000);
  });

  it("handles short filesystem writes without losing bytes", async () => {
    writes.limit = 17;
    const { directory, result } = await run(`require('node:fs').writeSync(1, Buffer.alloc(200000, 120));`);
    expect(await completeOutput(directory, result)).toEqual(Buffer.alloc(200000, 120));
  });

  it.each(["fail", "zero"] as const)("stops and rejects instead of reporting successful output after a %s write", async mode => {
    writes[mode] = true;
    await expect(run(`process.stdout.write('OUTPUT');setTimeout(() => {}, 20000);`, 1000))
      .rejects.toThrow(mode === "fail" ? "ENOSPC" : "runner_workspace_output_write_failed");
    writes[mode] = false;
    const directory = roots.at(-1)!;
    const recovery = await executeWorkspaceTool(directory, "workspace_run", {
      program: process.execPath, args: ["-e", "process.stdout.write('RECOVERED')"],
    }, authorize) as any;
    expect(recovery.output).toBe("RECOVERED");
  });

  it("retains the output produced before a timeout", async () => {
    const { directory, result } = await run(`process.stdout.write('BEFORE_TIMEOUT'); setTimeout(() => {}, 20000);`, 500);
    expect(result.stopped).toBe("timeout");
    expect((await completeOutput(directory, result)).toString()).toBe("BEFORE_TIMEOUT");
  });
});
