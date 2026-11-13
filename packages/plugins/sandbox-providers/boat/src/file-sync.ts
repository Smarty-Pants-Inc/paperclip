import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { assertBoatActivityAdmission } from "./lease-gates.js";
import type { PluginEnvironmentSyncInParams, PluginEnvironmentSyncResult, PluginSyncFileMapping, PluginEnvironmentExecuteResult } from "@paperclipai/plugin-sdk";

const exec = promisify(execFile);
export interface SyncTransport {
  request(path: string, init?: RequestInit): Promise<any>;
  run(command: string, timeoutMs: number, cwd?: string): Promise<PluginEnvironmentExecuteResult>;
}
const q = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const octal = (mode: number) => (mode & 0o7777).toString(8);
const literalExclude = (value: string) => value.replace(/[\\*?\[]/g, "\\$&");
function excludes(mapping: PluginSyncFileMapping, outbound: boolean): string[] {
  return outbound && mapping.preserveSourceEntries
    ? (mapping.exclude ?? []).map(literalExclude)
    : ["._*", ...(mapping.exclude ?? [])];
}
function validatePath(value: string): void {
  if (!path.posix.isAbsolute(value) || value.includes("\0") || value.split("/").includes("..") || path.posix.normalize(value) === "/") {
    throw new Error("Boat sync requires non-root absolute confined paths");
  }
}
async function success(io: SyncTransport, command: string, timeout: number, cwd?: string): Promise<PluginEnvironmentExecuteResult> {
  const result = await io.run(command, timeout, cwd);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`Boat sync command failed (exit ${result.exitCode}, timedOut ${result.timedOut})`);
  return result;
}
async function tar(args: string[], timeout: number): Promise<void> {
  // Match fallback flags; do not allow a host TAR_OPTIONS to inject extraction options.
  const { TAR_OPTIONS: _unused, ...env } = process.env;
  await exec("tar", args, { env: { ...env, COPYFILE_DISABLE: "1" }, timeout, maxBuffer: 1024 * 1024 });
}
async function archiveHost(mapping: PluginSyncFileMapping, archive: string, temp: string, timeout: number): Promise<number | undefined> {
  const source = await fs.lstat(mapping.sourcePath);
  if (mapping.kind === "file" && !source.isFile()) throw new Error("Boat file mapping requires a regular file");
  if (mapping.kind === "directory" && !source.isDirectory()) throw new Error("Boat directory mapping requires a directory");
  const list = path.join(temp, "entries.nul");
  const file = await fs.open(list, "wx", 0o600);
  try {
    if (mapping.kind === "directory") {
      for await (const entry of await fs.opendir(mapping.sourcePath)) await file.writeFile(`${entry.name}\0`);
    } else await file.writeFile(`${path.basename(mapping.sourcePath)}\0`);
  } finally { await file.close(); }
  await tar(["-c", "--no-xattrs", ...(mapping.kind === "directory" && mapping.followSymlinks ? ["-h"] : []),
    "-f", archive, "-C", mapping.kind === "directory" ? mapping.sourcePath : path.dirname(mapping.sourcePath),
    ...(mapping.kind === "directory" ? excludes(mapping, false).flatMap(value => ["--exclude", value]) : []), "--null", "-T", list], timeout);
  return mapping.kind === "directory" ? source.mode & 0o7777 : undefined;
}
function archiveSandbox(mapping: PluginSyncFileMapping, archive: string): string {
  const list = `${archive}.list`;
  const directory = mapping.kind === "directory";
  const cwd = directory ? mapping.sourcePath : path.posix.dirname(mapping.sourcePath);
  const enumerate = directory
    ? `find . -mindepth 1 -maxdepth 1 -printf '%f\\0' > ${q(list)}`
    : `printf '%s\\0' ${q(path.posix.basename(mapping.sourcePath))} > ${q(list)}`;
  const ownScratch = [archive, list].map(name => path.posix.relative(cwd, name))
    .filter(name => name !== ".." && !name.startsWith("../") && !path.posix.isAbsolute(name));
  const flags = ["-c", "--no-xattrs", ...(directory && mapping.followSymlinks ? ["-h"] : []), "-f", archive, "-C", cwd,
    ...(directory && mapping.preserveSourceEntries ? ["--anchored"] : []),
    ...(directory ? [...excludes(mapping, true), ...ownScratch.map(literalExclude)].flatMap(value => ["--exclude", value]) : []), "--null", "-T", list].map(q).join(" ");
  return `set -eu; umask 077; unset TAR_OPTIONS; export COPYFILE_DISABLE=1; trap ${q(`rm -f -- ${q(list)}`)} EXIT; ` +
    `test ${directory ? "-d" : "-f"} ${q(mapping.sourcePath)}; test ! -L ${q(mapping.sourcePath)}; cd ${q(cwd)}; ${enumerate}; tar ${flags}` +
    (directory ? `; stat -c '%a' -- ${q(mapping.sourcePath)}` : "");
}
function installSandbox(mapping: PluginSyncFileMapping, archive: string, rootMode?: number): string {
  const parent = path.posix.dirname(mapping.targetPath);
  const target = q(mapping.targetPath);
  const staged = mapping.kind === "file" ? `"$stage/data/"${q(path.posix.basename(mapping.sourcePath))}` : '"$stage/data"';
  // A directory's own mode is applied AFTER the rename: renaming a directory across parents needs write
  // permission on it (to update ".."), so a read-only root mode set before mv fails with EACCES.
  const fileModes = mapping.mode === undefined ? "" : mapping.kind === "file"
    ? `chmod ${octal(mapping.mode)} -- ${staged}; `
    : `find "$stage/data" -type f -exec chmod ${octal(mapping.mode)} -- {} +; `;
  const dirMode = mapping.kind === "directory" ? `; chmod ${octal(mapping.mode ?? rootMode ?? 0o755)} -- ${target}` : "";
  return `set -eu; umask 077; unset TAR_OPTIONS; mkdir -p -- ${q(parent)}; ` +
    `stage=$(mktemp -d ${q(path.posix.join(parent, ".paperclip-upload-boat-XXXXXX"))}); ` +
    `trap ${q(`chmod -R u+w -- "$stage" 2>/dev/null; rm -rf -- "$stage"; rm -f -- ${q(archive)}`)} EXIT; mkdir "$stage/data"; ` +
    `tar -xf ${q(archive)} -p -C "$stage/data" --no-same-owner; ` +
    (mapping.kind === "file" ? `test -f ${staged}; test ! -L ${staged}; ` : "") + fileModes +
    // An earlier read-only install must stay replaceable: restore owner write before removing it.
    (mapping.kind === "directory" ? `if test -d ${target} && test ! -L ${target}; then chmod -R u+w -- ${target}; fi; rm -rf -- ${target}; ` : "") +
    // GNU mv -T prevents a target symlink/directory from changing the rename destination.
    `mv -fT -- ${staged} ${target}` + dirMode;
}
function transferFailure(error: unknown, timeout: number): string {
  const failure = error && typeof error === "object" ? error as { name?: unknown; httpStatus?: unknown; cause?: unknown } : {};
  if (typeof failure.httpStatus === "number" && Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599) return `HTTP ${failure.httpStatus}`;
  if (failure.name === "TimeoutError" || failure.name === "AbortError") return `timeout after ${timeout} ms`;
  const name = typeof failure.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(failure.name) ? failure.name : "Error";
  const code = failure.cause && typeof failure.cause === "object" ? (failure.cause as { code?: unknown }).code : undefined;
  return name + (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (${code})` : "");
}
function retryableTransferFailure(error: unknown, status?: number): boolean {
  const failure = error && typeof error === "object"
    ? error as { name?: unknown; httpStatus?: unknown; category?: unknown; code?: unknown; cause?: { code?: unknown } } : {};
  const httpStatus = status ?? failure.httpStatus;
  if (typeof httpStatus === "number") return httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599);
  if (failure.name === "TimeoutError" || failure.name === "AbortError" || failure.name === "TypeError" || failure.category === "network_error") return true;
  const code = failure.code ?? failure.cause?.code;
  return typeof code === "string" && /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code);
}
async function signedTransfer(io: SyncTransport, base: string, remote: string, local: string, upload: boolean, timeout: number): Promise<number> {
  const direction = upload ? "upload" : "download";
  // Boat publishes an upload only once complete. Retry once, always with a fresh
  // URL (served by the sandbox, which may have paused during snapshot capture).
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt ? " (after 1 retry)" : "", signal = AbortSignal.timeout(timeout);
    let signed;
    try {
      signed = await io.request(`${base}/files/${direction}-url`, {
        method: "POST", body: JSON.stringify({ path: remote }), signal,
      });
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      if (attempt === 0 && retryableTransferFailure(failure)) continue;
      throw new Error(`Boat ${direction}-url request failed: ${transferFailure(failure, timeout)}${suffix}`);
    }
    let url: URL;
    try { url = new URL(signed.url); } catch { throw new Error(`Boat file URL response omitted a valid URL${suffix}`); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Boat file URL must use HTTPS without userinfo${suffix}`);
    // Never attach the Boat bearer to a signed URL, or include the secret URL in errors.
    assertBoatActivityAdmission();
    const body = upload ? createReadStream(local) : undefined, transferSignal = AbortSignal.timeout(timeout);
    let rejectedStatus: number | undefined;
    try {
      const response = await fetch(url.href, { method: upload ? "PUT" : "GET", body: body as unknown as BodyInit,
        ...(upload ? { duplex: "half" } : {}), redirect: "error", signal: transferSignal } as RequestInit);
      if (!response.ok) { rejectedStatus = response.status; await response.body?.cancel(); throw new Error("signed transfer rejected"); }
      if (upload) await response.body?.cancel();
      else {
        if (!response.body) throw new Error("empty download response");
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(local, { flags: "wx", mode: 0o600 }), { signal: transferSignal });
      }
      return (await fs.stat(local)).size;
    } catch (error) {
      const failure = transferSignal.aborted ? transferSignal.reason : error;
      if (attempt === 0 && retryableTransferFailure(failure, rejectedStatus)) {
        // pipeline has closed the wx stream; don't let its partial archive block retry.
        if (!upload) await fs.rm(local, { force: true });
        continue;
      }
      throw new Error(`Boat signed ${direction} failed: ${rejectedStatus === undefined ? transferFailure(failure, timeout) : `HTTP ${rejectedStatus}`}${suffix}`);
    } finally { body?.destroy(); }
  }
}
async function validateExtracted(root: string, mapping: PluginSyncFileMapping): Promise<void> {
  // Never follow sandbox-planted links while inspecting/applying modes. GNU tar
  // rejects traversal/link-pivot writes during extraction into this private tree.
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of await fs.opendir(directory)) {
      const name = path.join(directory, entry.name), stat = await fs.lstat(name);
      if (stat.isDirectory()) await visit(name);
      else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(name), resolved = path.resolve(directory, link);
        if (path.isAbsolute(link) || (resolved !== root && !resolved.startsWith(`${root}/`))) throw new Error("Unsafe Boat archive symlink");
      } else if (stat.isFile()) {
        if (mapping.mode !== undefined) await fs.chmod(name, mapping.mode);
      } else throw new Error("Unsafe Boat archive entry type");
    }
  };
  await visit(root);
}
async function ensureHostParent(parent: string): Promise<void> {
  // Check ancestors before mkdir: a recursive mkdir followed by realpath could
  // already create directories through a sandbox-planted parent symlink.
  let current = path.parse(parent).root;
  for (const component of path.resolve(parent).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 }); stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Boat target parent is not canonical");
  }
}
async function installHost(mapping: PluginSyncFileMapping, archive: string, timeout: number, rootMode?: number): Promise<void> {
  const parent = path.dirname(mapping.targetPath);
  await ensureHostParent(parent);
  if (await fs.realpath(parent) !== path.resolve(parent)) throw new Error("Boat target parent is not canonical");
  const stage = await fs.mkdtemp(path.join(parent, ".paperclip-upload-boat-"));
  const data = path.join(stage, "data");
  try {
    await fs.mkdir(data, { mode: 0o700 });
    await tar(["-xf", archive, "-p", "-C", data, "--no-same-owner"], timeout);
    await validateExtracted(data, mapping);
    const staged = mapping.kind === "file" ? path.join(data, path.posix.basename(mapping.sourcePath)) : data;
    if (mapping.kind === "file") {
      if (!(await fs.lstat(staged)).isFile() || (await fs.readdir(data)).length !== 1) throw new Error("Boat file archive is not a single regular file");
    } else {
      await fs.chmod(data, mapping.mode ?? rootMode ?? 0o755);
      // Only directory publication is destroy-then-replace, matching fallback.
      await fs.rm(mapping.targetPath, { recursive: true, force: true });
    }
    await fs.rename(staged, mapping.targetPath);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
export async function syncFiles(params: PluginEnvironmentSyncInParams, outbound: boolean, io: SyncTransport): Promise<PluginEnvironmentSyncResult> {
  const id = params.lease.providerLeaseId;
  if (!id) throw new Error("Boat sync requires a lease ID");
  const timeout = Math.max(60_000, params.minimumTimeoutMs ?? 0), base = `/sandboxes/${encodeURIComponent(id)}`;
  const transferTimeout = Math.max(180_000, params.minimumTimeoutMs ?? 0);
  // Validate before any side effect, including optional adapter-authored commands.
  for (const op of params.operations) {
    for (const mapping of op.files) {
      validatePath(mapping.sourcePath); validatePath(mapping.targetPath);
      if (!["file", "directory"].includes(mapping.kind)) throw new Error("Invalid Boat mapping kind");
      if (mapping.mode !== undefined && (!Number.isInteger(mapping.mode) || mapping.mode < 0 || mapping.mode > 0o7777)) throw new Error("Invalid Boat mapping mode");
    }
    for (const command of op.postUploadCommands ?? []) {
      if (outbound) throw new Error("Boat post-upload commands are inbound only");
      if (command.cwd !== undefined) {
        validatePath(command.cwd);
        const cwd = path.posix.normalize(command.cwd);
        if (!op.files.some(file => cwd === path.posix.normalize(file.targetPath) || cwd.startsWith(`${path.posix.normalize(file.targetPath)}/`))) throw new Error("Boat post-upload cwd escapes operation targets");
      }
    }
  }
  const operations: PluginEnvironmentSyncResult["operations"] = [];
  for (const op of params.operations) {
    let bytesTransferred = 0, filesTransferred = 0;
    for (const mapping of op.files) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-boat-sync-")), local = path.join(temp, "transfer.tar");
      const remote = `/tmp/paperclip-boat-sync-${randomUUID()}.tar`;
      let remoteAttempted = false;
      try {
        if (outbound) {
          remoteAttempted = true;
          const archived = await success(io, archiveSandbox(mapping, remote), timeout);
          const modeText = archived.stdout.trim();
          if (mapping.kind === "directory" && !/^[0-7]{1,4}$/.test(modeText)) throw new Error("Boat archive omitted directory mode");
          const rootMode = mapping.kind === "directory" ? parseInt(modeText, 8) : undefined;
          bytesTransferred += await signedTransfer(io, base, remote, local, false, transferTimeout);
          await installHost(mapping, local, timeout, rootMode);
        } else {
          const rootMode = await archiveHost(mapping, local, temp, timeout);
          remoteAttempted = true;
          bytesTransferred += await signedTransfer(io, base, remote, local, true, transferTimeout);
          await success(io, installSandbox(mapping, remote, rootMode), timeout);
        }
        filesTransferred++;
      } finally {
        try {
          if (remoteAttempted) await io.request(`${base}/files?path=${encodeURIComponent(remote)}`, { method: "DELETE", signal: AbortSignal.timeout(timeout) }).catch(() => undefined);
        } finally { await fs.rm(temp, { recursive: true, force: true }); }
      }
    }
    for (const command of op.postUploadCommands ?? []) {
      const cwd = command.cwd ?? (typeof params.lease.metadata?.remoteCwd === "string" ? params.lease.metadata.remoteCwd : "/home/user/paperclip-workspace");
      validatePath(cwd);
      await success(io, command.command, command.timeoutMs ?? timeout, cwd);
    }
    operations.push({ operationId: op.operationId, filesTransferred, bytesTransferred });
  }
  return { operations };
}
