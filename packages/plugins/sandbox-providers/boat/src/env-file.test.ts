import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "./plugin.js";

// Keep: command-history secret disclosure (P0), file permissions, byte safety,
// and cleanup failure paths. No Boat requests. Only remote absolute temp paths
// are relocated into a test-owned mkdtemp; the generated shell and content run
// unchanged otherwise, with real /bin/sh and a real child process.
const API = "https://boat.dev/api/v1/sandboxes/bx_test";
const sentinel = "envfile-distinct-sentinel-71f524";
const params = { driverKey: "boat", companyId: "c", environmentId: "e", config: { apiKey: "boat_test" },
  lease: { providerLeaseId: "bx_test", metadata: { remoteCwd: "/home/user/workspace" } }, command: "/bin/true", timeoutMs: 5000 };
const roots: string[] = [];
function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
function fixture(failure?: "nonzero" | "throw" | "timeout" | "request-timeout" | "upload" | "setup" | "poll-timeout", real = false) {
  const root = mkdtempSync(join(tmpdir(), "boat-env-test-")); roots.push(root);
  const puts: { path: string; content: string }[] = [], commands: any[] = [], deletes: string[] = [];
  const modes: number[][] = [];
  let uploadPath = "";
  const local = (text: string) => text.replace(/\/tmp\/paperclip-/g, `${root}/paperclip-`).replace(/\/home\/user\/\.paperclip-boat-env-/g, `${root}/home-env-`);
  const run = (command: string) => {
    const chmod = /\/bin\/chmod 600 -- '([^']+)'/.exec(command);
    const instrumented = chmod ? command.replace(chmod[0], `${chmod[0]} && /usr/bin/stat -c %a -- '${chmod[1]}' > '${chmod[1]}.mode'`) : command;
    const result = spawnSync("/bin/sh", ["-c", local(instrumented)], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    if (chmod && existsSync(local(`${chmod[1]}.mode`))) modes.push([parseInt(readFileSync(local(`${chmod[1]}.mode`), "utf8").trim(), 8)]);
    return result;
  };
  const store = (path: string, content: string) => {
    puts.push({ path, content });
    if (path.endsWith(".sh")) modes.push([statSync(dirname(local(path))).mode & 0o777]);
    writeFileSync(local(path), content);
    if (failure === "upload") throw new Error("fixture upload lost reply");
  };
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === `${API}/stop` && init.method === "POST") return json({ operation: { id: "stop_test", status: "pending" } });
    if (url === API && (init.method ?? "GET") === "GET") return json({ sandbox: { id: "bx_test", state: "archived" } });
    if (url === `${API}/files` && init.method === "PUT") {
      const body = JSON.parse(String(init.body)); expect(body.encoding).toBe("utf8"); store(body.path, body.content); return json({ success: true });
    }
    if (url === `${API}/files/upload-url` && init.method === "POST") {
      uploadPath = JSON.parse(String(init.body)).path; return json({ url: "https://upload.invalid/env" });
    }
    if (url === "https://upload.invalid/env") {
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      store(uploadPath, Buffer.from(await new Response(init.body).arrayBuffer()).toString("utf8")); return new Response(null, { status: 204 });
    }
    if (url.startsWith(`${API}/files?`) && init.method === "DELETE") {
      const query = new URL(url).searchParams, path = query.get("path")!;
      deletes.push(path); rmSync(local(path), { force: true, recursive: query.get("recursive") === "true" }); return json({ success: true });
    }
    if (url === `${API}/commands` && init.method === "POST") {
      const body = JSON.parse(String(init.body)); commands.push(body);
      if (!body.command.includes("exec ")) {
        if (failure === "setup" && body.command.includes("/bin/chmod 600")) return json({ exitCode: 1 });
        const result = run(body.command); expect(result.status, result.stderr).toBe(0); return json({ exitCode: 0 });
      }
      if (failure === "setup") return json({ exitCode: 1 });
      if (failure === "throw") throw new Error("fixture command request lost");
      if (failure === "request-timeout") throw new DOMException("fixture request timeout", "TimeoutError");
      if (failure === "poll-timeout") { vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10_000); return json({ processId: "proc1" }); }
      if (failure === "timeout") return json({ exitCode: null, timedOut: true });
      if (failure === "nonzero") return json({ exitCode: 7 });
      if (real) { const result = run(body.command); return json({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }); }
      return json({ exitCode: 0, stdout: "ok" });
    }
    if (url === `${API}/commands/proc1` && init.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected fixture request: ${init.method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { root, puts, commands, deletes, modes, fetch, local, envFiles: () => puts.filter(p => p.path.endsWith(".sh")) };
}
beforeEach(async () => { await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("execute environment files", () => {
  it("RED env-once: same env reuses one random file with no per-execute DELETE", async () => {
    const f = fixture();
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    expect(f.envFiles()).toHaveLength(1);
    expect(f.deletes.filter(path => path.endsWith(".sh"))).toHaveLength(0);
    expect(f.commands.filter(body => body.command.includes("exec "))).toHaveLength(2);
  });
  it("RED env-once concurrency: concurrent distinct envs on one lease source only their own version", async () => {
    const f = fixture(undefined, true);
    const execute = (value: string) => plugin.definition.onEnvironmentExecute!({ ...params, command: "/bin/sh", args: ["-c", "printf '%s' \"$SECRET_X\""], env: { SECRET_X: value } });
    const [first, second] = await Promise.all([execute("version-one"), execute("version-two")]);
    expect(first.stdout).toBe("version-one"); expect(second.stdout).toBe("version-two");
    expect(f.envFiles()).toHaveLength(2); expect(f.envFiles()[0].path).not.toBe(f.envFiles()[1].path);
    expect(existsSync(f.local(f.envFiles()[0].path))).toBe(false); expect(existsSync(f.local(f.envFiles()[1].path))).toBe(true);
  });
  it("RED env-once rotation: next execute uses a new random file and removes the old one", async () => {
    const f = fixture(undefined, true);
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: "old-value" } });
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: "new-value" } });
    expect(f.envFiles()).toHaveLength(2);
    expect(f.envFiles()[1].path).not.toBe(f.envFiles()[0].path);
    expect(f.commands.at(-1).command).toContain("find ");
    expect(f.deletes.filter(path => path.endsWith(".sh"))).toHaveLength(0);
    expect(existsSync(f.local(f.envFiles()[0].path))).toBe(false);
    expect(existsSync(f.local(f.envFiles()[1].path))).toBe(true);
  });
  it("keeps values AND names out of every commands POST; sources persistent file before exec", async () => {
    const f = fixture(undefined, true);
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 0 });
    for (const body of f.commands) { expect(JSON.stringify(body)).not.toContain(sentinel); expect(body.command).not.toContain("SECRET_X"); }
    expect(f.envFiles()).toHaveLength(1);
    const path = f.envFiles()[0].path;
    expect(f.envFiles()[0].content).toBe(`export SECRET_X='${sentinel}'\n`);
    for (const body of f.commands) { expect(JSON.stringify(body)).not.toContain(sentinel); expect(body.command).not.toContain("SECRET_X");
      expect(body.command).not.toContain(createHash("sha256").update(`export SECRET_X='${sentinel}'\n`).digest("hex")); }
    const command = f.commands.at(-1).command;
    expect(command).toContain(`. '${path}'`);
    expect(command).toContain("test -O "); expect(command).toContain("test ! -L ");
    expect(command.indexOf("test -O ")).toBeLessThan(command.indexOf("exec "));
    expect(command.indexOf("test ! -L ")).toBeLessThan(command.indexOf("exec "));
    expect(command.indexOf("/bin/chmod 600")).toBeLessThan(command.indexOf(`. '${path}'`));
    expect(command).toContain("/usr/bin/find");
    expect(command).not.toContain("rm -f --");
    expect(f.modes).toEqual([[0o700], [0o600]]);
    expect(f.commands[0].command).toContain("/bin/mkdir -p -m 0700");
    expect(f.envFiles()[0].path).toMatch(/^\/tmp\/paperclip-boat-env-[a-f0-9]{24}\/env-[0-9a-f-]+\.sh$/);
    expect(f.deletes).toHaveLength(0);
    expect(existsSync(f.local(path))).toBe(true);
  });
  it("re-verifies the directory and retries only the explicit exit 197 signal", async () => {
    const f = fixture(); const original = f.fetch.getMockImplementation()!; let first = true;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (String(input) === `${API}/commands` && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.command.includes("exec ") && first) { first = false; return json({ exitCode: 197, stderr: "unrelated diagnostic text" }); }
      }
      return original(input, init);
    });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 0 });
    expect(f.commands.filter(body => body.command.includes("/bin/mkdir -p -m 0700"))).toHaveLength(2);
    expect(f.commands.at(-2).command).toContain("|| exit 197");
    expect(f.fetch.mock.calls.filter(([input, init]) => String(input) === `${API}/commands` && init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)).command).at(-1)).toContain("|| exit 197");
    expect(f.envFiles()).toHaveLength(2);
  });
  it("does not retry an ordinary nonzero result based on stderr text", async () => {
    const f = fixture(); const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (String(input) === `${API}/commands` && init.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.command.includes("exec ")) return json({ exitCode: 1, stderr: "No such file: /tmp/old-env-path" });
      }
      return original(input, init);
    });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 1 });
    expect(f.commands.filter(body => body.command.includes("/bin/mkdir -p -m 0700"))).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([input, init]) => String(input) === `${API}/commands` && init?.method === "POST" && JSON.parse(String(init.body)).command.includes("exec "))).toHaveLength(1);
  });
  it("resume clears the verified-directory cache before the next secret PUT", async () => {
    const f = fixture(); const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (String(input) === `${API}/resume` && init.method === "POST") return json({ sandbox: { id: "bx_test", state: "archived" } });
      if (String(input) === `${API}` && (init.method ?? "GET") === "GET") return json({ sandbox: { id: "bx_test", state: "ready" } });
      return original(input, init);
    });
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    expect(f.commands.filter(body => body.command.includes("/bin/mkdir -p -m 0700"))).toHaveLength(1);
    await plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config: { apiKey: "boat_test", duplexCarrier: "off" }, providerLeaseId: "bx_test" });
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    expect(f.commands.filter(body => body.command.includes("/bin/mkdir -p -m 0700"))).toHaveLength(2);
    const lastPut = f.fetch.mock.calls.findLastIndex(([input, init]) => String(input) === `${API}/files` && init?.method === "PUT");
    const lastVerify = f.fetch.mock.calls.findLastIndex(([input, init]) => String(input) === `${API}/commands` && init?.method === "POST" && JSON.parse(String(init.body)).command.includes("/bin/mkdir -p -m 0700"));
    expect(lastVerify).toBeLessThan(lastPut);
  });
  it("real /bin/sh preserves bytes and exports to a child using the persistent env file", async () => {
    const f = fixture(undefined, true);
    const env = { SECRET_X: "single' dollar$ backtick`\nbackslash\\ space 雪 = end", EMPTY: "", EQ: "a=b=c", PATH: "/nonexistent" };
    const child = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(k=>[k,process.env[k]]))))`;
    // stdin is a non-secret program; the grandchild proves exports, not just shell locals.
    const stdin = `const cp=require('node:child_process');process.stdout.write(cp.execFileSync(process.execPath,['-e',${JSON.stringify(child)}]));`;
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, command: process.execPath, args: ["-"], stdin, env });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout!)).toEqual(env);
    for (const [key, value] of Object.entries(env)) expect(Buffer.from(JSON.parse(result.stdout!)[key]).equals(Buffer.from(value))).toBe(true);
    for (const body of f.commands) expect(body.command).not.toContain(env.SECRET_X);
  });
  it("reuses one file outside a workspace and rejects a /tmp workspace that cannot exclude it", async () => {
    const f = fixture();
    for (const cwd of ["/home/user/workspace", "/home/user/workspace"]) {
      await plugin.definition.onEnvironmentExecute!({ ...params, cwd, lease: { ...params.lease, metadata: { remoteCwd: cwd } }, env: { SECRET_X: sentinel } });
      const path = f.envFiles().at(-1)!.path; expect(path.startsWith(`${cwd}/`)).toBe(false);
    }
    await expect(plugin.definition.onEnvironmentExecute!({ ...params, cwd: "/tmp", lease: { ...params.lease, metadata: { remoteCwd: "/tmp" } }, env: { SECRET_X: sentinel } })).rejects.toThrow(/private path/);
    expect(new Set(f.envFiles().map(p => p.path)).size).toBe(1);
  });
  for (const env of [undefined, {}]) it(`empty env (${JSON.stringify(env)}): no file, command unchanged`, async () => {
    const f = fixture(); await plugin.definition.onEnvironmentExecute!({ ...params, command: "printf", args: ["a'b"], cwd: "/work space", env });
    expect(f.puts).toEqual([]); expect(f.commands).toEqual([{ command: `cd '/work space' && exec 'printf' 'a'"'"'b'`, timeoutSeconds: 5, detached: false }]);
  });
  it("combines stdin and env without mixing their content and cleans both", async () => {
    const f = fixture(undefined, true);
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, command: "/bin/sh", args: ["-s"], env: { SECRET_X: sentinel }, stdin: 'printf "%s" "$SECRET_X"' });
    expect(result).toMatchObject({ exitCode: 0, stdout: sentinel }); expect(f.puts).toHaveLength(2);
    expect(f.deletes).toContain(f.puts.find(p => !p.path.endsWith(".sh"))!.path);
    expect(f.deletes.filter(path => path.endsWith(".sh"))).toHaveLength(0);
    for (const body of f.commands) expect(body.command).not.toContain(sentinel);
  });
  for (const failure of ["nonzero", "throw", "timeout", "request-timeout", "upload", "setup", "poll-timeout"] as const) it(`${failure}: env file remains until lifecycle cleanup`, async () => {
    const f = fixture(failure);
    const call = plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    if (["throw", "request-timeout", "upload"].includes(failure)) await expect(call).rejects.toThrow();
    else expect(await call).toMatchObject(failure === "nonzero" ? { exitCode: 7 } : failure === "setup" ? { exitCode: 1 } : { timedOut: true });
    const path = f.envFiles()[0]?.path;
    expect(path).toBeTruthy(); expect(f.deletes).not.toContain(path);
    expect(existsSync(f.local(path!))).toBe(true);
    if (failure === "poll-timeout") expect(f.fetch.mock.calls.some(([u, i]) => String(u).endsWith("/commands/proc1") && i?.method === "DELETE")).toBe(true);
  });
  it("detached command and result polling use the same secret-free wrapper", async () => {
    const f = fixture(); const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (String(input) === `${API}/commands/proc1`) return json({ running: false, exitCode: 0, stdout: "done" });
      const result = await original(input, init);
      if (String(input) === `${API}/commands` && JSON.parse(String(init.body)).command.includes("exec ")) return json({ processId: "proc1" });
      return result;
    });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel }, timeoutMs: 900_000 })).toMatchObject({ stdout: "done", exitCode: 0 });
    expect(f.commands.at(-1)).toMatchObject({ detached: true, timeoutSeconds: 600 });
    expect(f.envFiles()).toHaveLength(1); expect(f.deletes).toHaveLength(0);
    for (const body of f.commands) expect(JSON.stringify(body)).not.toContain(sentinel);
  });
  it("large UTF-8 env uses signed upload and never Boat authorization at the upload host", async () => {
    const f = fixture(); const value = "雪".repeat(1_400_000);
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: value } });
    expect(f.envFiles()).toHaveLength(1); expect(f.envFiles()[0].content).toBe(`export SECRET_X='${value}'\n`);
    expect(f.fetch.mock.calls.some(([u]) => String(u) === "https://upload.invalid/env")).toBe(true);
    for (const body of f.commands) expect(body.command).not.toContain("雪");
  });
  it("a failed cd still deletes the uploaded env file", async () => {
    const f = fixture(undefined, true);
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, cwd: join(f.root, "missing"), env: { SECRET_X: sentinel } });
    expect(result.exitCode).not.toBe(0); expect(f.envFiles()).toHaveLength(1);
    const path = f.envFiles()[0].path; expect(f.deletes).not.toContain(path);
    expect(existsSync(f.local(path))).toBe(true);
  });
  it("cleanup errors do not replace the command result", async () => {
    const f = fixture(undefined, true), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (init.method === "DELETE") throw new Error("fixture cleanup unavailable");
      return original(input, init);
    });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 0 });
    expect(f.envFiles()).toHaveLength(1); expect(existsSync(f.local(f.envFiles()[0].path))).toBe(true);
  });
  for (const key of ["BAD-NAME", "X;echo bad", "1BAD", "A\nB"]) it(`refuses invalid key ${JSON.stringify(key)} before requests`, async () => {
    const f = fixture(); await expect(plugin.definition.onEnvironmentExecute!({ ...params, env: { [key]: sentinel } })).rejects.toThrow("Invalid environment variable"); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("release recursively deletes env files before stopping", async () => {
    const f = fixture();
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    const oldPath = f.envFiles()[0].path;
    await plugin.definition.onEnvironmentReleaseLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config: { apiKey: "boat_test", duplexCarrier: "off" }, providerLeaseId: "bx_test" });
    const rmIndex = f.fetch.mock.calls.findIndex(([url, init]) => init?.method === "DELETE" && String(url).includes("recursive=true"));
    const stopIndex = f.fetch.mock.calls.findIndex(([url, init]) => String(url) === `${API}/stop` && init?.method === "POST");
    expect(rmIndex).toBeGreaterThanOrEqual(0); expect(rmIndex).toBeLessThan(stopIndex);
    expect(existsSync(f.local(oldPath))).toBe(false);
  });
});
