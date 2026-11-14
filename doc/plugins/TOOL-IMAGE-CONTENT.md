# Plugin tool image content: seam and privacy boundaries

The bridge adopts the existing native MCP projection carried from upstream
[paperclipai/paperclip#16517](https://github.com/paperclipai/paperclip/pull/16517).
It adds no second route or MCP protocol. The plugin-owned SDK contract is
`ToolResult.mcpContent`, an explicit optional top-level field (not legacy
`data.content`);
[the plugin spec](./PLUGIN_SPEC.md#143-native-tool-result-images) has an example.

## Contract and ownership

- `packages/plugins/sdk/src/types.ts:286` exports the optional `mcpContent`
  field/content union; historical `ToolResult` and arbitrary `data.content`
  remain unchanged without that explicit field. The [five-line SDK seam
  decision](./TOOL-IMAGE-SDK-SEAM.md) records the read-only upstream check.
- `server/src/services/plugin-tool-result.ts:20` validates canonical base64,
  PNG/JPEG/WebP MIME, 5 MiB decoded/image, 10 MiB decoded/result including
  text/metadata, and 64 blocks including legacy text. It rejects unsupported,
  malformed or oversized native blocks before storage; no silent truncation.
- The same module's `preparePluginToolResult` writes bounded image bytes through
  the existing company-scoped storage service. References contain SHA-256,
  decoded size, MIME, provider and private object key. There is no public URL,
  new storage backend, schema or artifact-publication path. Failure does not
  return success; earlier writes from a failed multi-image write are cleaned up
  best-effort. Existing storage policy governs retention.
- `server/src/services/plugin-tool-registry.ts:439` validates the worker result
  at the dispatcher boundary. `server/src/services/tool-gateway.ts` calls the
  preparation helper in normal MCP execution and direct plugin execution;
  existing access, policy, approval and audit ownership stays in the gateway.
- `server/src/services/tool-gateway-mcp-result.ts:15` admits the plugin transport
  to the same governed native-content projection as remote MCP. It removes the
  duplicate content array from structured metadata, so the wire response has
  one image block, not an image plus a JSON-encoded copy. Legacy results that
  do not opt into top-level `mcpContent` retain the historical envelope and
  complete response bytes, even with MCP-looking legacy `data.content`.

The guard changes are shared because both remote MCP and plugin images can
reach the existing audit/classifier entry points. The runner change belongs in
its existing display/event projector, not in the plugin or a new logger. With
no image, those consumers keep their existing text behavior. There is no new
runtime dependency; hashing uses Node crypto and storage uses the existing
service. The HTTP acceptance test uses real local storage, including failed
cross-company reads; unit tests inject a storage failure and cancellation.

## Distinguish conversation history from logs

**Native Pi conversation history is allowed to contain image bodies. It is not
image-free.** The capture is model working history in that conversation and its
native trace. Pi 1.5.2's
`@earendil-works/pi-coding-agent/dist/core/session-manager.js:839` appends the
message; `:813` serializes entries as JSONL. Native-history copies/backups are
copies of that conversation trace, not an image-free audit log.

Image bodies must not enter this bridge's server logs, gateway audit/classifier
capture or run events:

| Surface | Representation and code boundary |
| --- | --- |
| Gateway audit summaries and invocation receipts | `server/src/services/tool-content-guards.ts:300` replaces native image blocks with SHA-256 + decoded size + reference before redaction, hashing and bounded previews. The prepared result also carries private storage references. |
| Prompt-injection model capture and regex fallback | `tool-content-guards.ts:321` creates the referenced view before classifier serialization. Text still passes through the existing guards. `:368` restores only opaque image bodies into the governed return value for the caller/model. |
| Server logging | Native-validation and SDK parser errors use content-free reasons. `server/src/services/plugin-worker-manager.ts:1201` logs malformed frames as byte count + SHA-256 + reference, never raw prefixes or parser error prose; the real-worker regression covers malformed JSON and hostile JSON-RPC versions. Plugin authors must not manually log or stringify images into text, errors or arbitrary metadata. |
| Runner/run-event display | `packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts:52` replaces each image with an omission marker plus SHA-256, decoded size, MIME and a content-address reference before tool-output projection. Native input is not mutated. Existing display bounds still apply. |
| Native model/history | Actual MCP/Pi image blocks, intentionally including the body. This is distinct from the projections above. |
| Langfuse cloud export | **Open upstream tracker below. Not reference-only today.** |

This is byte/transport protection, not visual-content safety classification.
The text guard does not inspect pixels or establish that instructions inside a
screenshot are harmless. No screenshot/desktop capture or consent UI is added
by this bridge.

## Pi model delivery (pinned 1.5.2)

The pin is `packages/paperclip-runner/pi-rpc-distribution.json`.
The relevant dependency paths are relative to their installed packages:

- `@earendil-works/pi-mcp/dist/protocol/content.js:5` forwards MCP image data and
  MIME unchanged to Pi content; `:34` exports the tool-result conversion.
- `@earendil-works/pi-ai/dist/api/anthropic-messages.js:84` converts images to
  Anthropic base64 source blocks; `:1224` places converted content inside
  `tool_result`.
- `@earendil-works/pi-ai/dist/api/openai-completions.js:1082` emits tool images as
  adjacent user `image_url` blocks, with `data:<mime>;base64,...` at `:1088`.
  **It omits images for a text-only model** (`model.input` lacks `image`). Choose
  a vision-capable model; this bridge does not change upstream model capability
  handling. Such data URLs are intentional model input, not permitted logs.
- `pi-tool-image-delivery.test.ts` executes both pinned provider serializers,
  stopping Anthropic before any network send. It also records the text-only
  Chat Completions limitation. This is serialization proof, not a live model's
  successful interpretation of a screenshot.

## Langfuse: keep ON; upstream RED tracker

The public fixture pins `@langfuse/pi-observability-plugin@0.1.2` in
`server/src/__tests__/fixtures/pi-home/langfuse-pi/package.json:6`. The runner's
subagent child bridge loads the admitted extension at
`packages/paperclip-runner/src/drivers/pi/extension/subagents/child-bridge.ts:62`.
The exporter is owned by that external plugin, not this server's guard or
runner event projector. No plugin fork, private extension copy, global setting
change or Langfuse-disable change is included here.

Checked npm's published versions/readme and the public repository on 2026-11-14:
latest is **0.1.2**, versions 0.1.0/0.1.1/0.1.2. The published source is available
in the [npm tarball](https://registry.npmjs.org/@langfuse/pi-observability-plugin/-/pi-observability-plugin-0.1.2.tgz).
The following line numbers are in **that package's `src/index.ts`**, not a file
vendored into Paperclip:

1. `:794-798` extracts images from `tool_execution_end`, formats the tool span's
   output using image markers, and retains raw images in `state.turnImages`.
2. `:539-542` puts the accumulated images into the root turn's multimodal input.
   `:268-290` constructs base64 data URLs; this is where a tool-result image is
   handed to the third-party exporter even though the tool span itself uses a
   marker. The SDK may replace span fields with media references **after
   uploading the media body**; that is not SHA/size-only egress.
3. `:387-393` constructs `LangfuseSpanProcessor` with a hard-coded API-key/secret
   redactor. The plugin exposes **no configurable masking callback**. Langfuse's
   SDK [does document a `mask` callback](https://langfuse.com/docs/observability/features/masking)
   and [media-upload processing](https://js.reference.langfuse.com/classes/_langfuse_otel.LangfuseSpanProcessor.html),
   but SDK capability is not a plugin option.
4. **An option exists, but is insufficient:** `LANGFUSE_MEDIA_UPLOAD_ENABLED=false`
   is read at `:33-35` and suppresses raw image attachment at `:539`. Tracing
   stays on and text markers remain, but there is no SHA-256 or exact decoded
   byte-size reference. It is source-supported, not listed in the 0.1.2 README's
   option table. The README documents a tracing kill switch; that is not used.
5. Public repository main
   [`237e61c38f066c1aeebd2817f051b2a5baa1741d`](https://github.com/langfuse/pi-observability-plugin/blob/237e61c38f066c1aeebd2817f051b2a5baa1741d/src/index.ts#L313-L328)
   still constructs data URLs, has the media flag at `:37-39`, hard-coded mask
   at `:625`, and root media input at `:780-783`. No adoptable published version
   or exposed option was found that exports **SHA-256 + exact size + MIME only**.

`scripts/smoke/langfuse-plugin-image-export-tracker.mjs` is an **opt-in,
intentionally RED upstream tracker**, not a passing default CI test. It executes
the unmodified public plugin factory with fake Pi/OTel/Langfuse hosts, captures
its serialized observation payload after its own mask at the exporter handoff,
and makes no cloud requests. It is not an actual SDK/media-upload network test.
Run it against the unpacked published source:

```sh
node scripts/smoke/langfuse-plugin-image-export-tracker.mjs /absolute/path/to/pi-observability-plugin/src/index.ts
```

Expected current result: exit 1, two assertion failures. Media enabled exposes
the body/data URL without the required SHA/size reference; media disabled omits
the body but still lacks the required SHA/size reference. Failures print only
booleans, never the image bytes. Langfuse remains **ON** under the acceptance
decision. Until an adopt-first option provides SHA/size-only export, the
screen-capture consent/access line must explicitly name **Langfuse** as well as
conversation history. The capture owner supplies that line; this bridge does
not claim it has implemented or tested that UI.
