// RFL judge: what the native GitHub broker does with a request delivered by the HTTP/2 duplex
// transport (execution-target.ts http2ForwardRequest: no bridgeGeneration, no bridgeTransport,
// forwarded only after http2-bridge-server.ts has buffered the whole body). Place in
// server/src/services/native-runtime/.
import { expect, it } from 'vitest';
import { createNativeGitHubAccess } from './native-github-access.js';

it('JUDGE-HTTP2: a stream opened under A and forwarded (body complete) under B gets B authority; no generation is required off the queue path', async () => {
  const scope = { companyId: 'c', agentId: 'a', issueId: 'i' };
  const resolved: string[] = [];
  let host: { url: string; token: string } | undefined;
  const calls: string[] = [];
  const broker = await createNativeGitHubAccess({
    scope, cwd: process.cwd(), env: { PATH: process.env.PATH }, target: null,
    resolveCredentials: async binding => { resolved.push(binding.runId); return { authority: binding.runId }; },
  }, (async (input: { hostApiUrl?: string | null; hostApiToken?: string | null }) => {
    host = { url: input.hostApiUrl!, token: input.hostApiToken! };
    // The shape the HTTP/2 branch returns (execution-target.ts ~:4960): no pause, no resume.
    return { env: { PAPERCLIP_API_URL: 'http://127.0.0.1:1', PAPERCLIP_API_KEY: 'bridge', PAPERCLIP_API_BRIDGE_MODE: 'http2_v1' },
      readRunDisposition: () => ({ failed: false }), markOrderlyCompletion: () => { calls.push('markOrderlyCompletion'); },
      stop: async () => { calls.push('stop'); } };
  }) as never);
  try {
    const releaseA = await broker.activate({ ...scope, runId: 'run-A' });
    // Sandbox: stream opened under A, HEADERS sent, DATA incomplete -> the host HTTP/2 server is still buffering.
    await releaseA();
    const releaseB = await broker.activate({ ...scope, runId: 'run-B' });
    // Sandbox: DATA completes -> http2ForwardRequest -> forwardBridgeRequest sets only these headers:
    const res = await fetch(`${host!.url}/runtime-tools/github/credentials`, { method: 'POST',
      headers: { authorization: `Bearer ${host!.token}`, 'x-paperclip-run-id': 'native-session-x', 'content-type': 'application/json' }, body: '{}' });
    const body = await res.text();
    await releaseB();
    console.log(JSON.stringify({ transport: 'http2 forward shape (no generation, no queue marker)', status: res.status, body, resolved, bridgeCalls: calls }));
    expect(resolved).not.toContain('run-B');
    expect(res.status).not.toBe(200);
  } finally { await broker.stop(); }
}, 30000);
