import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

// Keep reason: reproduce the real sealed-descriptor/CommonJS resource trust boundary.
// This is the Rust VERIFIED_COMMONJS_ARTIFACT_LOADER, not require(originalPath).
const loader = 'const fs=require("node:fs");const Module=require("node:module");const filename=process.argv[1];const source=fs.readFileSync(filename,"utf8").replace(/^#![^\\r\\n]*(?:\\r?\\n|$)/,"");const artifact=new Module(filename);artifact.filename=filename;artifact.paths=[];artifact._compile(source,filename);';
const launch = `import os,sys,fcntl
node,loader,proxy,pi,original,shape=sys.argv[1:]
def sealed(path):
 fd=os.memfd_create('paperclip-test',os.MFD_ALLOW_SEALING)
 os.write(fd,open(path,'rb').read())
 fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_SEAL|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_WRITE)
 os.set_inheritable(fd,True)
 return '/proc/self/fd/'+str(fd)
proxyfd=sealed(proxy)
pifd=sealed(pi)
args=['--paperclip-trusted-pi-executable',pifd,'--paperclip-pi-executable-path',pi]
if shape not in ('four','two','missing'): args+=['--paperclip-pi-proxy-path',original]
if shape=='two': args=args[:2]
if shape=='missing': args+=['--paperclip-pi-proxy-path']
if shape=='wrongflag': args[4]='--other-proxy-path'
if shape=='extra': args+=['extra']
if shape=='sdkfd': loader=loader.replace('artifact._compile(source,filename);','process.argv[1]='+repr(pifd)+';artifact._compile(source,filename);')
if shape in ('rawpath','fd2','fd256','zero-padded'):
 value={'rawpath':original,'fd2':'/proc/self/fd/2','fd256':'/proc/self/fd/256','zero-padded':'/proc/self/fd/03'}[shape]
 loader=loader.replace('artifact._compile(source,filename);','process.argv[1]='+repr(value)+';artifact._compile(source,filename);')
os.execve(node,[node,'-e',loader,proxyfd,*args],os.environ)
`;

describe.skipIf(process.platform !== "linux" || !process.env.PI_TEST_BINARY)("sealed Pi proxy resource binding", () => {
  let root: string; let proxy: string; let pi: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-descriptor-resource-")));
    proxy = join(root, "cli/pi-rpc-app-server-proxy.cjs");
    pi = realpathSync(process.env.PI_TEST_BINARY!);
    mkdirSync(join(root, "workspace"));
    await build({ entryPoints: [fileURLToPath(new URL("./pi-rpc-app-server-proxy.ts", import.meta.url))], outfile: proxy, bundle: true, platform: "node", format: "cjs", target: "node24", packages: "bundle", splitting: false, sourcemap: false, legalComments: "none", treeShaking: true, logLevel: "silent", banner: { js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" } });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const relative of ["extension/index", "pi-bind-protocol"]) await build({ entryPoints: [fileURLToPath(new URL(`../drivers/pi/${relative}.ts`, import.meta.url))], outfile: join(root, `drivers/pi/${relative}.js`), platform: "node", format: "esm", target: "node24", bundle: false, logLevel: "silent" });
    console.log(`DESCRIPTOR_RESOURCE_ROOT ${root}`);
  });
  function run(original = proxy, shape = "six") {
    const result = spawnSync("python3", ["-c", launch, process.execPath, loader, proxy, pi, original, shape], {
      cwd: "/", encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_PI_RUNTIME_DIR: join(root, "sessions"), PAPERCLIP_PI_RPC_COMMAND: "/ambient/must-not-run", PAPERCLIP_PI_PROXY_PATH: proxy, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only" },
      input: [ { id: 1, method: "initialize" }, { id: 2, method: "thread/start", params: { cwd: join(root, "workspace"), model: "paperclip/faux", piThinkingLevel: "off", baseInstructions: "local resource admission only" } }, { id: 3, method: "thread/close" } ].map(x => JSON.stringify(x)).join("\n") + "\n",
    });
    writeFileSync(join(root, `result-${shape}-${original.split("/").at(-1)}.json`), JSON.stringify(result, null, 2));
    return result;
  }
  it("opens real Pi with the byte-matched owned extension under the actual descriptor loader", () => {
    const result = run();
    writeFileSync(join(root, "admission-result.json"), JSON.stringify(result, null, 2));
    const diagnostic = result.stderr.replaceAll("/proc/self/fd/", "sealed-descriptor-");
    expect(result.error).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    const frames = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(frames.find(frame => frame.id === 2), diagnostic).toMatchObject({ result: { thread: { id: expect.any(String) } } });
    expect(result.stdout).not.toContain("owned extension entrypoint unavailable");
  }, 25000);
  it.each(["missing", "two", "four"])("does not use ambient/cwd/raw argv to repair %s proxy binding", shape => {
    const result = run(proxy, shape);
    if (shape !== "four") { expect(result.status).not.toBe(0); expect(result.stderr).toContain("unavailable"); }
    else { expect(result.stdout).toContain("owned extension entrypoint unavailable"); expect(result.stdout).not.toContain('"result":{"thread"'); }
  });
  it.each(["wrongflag", "extra", "sdkfd", "rawpath", "fd2", "fd256", "zero-padded"])("refuses %s as current proxy attestation", shape => {
    const result = run(proxy, shape); expect(result.status).not.toBe(0); expect(result.stderr).toContain("unavailable");
  });
  it("rejects swapped original proxy bytes (even when they match the SDK executable FD)", () => {
    const swapped = join(root, "swapped.cjs"); writeFileSync(swapped, readFileSync(pi));
    const result = run(swapped); expect(result.status).not.toBe(0); expect(result.stderr).toContain("unavailable");
  });
  it.each(["symlink", "hardlink", "writable", "noncanonical", "directory"])("rejects %s original proxy", kind => {
    const path = join(root, `invalid-${kind}.cjs`);
    if (kind === "symlink") symlinkSync(proxy, path);
    if (kind === "hardlink") { const copy = join(root, "linked-copy.cjs"); writeFileSync(copy, readFileSync(proxy)); linkSync(copy, path); }
    if (kind === "writable") { writeFileSync(path, readFileSync(proxy)); chmodSync(path, 0o666); }
    if (kind === "directory") mkdirSync(path);
    const result = run(kind === "noncanonical" ? `${root}/cli/../cli/pi-rpc-app-server-proxy.cjs` : path);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("unavailable");
  });
});
