import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotatePriorDiagnostic } from "./durable-prp-control-plane.js";

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe("rotatePriorDiagnostic", () => {
  it("keeps a previous generation's runnerd stderr instead of erasing it", async () => {
    dir = await mkdtemp(join(tmpdir(), "runnerd-diag-"));
    const path = join(dir, "runnerd.stderr.log");
    await writeFile(path, "generation 1 crash reason\n");
    rotatePriorDiagnostic(path);
    const names = await readdir(dir);
    expect(names).not.toContain("runnerd.stderr.log");
    const rotated = names.filter(name => name.startsWith("runnerd.stderr.") && name.endsWith(".log"));
    expect(rotated).toHaveLength(1);
    expect(await readFile(join(dir, rotated[0]!), "utf8")).toBe("generation 1 crash reason\n");
  });
  it("does nothing for a missing or empty file", async () => {
    dir = await mkdtemp(join(tmpdir(), "runnerd-diag-"));
    const path = join(dir, "runnerd.stderr.log");
    rotatePriorDiagnostic(path);
    await writeFile(path, "");
    rotatePriorDiagnostic(path);
    expect(await readdir(dir)).toEqual(["runnerd.stderr.log"]);
  });
});
