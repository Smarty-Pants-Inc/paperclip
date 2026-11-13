import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const run = (command: string) => spawnSync("/bin/sh", ["-c", local(command)], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  const store = (path: string, content: string) => {
    puts.push({ path, content });
    if (path.endsWith("/env.sh")) {
      modes.push([statSync(local(dirname(path))).mode & 0o777, statSync(local(path)).mode & 0o777]);
    }
    mkdirSync(dirname(local(path)), { recursive: true }); writeFileSync(local(path), content);
    if (failure === "upload") throw new Error("fixture upload lost reply");
  };
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
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
        if (failure === "setup") return json({ exitCode: 1 });
        const result = run(body.command); expect(result.status, result.stderr).toBe(0); return json({ exitCode: 0 });
      }
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
  return { root, puts, commands, deletes, modes, fetch, local, envFiles: () => puts.filter(p => p.path.endsWith("/env.sh")) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("execute environment files", () => {
  it("keeps values AND names out of every commands POST; sources then removes the file and directory before exec", async () => {
    const f = fixture(undefined, true);
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 0 });
    for (const body of f.commands) { expect(JSON.stringify(body)).not.toContain(sentinel); expect(body.command).not.toContain("SECRET_X"); }
    expect(f.envFiles()).toHaveLength(1);
    const path = f.envFiles()[0].path;
    expect(f.envFiles()[0].content).toBe(`export SECRET_X='${sentinel}'\n`);
    for (const body of f.commands) { expect(JSON.stringify(body)).not.toContain(sentinel); expect(body.command).not.toContain("SECRET_X"); }
    const command = f.commands.at(-1).command;
    expect(command).toContain(`. '${path}'`);
    expect(command.indexOf("rm -f --")).toBeLessThan(command.indexOf("exec "));
    expect(command.indexOf("rmdir --")).toBeLessThan(command.indexOf("exec "));
    expect(f.modes).toEqual([[0o700, 0o600]]);
    expect(f.deletes).toContain(path); expect(f.deletes).toContain(dirname(path));
    expect(existsSync(f.local(path))).toBe(false); expect(existsSync(f.local(dirname(path)))).toBe(false);
  });
  it("real /bin/sh preserves bytes and exports to a child; temp file and dir are gone at process start", async () => {
    const f = fixture(undefined, true);
    const env = { SECRET_X: "single' dollar$ backtick`\nbackslash\\ space 雪 = end", EMPTY: "", EQ: "a=b=c", PATH: "/nonexistent" };
    const child = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(k=>[k,process.env[k]]))))`;
    // stdin is a non-secret program; the grandchild proves exports, not just shell locals.
    const stdin = `const fs=require('node:fs');const cp=require('node:child_process');if(fs.readdirSync(${JSON.stringify(f.root)}).some(p=>p.startsWith('paperclip-boat-env-')))process.exit(91);process.stdout.write(cp.execFileSync(process.execPath,['-e',${JSON.stringify(child)}]));`;
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, command: process.execPath, args: ["-"], stdin, env });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout!)).toEqual(env);
    for (const [key, value] of Object.entries(env)) expect(Buffer.from(JSON.parse(result.stdout!)[key]).equals(Buffer.from(value))).toBe(true);
    for (const body of f.commands) expect(body.command).not.toContain(env.SECRET_X);
  });
  it("isolates unique files outside the workspace, including a /tmp workspace", async () => {
    const f = fixture();
    for (const cwd of ["/home/user/workspace", "/home/user/workspace", "/tmp"]) {
      await plugin.definition.onEnvironmentExecute!({ ...params, cwd, lease: { ...params.lease, metadata: { remoteCwd: cwd } }, env: { SECRET_X: sentinel } });
      const path = f.envFiles().at(-1)!.path; expect(path.startsWith(`${cwd}/`)).toBe(false);
    }
    expect(new Set(f.envFiles().map(p => p.path)).size).toBe(3);
  });
  for (const env of [undefined, {}]) it(`empty env (${JSON.stringify(env)}): no file, command unchanged`, async () => {
    const f = fixture(); await plugin.definition.onEnvironmentExecute!({ ...params, command: "printf", args: ["a'b"], cwd: "/work space", env });
    expect(f.puts).toEqual([]); expect(f.commands).toEqual([{ command: `cd '/work space' && exec 'printf' 'a'"'"'b'`, timeoutSeconds: 5, detached: false }]);
  });
  it("combines stdin and env without mixing their content and cleans both", async () => {
    const f = fixture(undefined, true);
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, command: "/bin/sh", args: ["-s"], env: { SECRET_X: sentinel }, stdin: 'printf "%s" "$SECRET_X"' });
    expect(result).toMatchObject({ exitCode: 0, stdout: sentinel }); expect(f.puts).toHaveLength(2);
    for (const p of f.puts) { expect(f.deletes).toContain(p.path); expect(existsSync(f.local(p.path))).toBe(false); }
    for (const body of f.commands) expect(body.command).not.toContain(sentinel);
  });
  for (const failure of ["nonzero", "throw", "timeout", "request-timeout", "upload", "setup", "poll-timeout"] as const) it(`${failure}: backup DELETE removes the file and directory`, async () => {
    const f = fixture(failure);
    const call = plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } });
    if (["throw", "request-timeout", "upload", "setup"].includes(failure)) await expect(call).rejects.toThrow();
    else expect(await call).toMatchObject(failure === "nonzero" ? { exitCode: 7 } : { timedOut: true });
    const path = f.envFiles()[0]?.path ?? f.deletes.find(p => p.endsWith("/env.sh"));
    expect(path).toBeTruthy(); expect(f.deletes).toContain(path); expect(f.deletes).toContain(dirname(path!));
    expect(existsSync(f.local(path!))).toBe(false); expect(existsSync(f.local(dirname(path!)))).toBe(false);
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
    expect(f.envFiles()).toHaveLength(1); expect(f.deletes).toContain(f.envFiles()[0].path);
    for (const body of f.commands) expect(JSON.stringify(body)).not.toContain(sentinel);
  });
  it("large UTF-8 env uses signed upload and never Boat authorization at the upload host", async () => {
    const f = fixture(); const value = "雪".repeat(1_400_000);
    await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: value } });
    expect(f.envFiles()).toHaveLength(1); expect(f.envFiles()[0].content).toBe(`export SECRET_X='${value}'\n`);
    expect(f.fetch.mock.calls.some(([u]) => String(u) === "https://upload.invalid/env")).toBe(true);
    for (const body of f.commands) expect(body.command).not.toContain("雪");
  });
  it("a failed cd still deletes the uploaded env file and directory", async () => {
    const f = fixture(undefined, true);
    const result = await plugin.definition.onEnvironmentExecute!({ ...params, cwd: join(f.root, "missing"), env: { SECRET_X: sentinel } });
    expect(result.exitCode).not.toBe(0); expect(f.envFiles()).toHaveLength(1);
    const path = f.envFiles()[0].path; expect(f.deletes).toContain(path);
    expect(existsSync(f.local(dirname(path)))).toBe(false);
  });
  it("cleanup errors do not replace the command result", async () => {
    const f = fixture(undefined, true), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init = {}) => {
      if (init.method === "DELETE") throw new Error("fixture cleanup unavailable");
      return original(input, init);
    });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, env: { SECRET_X: sentinel } })).toMatchObject({ exitCode: 0 });
    expect(f.envFiles()).toHaveLength(1); expect(existsSync(f.local(dirname(f.envFiles()[0].path)))).toBe(false);
  });
  for (const key of ["BAD-NAME", "X;echo bad", "1BAD", "A\nB"]) it(`refuses invalid key ${JSON.stringify(key)} before requests`, async () => {
    const f = fixture(); await expect(plugin.definition.onEnvironmentExecute!({ ...params, env: { [key]: sentinel } })).rejects.toThrow("Invalid environment variable"); expect(f.fetch).not.toHaveBeenCalled();
  });
});
