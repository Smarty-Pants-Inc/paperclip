// Keep reason: provider prompt cache. `mcp.bindingId` is minted per RUN
// (`native-mcp:<runId>`, server runtime-context.ts). The driver serializes the runtime
// context into the host instructions inside the system prompt, so a per-run id there
// changed the prompt bytes on every run of the same native session and missed the
// provider cache on cold relaunch. Stopped at the real driver's spawn boundary: the
// assertion reads the actual --append-system-prompt file the driver hands to Pi.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalNativeRuntimeContextDigest, parseNativeRuntimeContext } from "../../contracts/runtime-context.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcTransportOptions } from "./pi-rpc-transport.js";

const stop = new Error("controlled stop at the Pi spawn boundary");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-mcp-binding-")); roots.push(root);
  const workspace = join(root, "workspace"), home = join(root, "agent"), bundle = join(root, "bundle");
  await mkdir(workspace); await mkdir(home); await mkdir(bundle);
  await writeFile(join(bundle, "AGENTS.md"), "stable instructions");
  return { root, workspace, home, bundle, runtimeDirectory: join(root, "sessions") };
}

function grant(bundle: string, bindingId: string | null, assigned = "same assigned tools") {
  const raw = { prompt: { revision: "t", text: "stable", digest: sha("stable") },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: "paperclip.runtime-asset.v1" as const, digest: sha("stable instructions"), manifestDigest: sha("manifest"), rootPath: bundle, fileCount: 1, totalBytes: 19 } },
    skills: [], mcp: { assignmentSetId: `sha256:${sha(assigned)}`, digest: sha(assigned), bindingId } };
  return parseNativeRuntimeContext({ ...raw, aggregateDigest: canonicalNativeRuntimeContextDigest(raw) });
}

/** One run's launch of the same native session: the host-instruction file bytes Pi appends to its system prompt. */
async function hostInstructions(f: Awaited<ReturnType<typeof fixture>>, runId: string, runtimeContext: unknown, sessionId = "same-session") {
  let launch: PiRpcTransportOptions | undefined, text = "";
  const driver = new PiRpcDriver({ model: "controlled/faux", piRpcThinkingLevel: "off", runtimeDirectory: f.runtimeDirectory, systemInstructions: "HOST_INSTRUCTIONS_STABLE", runtimeContext,
    environment: { PI_CODING_AGENT_DIR: f.home, HOME: f.root, PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "env", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only" },
    transportFactory: options => { launch = options; const args = options.args!; text = readFileSync(args[args.indexOf("--append-system-prompt") + 1]!, "utf8"); throw stop; } });
  await expect(driver.openSession({ runId, normalizedSessionId: sessionId, workingDirectory: f.workspace })).rejects.toBe(stop);
  // The boundary is P1c5b's concern (per native session); normalize it so this test
  // isolates the run-scoped MCP binding on any base.
  return text.split(launch!.env!.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY!).join("<BOUNDARY>");
}

describe("Pi host instructions: the MCP binding id is runner authority, not prompt bytes", () => {
  it("two RUNS of the same native session with an MCP assignment send byte-identical host instructions", async () => {
    const f = await fixture();
    const first = await hostInstructions(f, "run-1", grant(f.bundle, "native-mcp:run-1"));
    const second = await hostInstructions(f, "run-2", grant(f.bundle, "native-mcp:run-2"));
    expect(second).toBe(first);
    expect(first).not.toContain("native-mcp:");
    expect(first).not.toContain("bindingId");
    // The model still sees WHICH tools are assigned (digest), just not the run's binding handle.
    expect(first).toContain(sha("same assigned tools"));
    expect(first).toContain("<runtime_context>");
  });

  it("control: a changed MCP assignment still changes the host instructions", async () => {
    const f = await fixture();
    const before = await hostInstructions(f, "run-1", grant(f.bundle, "native-mcp:run-1"));
    const after = await hostInstructions(f, "run-2", grant(f.bundle, "native-mcp:run-2", "a different assignment"));
    expect(after).not.toBe(before);
    expect(after).toContain(sha("a different assignment"));
  });

  it("control: no MCP assignment (bindingId null) renders the assignment without a binding key", async () => {
    const f = await fixture();
    const text = await hostInstructions(f, "run-1", grant(f.bundle, null));
    expect(text).not.toContain("bindingId");
    expect(text).toContain(`"mcp":{"assignmentSetId":"sha256:${sha("same assigned tools")}","digest":"${sha("same assigned tools")}"}`);
  });
});
