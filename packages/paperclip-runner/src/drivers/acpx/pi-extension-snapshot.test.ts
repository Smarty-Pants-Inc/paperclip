import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyOwnedNodeRuntime } from "../../test-support/owned-node-runtime.js";
import { verifyNativeAcpxInstallation } from "./installation-integrity.js";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredEnvironmentProjection } from "../../configured-environment.js";
import { configuredPiExtensions, createPiExtensionSnapshot } from "./pi-extension-snapshot.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-extra-test-"))); temporary.push(root);
  await mkdir(join(root, "package"));
  await writeFile(join(root, "package", "package.json"), JSON.stringify({ name: "test-extension", pi: { extensions: ["./index.ts"] } }));
  await writeFile(join(root, "package", "index.ts"), "export default () => {};\n");
  return root;
}

describe("explicit Pi extension snapshots (trust boundary)", () => {
  it("accepts only controller-configured bounded absolute paths, not ambient environment", () => {
    expect(configuredPiExtensions(undefined)).toEqual([]);
    expect(configuredPiExtensions({ PAPERCLIP_PI_EXTENSIONS: '["/ambient.ts"]' })).toEqual([]);
    expect(configuredPiExtensions(configuredEnvironmentProjection({ PAPERCLIP_PI_EXTENSIONS: '["/opt/pi/tool.ts"]' }))).toEqual(["/opt/pi/tool.ts"]);
    for (const raw of ['{}', '["relative.ts"]', '["/opt/../escape.ts"]', '["/"]', '[null]', 'not-json', JSON.stringify(Array(33).fill("/a"))]) {
      expect(() => configuredPiExtensions(configuredEnvironmentProjection({ PAPERCLIP_PI_EXTENSIONS: raw }))).toThrow("Pi extensions");
    }
  });

  it("freezes a local file and a package directory with all declared dependency bytes", async () => {
    const root = await fixture();
    await mkdir(join(root, "tools"));
    await writeFile(join(root, "tools", "cap.ts"), "export default () => {};\n");
    await mkdir(join(root, "package", "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "package", "node_modules", "dependency", "index.js"), "export const value = 42;\n");
    const admitted = await createPiExtensionSnapshot([join(root, "tools", "cap.ts"), join(root, "package")]);
    try {
      expect(admitted.paths).toHaveLength(2);
      expect(await readFile(admitted.paths[0]!, "utf8")).toBe("export default () => {};\n");
      const dependency = join(admitted.paths[1]!, "node_modules", "dependency", "index.js");
      expect(admitted.snapshot.digests[dependency]).toBe(createHash("sha256").update(await readFile(dependency)).digest("hex"));
      await writeFile(join(root, "tools", "cap.ts"), "changed source");
      expect(await readFile(admitted.paths[0]!, "utf8")).toBe("export default () => {};\n");
    } finally { await admitted.snapshot.close(); }
    await expect(readFile(admitted.paths[0]!)).rejects.toThrow();
  });

  it("extends the real native module guard only with frozen extension/dependency files and retires them with the command", async () => {
    const root = await fixture();
    const distribution = join(root, "distribution"); await mkdir(distribution);
    const { executable, libraries } = await copyOwnedNodeRuntime(distribution);
    const entry = `const {pathToFileURL}=require("node:url");
      const extensions=JSON.parse(process.env.PAPERCLIP_PI_ADMITTED_EXTENSIONS??"[]");
      Promise.all(extensions.map(path=>import(pathToFileURL(path+"/index.mjs").href)))
      .then(modules=>console.log(JSON.stringify(modules.map(module=>module.value)))).catch(error=>{console.error(error);process.exitCode=1;});`;
    await writeFile(join(distribution, "pi-entry.cjs"), entry);
    const entries = await Promise.all([executable, ...libraries, join(distribution, "pi-entry.cjs")].map(async path => {
      const bytes = await readFile(path);
      return { path: path.slice(distribution.length + 1), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, executable: path === executable };
    }));
    entries.sort((a, b) => a.path < b.path ? -1 : 1);
    const manifestPath = join(root, "closure.json"); await writeFile(manifestPath, JSON.stringify({ entries }));
    const installation = await verifyNativeAcpxInstallation({ distributionRoot: distribution, manifestPath,
      expectedClosureSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
      executable: executable.slice(distribution.length + 1), entrypoint: "pi-entry.cjs", fixedArguments: [] });
    await mkdir(join(root, "package", "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "package", "node_modules", "dependency", "index.mjs"), "export const value = 42;");
    await writeFile(join(root, "package", "index.mjs"), 'export {value} from "./node_modules/dependency/index.mjs";');
    const lease = await installation.openCommand({ piExtensions: [join(root, "package")] });
    try {
      await writeFile(join(root, "package", "node_modules", "dependency", "index.mjs"), "throw Error('mutable original');");
      const child = lease.spawn([], { env: { PATH: process.env.PATH } });
      let stdout = "", stderr = "";
      child.stdout!.on("data", value => { stdout += value; }); child.stderr!.on("data", value => { stderr += value; });
      const [code] = await once(child, "close");
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "[42]\n", stderr: "" });
    } finally { await lease.close(); }
    const outside = join(root, "outside.mjs"); await writeFile(outside, "export const value = 99;");
    await writeFile(join(root, "package", "index.mjs"), `export {value} from ${JSON.stringify(outside)};`);
    const escape = await installation.openCommand({ piExtensions: [join(root, "package")] });
    try {
      const child = escape.spawn([], { env: { PATH: process.env.PATH } });
      let stderr = ""; child.stderr!.on("data", value => { stderr += value; });
      const [code] = await once(child, "close");
      expect(code).toBe(1); expect(stderr).toContain("escaped its closed distribution");
    } finally { await escape.close(); }
    const unset = await installation.openCommand();
    try {
      const child = unset.spawn([], { env: { PATH: process.env.PATH, PAPERCLIP_PI_ADMITTED_EXTENSIONS: JSON.stringify([join(root, "package")]) } });
      let stdout = ""; child.stdout!.on("data", value => { stdout += value; });
      const [code] = await once(child, "close");
      expect({ code, stdout }).toEqual({ code: 0, stdout: "[]\n" });
    } finally { await unset.close(); }
  }, 30_000);

  it("rejects missing files and escaping symlinks instead of widening code admission", async () => {
    const root = await fixture();
    await symlink(join(root, "package", "index.ts"), join(root, "alias.ts"));
    await expect(createPiExtensionSnapshot([join(root, "alias.ts")])).rejects.toThrow("canonical");
    await expect(createPiExtensionSnapshot([join(root, "missing.ts")])).rejects.toThrow();
    await writeFile(join(root, "outside.js"), "export default () => {};\n");
    await symlink(join(root, "outside.js"), join(root, "package", "escape.js"));
    await expect(createPiExtensionSnapshot([join(root, "package")])).rejects.toThrow("escapes");
  });
});
