// Keep: S9 trust boundary. Run the same dependency-free real-process suite in
// focused Vitest checks and directly in the distribution smoke checks.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

it('resident guardian satisfies S9 over local clients and native fd4', { timeout: 90_000 }, async () => {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ['--test', fileURLToPath(new URL('./runner-guardian-flow.mjs', import.meta.url))],
      { timeout: 80_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Guardian S9 process suite failed:\n${stdout}\n${stderr}`));
        else resolve();
      });
  });
});
