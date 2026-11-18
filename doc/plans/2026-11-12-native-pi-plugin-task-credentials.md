# Native Pi credentials for plugin Runner tasks

The managed native Pi setup test now uses the same `runnerTask` owner as
Codex, with native `pi_rpc` launch requirements and the real tool-free Pi hello.
A successful test requires the exact provider/driver/model, a nonempty settled
hello, and confirmed physical cleanup. No credential ping or metadata-only
result counts as a pass.

## Boat owner handoff

No Boat plugin implementation is tracked in this Paperclip repository. A
case-insensitive tracked-source search for `boat`, including `packages/plugins`
and the environment plugin worker/runtime, finds fixtures and Pi tool policy but
no Boat consumer. The Boat plugin owner must implement the additive credential
variant below before this can verify production Boat hires. Existing plugins
that reject it remain fail-closed; deploying only the Core change is not a
production fix.

### Authoritative schema

`packages/plugins/sdk/src/environment-tasks.ts` defines
`environmentTaskCredentialSchema`. The new strict discriminant is `pi-env`:

```ts
type PiTaskCredential = {
  type: "pi-env";
  environment: {
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    GEMINI_API_KEY?: string;
    GOOGLE_API_KEY?: string;
    XAI_API_KEY?: string;
    PAPERCLIP_AI_PROVIDER_KEY?: string;
    PAPERCLIP_AI_PROVIDER_URL?: string;
    PAPERCLIP_AI_PROVIDER_PROTOCOL?: "messages" | "responses" | "chat";
    PAPERCLIP_AI_PROVIDER_AUTH?: "bearer" | "api_key" | "none";
  };
};
```

Both objects reject unknown fields. Credential strings are nonempty, NUL-free,
and at most 65,536 characters. The optional provider URL is HTTP(S), at most
2,000 characters, with no userinfo, query, or fragment. A standard provider
credential has exactly one key. A routed credential requires URL, protocol, and
auth together, and exactly the `PAPERCLIP_AI_PROVIDER_KEY` key unless auth is
`none`, which requires no key. Empty cleared variables are omitted by Core.

### Example transient submit RPC input (synthetic values only)

```json
{
  "kind": "submit",
  "preparedLaunchId": "boat-prepared-native-pi",
  "projectIds": [],
  "bootstrapTicket": "SYNTHETIC-ONE-TIME-PRP-TICKET",
  "credentialIdentity": "selected-credential-revision",
  "accountIdentity": "selected-account",
  "credential": {
    "type": "pi-env",
    "environment": {
      "PAPERCLIP_AI_PROVIDER_KEY": "SYNTHETIC-SELECTED-KEY",
      "PAPERCLIP_AI_PROVIDER_URL": "https://gateway.example/v1",
      "PAPERCLIP_AI_PROVIDER_PROTOCOL": "messages",
      "PAPERCLIP_AI_PROVIDER_AUTH": "bearer"
    }
  },
  "runner": {
    "protocolMin": 1,
    "protocolMax": 3,
    "harness": "pi_rpc",
    "runnerId": "probe-runner",
    "leaseId": "boat-lease",
    "runId": "probe-run",
    "sessionId": "probe-session",
    "turnId": "turn-probe-run",
    "itemId": "item-probe-run"
  }
}
```

The real submit also includes Core's existing `launch` limits and qualified
Runner version/digest. The preceding `prepare.requirements` selects
`provider: "pi_rpc"`, the unchanged exact model (for example
`paperclip/gateway/nested/claude-opus-5-5`), and
`settings.piRpcThinkingLevel` (for example `xhigh`). Model and thinking do not
travel in the credential object.

### Consumer requirements

- Upgrade the SDK schema used by the worker. Accept `pi-env` only for the exact
  prepared native `pi_rpc` harness, selected account and credential revision.
  Core's project-auth proof is likewise bound to provider `pi_rpc`.
- Prepare the qualified native Pi provider pack and preserve the exact requested
  model/thinking; do not substitute ACPX Pi, Claude, Codex, or a default model.
- Project only the allowlisted credential environment into the isolated prepared
  native Pi provider process. Do not inherit a different installed account.
  Keep credential mode, executable locations, runtime home, and command settings
  provider-owned; the `pi-env` object cannot override them. Use ordinary broker
  mode for managed routes rather than persisting the upstream key in models.json.
- Keep credentials and bootstrap tickets transient: never put them in lease
  metadata, prepared provider configuration, task output, error strings or logs.
  Retire the provider and release the prepared credential scope through the
  existing stop/status/complete contract, with `executionStopped: true` required.
- Native authentication and model rejections must reach Core's native probe,
  producing `pi_rpc_hello_probe_auth_required` / `harness_auth_failed` or
  `pi_rpc_hello_probe_model_unavailable` / `harness_model_unavailable`.
- Unmanaged plugin targets still require a saved managed connection; do not
  bypass that policy or test a host-local installed account as a substitute.

## Remaining real-run gate

`server/src/services/native-runtime/native-session-executor.ts` also rejects
`pi_rpc` in `preparePluginTaskOwner`'s workspace-harness guard. This probe-only
patch does not claim native Pi business-turn support on plugin tasks. The
execution owner must qualify that path (including provider preparation and
recovery) with the Boat consumer before production admission is considered fixed.
