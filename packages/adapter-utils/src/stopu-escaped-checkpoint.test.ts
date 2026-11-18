/**
 * adopt-stopu-escaped (RFL 01:00Z): the SPARSE checkpoint copy (the export path a
 * provider with native syncOut takes when the box has node:sqlite;
 * sandbox-managed-runtime.ts restoreWorkspace, workspaceCheckpointScript) run on
 * the box directory while an escaped writer keeps rewriting the same F.
 * Records per attempt: capture refused (changed during capture/copy) or the
 * payload's F (base / turn edit / one whole writer version / TORN).
 */
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";
import { writeCheckpointBaseline, workspaceCheckpointScript } from "./workspace-checkpoint.js";

const execute = promisify(execFile);
const CHUNK = 16 * 1024, CHUNKS = 32;
const BASE = "base contents\n", EDIT = "edited on the box by the stopped turn\n";
const WRITER = `import os, sys
path, mode, counter = sys.argv[1], sys.argv[2], sys.argv[3]
CH, N = ${CHUNK}, ${CHUNKS}
n = 0
while True:
    n += 1
    chunk = (("v%08d\\n" % n) * (CH // 10 + 1)).encode()[:CH]
    if mode == "atomic":
        tmp = path + ".writer-tmp"
        with open(tmp, "wb") as f:
            for _ in range(N): f.write(chunk); f.flush()
        os.rename(tmp, path)
    else:
        f = open(path, "r+b" if mode == "inplace" and os.path.exists(path) else "wb")
        for _ in range(N): f.write(chunk); f.flush()
        f.truncate(); f.close()
    with open(counter + ".tmp", "w") as c: c.write(str(n))
    os.rename(counter + ".tmp", counter)
`;
function classifyF(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (text === BASE) return "base";
  if (text === EDIT) return "turn_edit";
  if (bytes.length === CHUNK * CHUNKS) {
    const first = bytes.subarray(0, CHUNK);
    const match = /^v(\d{8})\n/.exec(first.subarray(0, 10).toString("utf8"));
    let whole = Boolean(match);
    for (let i = 1; whole && i < CHUNKS; i++) whole = first.equals(bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
    if (whole && match) return "writer_whole";
  }
  return `TORN(len=${bytes.length})`;
}
const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each(["inplace", "truncate", "atomic"] as const)("checkpoint copy vs escaped %s writer: never a torn F in an accepted payload", async (mode) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stopu-escaped-cp-"));
  roots.push(temp);
  const box = path.join(temp, "box");
  await fs.mkdir(box);
  await fs.writeFile(path.join(box, "task.txt"), BASE);
  const baseline = await captureDirectorySnapshot(box, { diskBacked: true, exclude: [] });
  const manifest = path.join(temp, "baseline.sqlite");
  await writeCheckpointBaseline(baseline, manifest);
  await disposeDirectorySnapshot(baseline);
  const script = path.join(temp, "checkpoint.mjs");
  await fs.writeFile(script, workspaceCheckpointScript());
  await fs.writeFile(path.join(box, "task.txt"), EDIT);
  const writerScript = path.join(temp, "writer.py"), counter = path.join(temp, "count");
  await fs.writeFile(writerScript, WRITER);
  const child = spawn("python3", [writerScript, path.join(box, "task.txt"), mode, counter], { detached: true, stdio: "ignore" });
  child.unref(); pids.push(child.pid!);
  for (let i = 0; i < 400; i++) { try { if (Number(readFileSync(counter, "utf8")) >= 3) break; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 25)); }
  const tally: Record<string, number> = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const output = path.join(temp, `out-${attempt}`);
    let outcome: string;
    try {
      await execute(process.execPath, [script, box, manifest, output, "[]"], { timeout: 30_000 });
      outcome = `accepted:${classifyF(await fs.readFile(path.join(output, "payload", "task.txt")).catch(() => Buffer.from("<absent>")))}`;
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? error);
      outcome = `refused:${/Workspace changed during checkpoint (capture|copy)/.exec(message)?.[0] ?? message.slice(0, 120)}`;
    }
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  console.info(`[adopt-stopu-escaped checkpoint ${mode}] ${JSON.stringify(tally)}`);
  if (process.env.ESCAPED_RECORDS) await fs.appendFile(process.env.ESCAPED_RECORDS, `${JSON.stringify({ path: "checkpoint", mode, tally })}\n`);
  expect(Object.keys(tally).filter(key => key.startsWith("accepted:TORN"))).toEqual([]);
}, 120_000);
