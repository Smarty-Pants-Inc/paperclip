import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPiLaunchSpec } from "./pi-acp-runtime.js";
import { createPiExtensionSnapshot } from "./pi-extension-snapshot.js";
import { createNativeAcpxDistributionSnapshot } from "./native-distribution-integrity.js";
import { verifyPiRuntimeManifest, type PiRuntimeManifest } from "./pi-verified-runtime.js";

// Opt-in actual-distribution coverage: no model request or subagent tool runs.
it.runIf(process.env.PAPERCLIP_TEST_PI_DISTRIBUTION_ROOT && process.env.PAPERCLIP_TEST_PI_PACKAGES).each([false, true])(
  "loads the real tool cap, pi-subagents and Langfuse with owned readiness (native discovery: %s)",
  async nativeExtensions => {
    const distribution = process.env.PAPERCLIP_TEST_PI_DISTRIBUTION_ROOT!;
    const metadata = JSON.parse(await readFile(join(distribution, "pi-distribution.json"), "utf8"));
    const runtime = join(distribution, "runtime");
    await verifyPiRuntimeManifest(runtime, metadata.manifest as PiRuntimeManifest);
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-installed-extensions-")));
    let native: Awaited<ReturnType<typeof createNativeAcpxDistributionSnapshot>> | undefined;
    let extensions: Awaited<ReturnType<typeof createPiExtensionSnapshot>> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const workspace = join(root, "workspace"), home = join(root, "home"), tools = join(root, "tools");
      await mkdir(workspace); await mkdir(home); await mkdir(tools);
      if (nativeExtensions) {
        // This directory was installed by the pinned CLI's real pi install.
        const installedHome = process.env.PAPERCLIP_TEST_PI_NATIVE_AGENT_DIR;
        if (!installedHome) throw new Error("Native package proof requires a pi install agent directory");
        await cp(installedHome, home, { recursive: true });
        const settingsPath = join(home, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        expect(settings.packages).toContain("npm:pi-annotate@0.5.2");
        await writeFile(settingsPath, JSON.stringify({ ...settings, sessionDir: join(root, "user-session-escape") }));
        await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
        await writeFile(join(workspace, ".pi", "extensions", "project.ts"), `export default pi=>pi.registerCommand("project-native-proof",{description:"Project discovery",handler:async()=>{}});`);
        await writeFile(join(workspace, ".pi", "configured.ts"), `export default pi=>pi.registerCommand("project-settings-proof",{description:"Project settings",handler:async()=>{}});`);
        await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({ extensions: ["./configured.ts"], sessionDir: join(root, "project-session-escape") }));
        await mkdir(join(workspace, ".pi", "skills", "native-proof"), { recursive: true });
        await writeFile(join(workspace, ".pi", "skills", "native-proof", "SKILL.md"), "---\nname: native-proof\ndescription: Native package skill discovery\n---\nProof only.\n");
        await mkdir(join(workspace, ".pi", "prompts"));
        await writeFile(join(workspace, ".pi", "prompts", "native-template.md"), "---\ndescription: Native prompt discovery\n---\nProof only.\n");
      }
      const cap = join(tools, "cap.ts");
      await writeFile(cap, `export default function(pi) {
        const ownedFirst=process.env.PAPERCLIP_PI_RUNTIME_CONFIGURATION===undefined;
        pi.registerCommand("operator-cap-proof",{description:"Operator file",handler:async()=>{}});
        pi.on("session_start",(_event,ctx)=>{pi.appendEntry("native-proof",{});ctx.ui.setStatus("native-session-proof",JSON.stringify({ownedFirst,sessionFile:ctx.sessionManager.getSessionFile()}));});
        pi.registerTool({name:"operator_cap",label:"Operator cap",description:"No side effects",parameters:{type:"object",properties:{}},
          async execute(){return {content:[{type:"text",text:"ready"}],details:{}};}});
        pi.on("session_start",(_event,ctx)=>ctx.ui.setStatus("operator-cap",JSON.stringify(pi.getAllTools().map(tool=>tool.name))));
      }`);
      extensions = await createPiExtensionSnapshot([cap, ...JSON.parse(process.env.PAPERCLIP_TEST_PI_PACKAGES!)]);
      const { entries } = JSON.parse(await readFile(join(distribution, "native-closure.json"), "utf8"));
      native = await createNativeAcpxDistributionSnapshot({ distributionRoot: runtime, manifestPath: join(distribution, "native-closure.json"),
        expectedClosureSha256: metadata.nativeClosureSha256, executable: metadata.manifest.node, entrypoint: "pi-entry.cjs", fixedArguments: [] }, entries, undefined, extensions, nativeExtensions);
      const bound = native.snapshot.roots[0]!;
      const launch = createPiLaunchSpec({ cwd: workspace }, {
        PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, PI_CODING_AGENT_SESSION_DIR: join(root, "env-session-escape"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        ...(nativeExtensions ? { PAPERCLIP_PI_ADMITTED_NATIVE_EXTENSIONS: "1" } : {}),
        PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1", PAPERCLIP_PI_READ_ONLY: "1",
        PAPERCLIP_PI_NODE_EXECUTABLE: join(bound, metadata.manifest.node), PAPERCLIP_PI_ENTRYPOINT: join(bound, metadata.manifest.piEntrypoint),
        PAPERCLIP_PI_EXTENSION_PATH: join(bound, metadata.manifest.extension), PAPERCLIP_PI_MODULE_GUARD_PATH: join(bound, ".paperclip-native-module-guard.cjs"),
        PAPERCLIP_PI_PROTECTED_ROOTS: JSON.stringify([home, ...native.snapshot.roots]),
        PAPERCLIP_PI_ADMITTED_EXTENSIONS: JSON.stringify(extensions.paths), PAPERCLIP_PI_ADMITTED_EXTENSION_ROOTS: JSON.stringify(extensions.snapshot.roots),
        // Import and initialize the actual plugin/dependencies; no export credential is used.
        LANGFUSE_TRACING_ENABLED: "false",
      });
      expect(launch.args.filter(arg => arg === "-e")).toHaveLength(4);
      const owned = launch.args.indexOf("-e"); expect(launch.args[owned + 1]).toBe(join(bound, metadata.manifest.extension));
      child = spawn(launch.command, launch.args, { cwd: workspace, env: launch.env, stdio: "pipe" });
      let stderr = "", buffered = ""; const frames: any[] = [];
      child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const commands = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Pi readiness timed out: ${stderr}`)), 20_000);
        child!.once("error", error => { clearTimeout(timer); reject(error); });
        child!.once("exit", () => { clearTimeout(timer); reject(new Error(`Pi exited before readiness: ${stderr}`)); });
        child!.stdout!.on("data", chunk => {
          buffered += String(chunk);
          for (;;) {
            const at = buffered.indexOf("\n"); if (at < 0) break;
            const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); if (!line.trim()) continue;
            const frame = JSON.parse(line); frames.push(frame);
            if (frame.id === "readiness") { clearTimeout(timer); resolve(frame); }
          }
        });
        child!.stdin!.write(`${JSON.stringify({ type: "get_commands", id: "readiness" })}\n`);
      });
      const response = await commands;
      expect(response.success).toBe(true);
      expect(response.data.commands).toContainEqual(expect.objectContaining({ name: "paperclip-runtime-ready-v1", description: "Paperclip runtime gate v1" }));
      expect(stderr).not.toMatch(/Failed to load extension|escaped its closed distribution|digest mismatch/);
      if (nativeExtensions) {
        expect(response.data.commands).toEqual(expect.arrayContaining(["annotate", "project-native-proof", "project-settings-proof", "skill:native-proof", "native-template"].map(name => expect.objectContaining({ name }))));
        for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve"]) expect(launch.args).not.toContain(flag);
        const sessionProof = JSON.parse(frames.find(frame => frame.statusKey === "native-session-proof")?.statusText ?? "null");
        expect(sessionProof.ownedFirst).toBe(true);
        expect(sessionProof.sessionFile.startsWith(join(home, "sessions") + "/")).toBe(true);
        // Pi creates the JSONL lazily on a conversational message; no model
        // prompt is sent by this registration-only proof.
      }
      const toolProof = frames.find(frame => frame.type === "extension_ui_request" && frame.statusKey === "operator-cap");
      expect(JSON.parse(toolProof?.statusText ?? "null")).toEqual(expect.arrayContaining(["operator_cap", "subagent"]));
      const langfuseProof = frames.find(frame => frame.type === "extension_ui_request" && frame.statusKey === "langfuse");
      expect(langfuseProof).toMatchObject({ statusText: "langfuse: off (no keys)" });
      console.info(JSON.stringify({ nativeExtensions, launchArgs: launch.args, toolProof, langfuseProof,
        commands: response.data.commands, sessionProof: frames.find(frame => frame.statusKey === "native-session-proof"),
        ownedCommand: response.data.commands.find((command: { name: string }) => command.name === "paperclip-runtime-ready-v1") }, null, 2));
    } finally {
      if (child) {
        child.stdin!.end();
        if (child.exitCode === null) { const timer = setTimeout(() => child!.kill("SIGKILL"), 2000); await once(child, "close"); clearTimeout(timer); }
      }
      if (native) { await native.commandDirectory.close(); await native.snapshot.close(); }
      else await extensions?.snapshot.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000,
);
