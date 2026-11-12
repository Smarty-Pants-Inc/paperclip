import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piCompanySkillsAgentHome, syncPiCompanySkills } from "./pi-company-skills.js";

const allocated: string[] = [];
afterEach(async () => { for (const root of allocated.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-company-skills-")); allocated.push(root);
  const home = join(root, "agent"), bundle = join(root, "external-bundle");
  await mkdir(bundle); await mkdir(join(home, "skills", "existing"), { recursive: true });
  const content = "---\nname: company-original\ndescription: Original admitted skill.\n---\nDo not rewrite this body.\n";
  await writeFile(join(bundle, "SKILL.md"), content);
  await writeFile(join(home, "skills", "existing", "SKILL.md"), "existing skill");
  await mkdir(join(home, "extensions")); await writeFile(join(home, "extensions", "native.ts"), "existing extension");
  return { root, home, bundle, content, namespace: join(home, "skills", "paperclip-company-skills") };
}
const context = (...roots: string[]) => ({ skills: roots.map(rootPath => ({ bundle: { rootPath } })) });

describe("Pi admitted company skills (trust boundary and data safety)", () => {
  it("links exact external bundle bytes, deduplicates, refreshes only owned symlinks and preserves home", async () => {
    const f = await fixture();
    await syncPiCompanySkills(f.home, context(f.bundle, f.bundle));
    const links = (await readdir(f.namespace)).filter(name => name.startsWith("bundle-"));
    expect(links).toHaveLength(1);
    const link = join(f.namespace, links[0]!);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(f.bundle);
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(f.content);
    await syncPiCompanySkills(f.home, context(f.bundle));
    await writeFile(join(f.namespace, "unmanaged.md"), "untouched");
    await syncPiCompanySkills(f.home, context());
    expect(await readdir(f.namespace)).toEqual([".owner", "unmanaged.md"]);
    expect(await readFile(join(f.bundle, "SKILL.md"), "utf8")).toBe(f.content);
    expect(await readFile(join(f.home, "skills", "existing", "SKILL.md"), "utf8")).toBe("existing skill");
    expect(await readFile(join(f.home, "extensions", "native.ts"), "utf8")).toBe("existing extension");
  });

  it("validates every selected root before changing an existing selection", async () => {
    const f = await fixture(); await syncPiCompanySkills(f.home, context(f.bundle));
    const before = await readdir(f.namespace);
    await writeFile(join(f.root, "SKILL.md"), f.content);
    for (const invalid of ["relative", "/", join(f.root, "missing"), `${f.root}/../escape`, "\0", f.root]) {
      await expect(syncPiCompanySkills(f.home, context(f.bundle, invalid))).rejects.toThrow();
      expect(await readdir(f.namespace)).toEqual(before);
    }
    for (const invalid of [{ skills: {} }, { skills: [{}] }, { skills: [{ bundle: {} }] }]) {
      await expect(syncPiCompanySkills(f.home, invalid)).rejects.toThrow();
    }
  });

  it("refuses escaped SKILL.md symlinks and never removes a real managed-name directory", async () => {
    const f = await fixture(); const unsafe = join(f.root, "unsafe"); await mkdir(unsafe);
    await symlink(join(f.bundle, "SKILL.md"), join(unsafe, "SKILL.md"));
    await expect(syncPiCompanySkills(f.home, context(unsafe))).rejects.toThrow();
    await syncPiCompanySkills(f.home, context());
    const name = `bundle-${createHash("sha256").update(f.bundle).digest("hex")}`;
    await mkdir(join(f.namespace, name)); await writeFile(join(f.namespace, name, "keep"), "safe");
    await expect(syncPiCompanySkills(f.home, context(f.bundle))).rejects.toThrow("not a symlink");
    expect(await readFile(join(f.namespace, name, "keep"), "utf8")).toBe("safe");
  });

  it("refuses an unowned namespace or redirected discovery directory", async () => {
    const f = await fixture(); await mkdir(f.namespace);
    await expect(syncPiCompanySkills(f.home, context(f.bundle))).rejects.toThrow();
    const other = join(f.root, "other-agent"); await mkdir(other);
    await symlink(join(f.home, "skills"), join(other, "skills"), "dir");
    await expect(syncPiCompanySkills(other, context(f.bundle))).rejects.toThrow("symlink");
  });

  it("selects the supplied native home or documented HOME fallback without a private override", () => {
    expect(piCompanySkillsAgentHome({ PI_CODING_AGENT_DIR: "/selected/agent", HOME: "/native" })).toBe("/selected/agent");
    expect(piCompanySkillsAgentHome({ HOME: "/native" })).toBe("/native/.pi/agent");
    // Empty values are errors, not an invented fresh private home.
    expect(() => piCompanySkillsAgentHome({ PI_CODING_AGENT_DIR: "" })).toThrow();
  });
});
