import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inventoryPiRuntimeFiles } from "../dist/drivers/acpx/pi-verified-runtime.js";
import { verifyPiRpcDistribution, PI_RPC_DISTRIBUTION } from "../dist/drivers/pi/pi-rpc-installation.js";

const run = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const lockRoot = join(packageRoot, "scripts/pi-rpc-distribution");

/** Separate native closure: no pi-acp wrapper, ACPX patch/helper or Node from PATH at launch.
 * Like materialize-opencode-binary.mjs:53-65, only Linux/x64 is qualified here.
 * Node is separately qualified by the same provider-pack launch used by the proxy.
 */
export async function materializePiRpcDistribution({ outputRoot, nodeExecutable = process.execPath, npmExecutable = "npm" }) {
  if (`${process.platform}-${process.arch}` !== "linux-x64") throw new Error("Native Pi RPC distribution is qualified only for linux-x64");
  if (!isAbsolute(outputRoot) || ["/", packageRoot, resolve(packageRoot, "../..")].includes(resolve(outputRoot))) throw new Error("Native Pi RPC output must be a safe absolute path");
  try { await lstat(outputRoot); throw new Error("Native Pi RPC output already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const lock = await readFile(join(lockRoot, "package-lock.json"));
  if (`sha256:${createHash("sha256").update(lock).digest("hex")}` !== PI_RPC_DISTRIBUTION.lockSha256) throw new Error("Native Pi RPC lock differs from its source declaration");
  const graph = JSON.parse(lock);
  if (graph.packages["node_modules/pi-acp"] || graph.packages["node_modules/@earendil-works/pi-coding-agent"]?.version !== PI_RPC_DISTRIBUTION.runtimeVersion) throw new Error("Native Pi RPC requires its own Pi-only graph");
  await mkdir(dirname(outputRoot), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputRoot), ".paperclip-pi-rpc-"));
  try {
    const runtime = join(staging, "runtime"); await mkdir(runtime);
    for (const name of ["package.json", "package-lock.json"]) await copyFile(join(lockRoot, name), join(runtime, name));
    const userconfig = join(staging, "npmrc");
    await writeFile(userconfig, "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n");
    const globalconfig = join(staging, "npmrc-global"); await writeFile(globalconfig, "");
    const home = join(staging, "home"); await mkdir(home);
    const env = Object.fromEntries(["PATH", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].flatMap(key => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []));
    env.HOME = home;
    await run(npmExecutable, ["ci", "--ignore-scripts", "--include=optional", "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `--userconfig=${userconfig}`, `--globalconfig=${globalconfig}`], { cwd: runtime, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    for (const file of await inventoryPiRuntimeFiles(runtime)) if (file.kind === "symlink") {
      if (!/(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(file.path)) throw new Error("Native Pi RPC payload has an unsupported link");
      await unlink(join(runtime, file.path));
    }
    await rm(join(runtime, "node_modules/.package-lock.json"), { force: true });
    const admitted = await verifyPiRpcDistribution(runtime);
    const version = await run(nodeExecutable, [admitted.executable, "--version"], { env: { HOME: home }, timeout: 30_000 });
    if (version.stdout.trim() !== PI_RPC_DISTRIBUTION.runtimeVersion) throw new Error("Native Pi RPC executable version differs from its pin");
    for (const name of ["npmrc", "npmrc-global", "home"]) await rm(join(staging, name), { force: true, recursive: true });
    await rename(staging, outputRoot);
    return { ...admitted, runtimeRoot: join(outputRoot, "runtime"), executable: join(outputRoot, "runtime", PI_RPC_DISTRIBUTION.entrypoint) };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error("Usage: materialize-pi-rpc-distribution.mjs /absolute/output-directory");
  process.stdout.write(`${JSON.stringify(await materializePiRpcDistribution({ outputRoot: process.argv[2] }))}\n`);
}
