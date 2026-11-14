// Independent class-coverage checks using diagnostics emitted by the reviewed Rust source.
import { describe, it, expect } from 'vitest';
import { nativeSessionFailureSourceCode, nativeSessionFailureDisposition } from './native-session-executor.js';

describe('RFL native-emitted launch-profile refusal class', () => {
  it.each(['Pi', 'OpenCode', 'Cursor Cloud'])('permanently classifies run.prepare durable-run profile drift for %s', provider => {
    const receipt = { commandType: 'run.prepare', status: 'failed', result: {
      code: 'command_execution_failed', message: `${provider} runner launch profile changed across the durable run`,
    }};
    const error = new Error(`PRP command run.prepare failed: ${JSON.stringify(receipt)}`);
    const code = nativeSessionFailureSourceCode(error);
    const disposition = nativeSessionFailureDisposition(1, new Date(0), code);
    console.log('RFL_EMITTED_REFUSAL', JSON.stringify({provider, code, disposition}));
    expect(code).toBe('native_runner_launch_profile_mismatch');
    expect(disposition.phase).toBe('terminal_failure');
    expect(disposition.nextAttemptAt).toBeNull();
  });
});
