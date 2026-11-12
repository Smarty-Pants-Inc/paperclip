import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, realpathSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

export const TRUSTED_PI_EXECUTABLE_ARG = "--paperclip-trusted-pi-executable";

export interface TrustedPiLaunchBinding {
  command: string;
  commandFd?: number;
  commandLifecycle?: {
    beforeSpawn(): void;
    afterSpawn(): void;
    afterExit(): void;
  };
}

/** Remove ambient overrides; only the runner-authenticated argv binding is executable. */
export function withoutAmbientPiCommand(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.PAPERCLIP_PI_RPC_COMMAND;
  return sanitized;
}

/**
 * Consume only the runner-owned executable descriptor or macOS verified
 * snapshot. The command is never resolved through PATH or an environment
 * fallback; the macOS lifecycle keeps the verified inode bound across spawn.
 */
export function trustedPiLaunchBinding(args: readonly string[]): TrustedPiLaunchBinding {
  const command = (args.length === 2 || (args.length === 4 && args[2] === "--paperclip-pi-executable-path"))
    && args[0] === TRUSTED_PI_EXECUTABLE_ARG ? args[1]! : "";
  const matched = process.platform === "linux" ? command.match(/^\/proc\/self\/fd\/(\d+)$/) : null;
  const commandFd = Number(matched?.[1]);
  const executablePath = args.length === 4 && args[2] === "--paperclip-pi-executable-path" ? args[3]! : "";
  if (matched && Number.isInteger(commandFd) && commandFd >= 3 && commandFd <= 255
    && isAbsolute(executablePath)) {
    const unavailable = () => new Error(
      "trusted Pi runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_PI_RPC_COMMAND fallback",
    );
    try {
      const metadata = lstatSync(executablePath);
      const uid = process.getuid?.();
      const bytes = readFileSync(executablePath);
      const verifiedBytes = readFileSync(command);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (metadata.mode & 0o022) !== 0 || uid === undefined || metadata.uid !== uid
        || realpathSync(executablePath) !== executablePath) throw unavailable();
      if (createHash("sha256").update(bytes).digest("hex") !== createHash("sha256").update(verifiedBytes).digest("hex")) {
        throw unavailable();
      }
      return { command: executablePath };
    } catch {
      throw unavailable();
    }
  }

  const unavailable = () => new Error(
    "trusted Pi runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_PI_RPC_COMMAND fallback",
  );
  const validateSnapshot = (expected?: { dev: number; ino: number }) => {
    let metadata: ReturnType<typeof lstatSync> | undefined;
    try {
      metadata = lstatSync(command);
      const directory = lstatSync(dirname(command));
      const uid = process.getuid?.();
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (metadata.mode & 0o777) !== 0o500 || !directory.isDirectory()
        || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
        || uid === undefined || metadata.uid !== uid || directory.uid !== uid
        || (expected !== undefined && (metadata.dev !== expected.dev || metadata.ino !== expected.ino))) {
        throw unavailable();
      }
      return metadata;
    } catch {
      throw unavailable();
    }
  };
  if (process.platform === "darwin" && isAbsolute(command) && basename(command) === "launch"
    && /^\.paperclip-verified-executable-[0-9a-f]{32}$/.test(basename(dirname(command)))) {
    const initial = validateSnapshot();
    let sourceFd: number;
    try { sourceFd = openSync(command, "r"); } catch { throw unavailable(); }
    const sourceMetadata = fstatSync(sourceFd);
    if (sourceMetadata.dev !== initial.dev || sourceMetadata.ino !== initial.ino) {
      closeSync(sourceFd);
      throw unavailable();
    }
    try {
      unlinkSync(command);
      rmdirSync(dirname(command));
    } catch (error) {
      closeSync(sourceFd);
      throw error;
    }
    let materialized = false;
    let materializedIdentity: { dev: number; ino: number } | undefined;
    const materializeForSpawn = () => {
      if (materialized) throw new Error("Verified Pi executable is still in use");
      let destinationFd: number | undefined;
      try {
        mkdirSync(dirname(command), { mode: 0o700 });
        chmodSync(dirname(command), 0o700);
        destinationFd = openSync(command, "wx", 0o700);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < sourceMetadata.size) {
          const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, sourceMetadata.size - offset), offset);
          if (count === 0) throw new Error("verified Pi snapshot ended early");
          let written = 0;
          while (written < count) {
            const countWritten = writeSync(destinationFd, buffer, written, count - written);
            if (countWritten === 0) throw new Error("verified Pi snapshot copy made no progress");
            written += countWritten;
          }
          offset += count;
        }
        fsyncSync(destinationFd);
        chmodSync(command, 0o500);
        const copied = fstatSync(destinationFd);
        materializedIdentity = { dev: copied.dev, ino: copied.ino };
        closeSync(destinationFd);
        destinationFd = undefined;
        materialized = true;
        validateSnapshot(materializedIdentity);
      } catch (error) {
        if (destinationFd !== undefined) closeSync(destinationFd);
        try { unlinkSync(command); } catch { /* best-effort cleanup */ }
        try { rmdirSync(dirname(command)); } catch { /* preserve original failure */ }
        throw error;
      }
    };
    return {
      command,
      commandLifecycle: {
        beforeSpawn: materializeForSpawn,
        afterSpawn() { validateSnapshot(materializedIdentity); },
        afterExit() {
          if (!materialized) return;
          validateSnapshot(materializedIdentity);
          unlinkSync(command);
          rmdirSync(dirname(command));
          materialized = false;
          materializedIdentity = undefined;
        },
      },
    };
  }
  throw new Error(
    "trusted Pi runner-owned executable binding is unavailable; refusing ambient PATH or PAPERCLIP_PI_RPC_COMMAND fallback",
  );
}
