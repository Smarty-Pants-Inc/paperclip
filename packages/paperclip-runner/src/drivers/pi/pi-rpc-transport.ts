/** Fail-closed ownership stub. code-lead supplies the resident stdio JSONL client
 * for the pinned Paperclip Pi distribution, launched as `pi --mode rpc`.
 * Never send native Pi JSONL directly to runnerd's Codex-shaped facade.
 */
export class PiRpcTransport {
  async request(_command: Readonly<Record<string, unknown>>): Promise<never> {
    throw new Error("pi_rpc_transport_not_integrated");
  }
}
