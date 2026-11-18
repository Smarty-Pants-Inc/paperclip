import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

interface PiResumeFileInput {
  runner: CommandManagedRuntimeRunner;
  node: string;
  providerPackRoot: string;
  directory: string;
  filename: string;
  normalizedSessionId: string;
  providerSessionId: string;
  providerBackendSessionId: string | null;
  workingDirectory: string;
}

// Execute the pack's own Pi validator on the execution host. In particular,
// realpath(cwd), no-follow, owner and JSONL identity checks must not be copied
// into controller-side heuristics (the controller may have another filesystem).
const validationScript = `
const { join, dirname, basename } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { realpath, copyFile, lstat, mkdir, rename, readlink, writeFile } = await import('node:fs/promises');
const { constants } = await import('node:fs');
const input = JSON.parse(process.argv[1]);
const { verifyPiSessionFile, quarantineInvalidPiSessionFile } = await import(pathToFileURL(join(input.providerPackRoot, 'dist/drivers/pi/pi-session-file.js')).href);
const snapshot = { driverSessionId: input.providerSessionId, providerSessionId: input.providerBackendSessionId ?? input.providerSessionId };
const workingDirectory = await realpath(input.workingDirectory);
const verify = filename => verifyPiSessionFile({ snapshot, runtimeDirectory: input.directory, filename, workingDirectory, signal: AbortSignal.timeout(10000) });
const classify = async filename => {
  try { await verify(filename); return 'valid'; }
  catch (error) {
    if (error.code === 'pi_session_file_missing') return 'missing';
    if (error.code === 'pi_session_file_invalid') return 'invalid';
    throw error;
  }
};
if (!input.candidate) {
  process.stdout.write(await classify(input.filename));
} else if (await classify(input.candidate) !== 'valid') {
  process.stdout.write('backup_invalid');
} else {
  const current = await classify(input.filename);
  if (current === 'valid') process.stdout.write('already_valid');
  else {
    // Preserve an invalid/foreign entry exactly as native fresh-thread recovery
    // does. A symlink is renamed, never followed. No notice is warranted when
    // the original conversation is successfully restored from its checkpoint.
    let preservedFile = null;
    if (current === 'invalid') {
      const name = await quarantineInvalidPiSessionFile(input.directory, input.normalizedSessionId);
      preservedFile = join(input.directory, name);
      const entry = await lstat(preservedFile);
      if (entry.isSymbolicLink()) {
        // A quarantined link must not poison the next no-links checkpoint.
        // Preserve the actual entry outside the live archive and retain inert
        // link evidence inside it. Never read/copy the foreign target's bytes.
        const directory = await realpath(input.directory);
        const evidenceDirectory = join(dirname(directory), basename(directory) + '.quarantined-links');
        await mkdir(evidenceDirectory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const evidence = await lstat(evidenceDirectory);
        if (!evidence.isDirectory() || (process.geteuid && evidence.uid !== process.geteuid())) throw new Error('unsafe Pi evidence directory');
        const original = join(evidenceDirectory, name);
        await rename(preservedFile, original);
        const moved = await lstat(original);
        if (moved.dev !== entry.dev || moved.ino !== entry.ino) throw new Error('Pi evidence identity changed');
        await writeFile(preservedFile + '.evidence.json', JSON.stringify({ kind: 'quarantined-symbolic-link',
          original, target: await readlink(original), dev: moved.dev, ino: moved.ino, uid: moved.uid, mode: moved.mode }), { flag: 'wx', mode: 0o600 });
        preservedFile = original;
      }
    }
    // Exclusive copy is no-clobber: a newly appearing entry cannot be silently
    // replaced. Retain the verified candidate as immutable repair evidence.
    await copyFile(join(input.directory, input.candidate), join(input.directory, input.filename), constants.COPYFILE_EXCL);
    await verify(input.filename);
    process.stdout.write(JSON.stringify({ restored: true, preservedFile }));
  }
}
`;

async function runValidation(input: PiResumeFileInput, candidate?: string): Promise<string> {
  const { runner, node, ...parameters } = input;
  const result = await runner.execute({ command: node, args: ["--input-type=module", "-e", validationScript,
    JSON.stringify({ ...parameters, candidate })], bypassSession: true, timeoutMs: 30_000 });
  if (result.timedOut || result.exitCode !== 0) throw new Error("runner_harness_state_mismatch: resume_file_validation_failed");
  return result.stdout.trim();
}

export async function probePiSessionResumeFile(input: PiResumeFileInput): Promise<"valid" | "missing" | "invalid"> {
  const result = await runValidation(input);
  if (result !== "valid" && result !== "missing" && result !== "invalid") throw new Error("runner_harness_state_mismatch: resume_file_validation_failed");
  return result;
}

/** Caller has verified the backup, exact suspended checkpoint, cursor and lease.
 * Staging alone is not validation: check the candidate before touching live data. */
export async function restorePiSessionResumeFile(input: PiResumeFileInput & {
  sourcePath: string;
  stageFile(sourcePath: string, targetPath: string): Promise<void>;
}): Promise<void> {
  const { sourcePath, stageFile, ...validation } = input;
  const candidate = `${input.filename}.restore-${randomUUID()}`;
  await stageFile(sourcePath, posix.join(input.directory, candidate));
  const result = await runValidation(validation, candidate);
  if (result === "backup_invalid" || result === "already_valid") return;
  if (JSON.parse(result).restored !== true) throw new Error("runner_harness_state_mismatch: resume_file_restore_failed");
}
