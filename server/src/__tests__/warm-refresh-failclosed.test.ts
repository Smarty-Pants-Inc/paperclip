import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentInstructionWorkingCopies } from "@paperclipai/db";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { agentDirectoryWorkingCopyService } from "../services/agent-directory-working-copies.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";

async function fixture() {
  const f = await warmAgentFilesRefreshFixture();
  await fs.writeFile(path.join(f.root, "KEEP.md"), "checkpoint bytes\n");
  await fs.writeFile(path.join(f.root, "OBSOLETE.md"), "obsolete checkpoint\n");
  const a = await f.prepare("session-a"), b = await f.prepare("session-b");
  await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
  await fs.rename(path.join(b.copy.executionRoot, "OBSOLETE.md"), path.join(f.home, "peer-obsolete"));
  await fs.writeFile(path.join(b.copy.executionRoot, "PEER.md"), "peer work\n");
  await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
  return { f, a };
}
async function tree(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const filename = path.join(root, name), stat = await fs.lstat(filename);
    result.push([name, stat.mode, stat.ino, stat.isDirectory() ? await tree(filename) : (await fs.readFile(filename)).toString("base64")]);
  }
  return result;
}

describe("warm refresh fail-closed authority and no-write proof", () => {
  it.each(["before-commit", "lost-ack", "fake-ack", "unverifiable"] as const)("keeps EVERY file, without ANY cleanup, when the authority grant is %s", async fault => {
    const { f, a } = await fixture();
    const execute = a.target.runner!.execute;
    let authorityAttempted = false, readFault = false;
    const commands: string[] = [];
    a.target.runner!.execute = async input => {
      commands.push((input.args ?? []).join(" "));
      return execute(input);
    };
    try {
      const localBefore = await tree(path.dirname(a.copy.localRoot));
      const remoteBefore = await tree(a.target.remoteCwd);
      const faulty = agentDirectoryWorkingCopyService(f.db, async (...args) => {
        if (readFault) { readFault = false; throw Error("authority readback unavailable"); }
        return f.copies.get(...args);
      }, async (row, values) => {
        authorityAttempted = true;
        if (fault === "before-commit") throw Error("authority write failed");
        if (fault === "fake-ack") return { ...row, ...values };
        const [updated] = await f.db.update(agentInstructionWorkingCopies).set(values)
          .where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
        if (fault === "lost-ack") throw Error("commit acknowledgement lost");
        readFault = true;
        return updated!;
      });
      expect(await faulty.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId,
        target: a.target, canRefresh: async () => true })).toBe(false);
      expect(authorityAttempted).toBe(true);
      const pending = await f.copies.get(f.companyId, a.copy.runId);
      expect(pending).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_REFRESH_INCOMPLETE",
        receipt: { refreshCleanupBlocked: true } });
      // A newly constructed collector must honor the durable denial twice.
      const restarted = agentInstructionWorkingCopyService(f.db);
      for (let i = 0; i < 2; i++) {
        expect(await restarted.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))
          .toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_REFRESH_INCOMPLETE", receipt: { refreshCleanupBlocked: true } });
      }
      expect(commands).toEqual([]);
      expect(await tree(path.dirname(a.copy.localRoot))).toEqual(localBefore);
      expect(await tree(a.target.remoteCwd)).toEqual(remoteBefore);
      console.log(JSON.stringify({ case: "authority-fail-closed", fault, commands: commands.length, filesUnchanged: true }));
    } finally { a.target.runner!.execute = execute; await f.cleanup(); }
  }, 90000);

  it.each(["KEEP.md", "OBSOLETE.md"])("retires and normally saves %s edited after the final hash", async name => {
    const { f, a } = await fixture();
    const execute = a.target.runner!.execute;
    a.target.runner!.execute = async input => {
      const args = [...(input.args ?? [])];
      if (args[1]?.includes("Descriptor-relative refresh unavailable")) {
        args[1] = args[1].replace("const parentOf=name=>", `fs.writeFileSync(root+"/${name}","OWNER EDIT\\n"); const parentOf=name=>`);
      }
      return execute({ ...input, args });
    };
    try {
      expect(await f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId,
        target: a.target, canRefresh: async () => true })).toBe(false);
      expect(await f.copies.get(f.companyId, a.copy.runId)).toMatchObject({ state: "warm_saved", errorCode: null,
        receipt: { retirementRequired: true } });
      expect(await f.copies.canReuseWarm(f.companyId, f.agentId, a.copy.runId)).toBe("other");
      expect(await f.copies.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))
        .toMatchObject({ state: "saved", errorCode: null });
      expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe("OWNER EDIT\n");
      expect(await fs.readFile(path.join(f.root, "PEER.md"), "utf8")).toBe("peer work\n");
      console.log(JSON.stringify({ case: "post-hash-retire-save", name, saved: true, peerPreserved: true }));
    } finally { a.target.runner!.execute = execute; await f.cleanup(); }
  }, 90000);

  it.each([false, true])("retains a genuine late edit after partial writes (denialWriteFails=%s)", async denialWriteFails => {
    const { f, a } = await fixture();
    const execute = a.target.runner!.execute;
    let injected = false, denialAttempted = false;
    const refresh = denialWriteFails ? agentDirectoryWorkingCopyService(f.db, f.copies.get, async (row, values) => {
      if (values.receipt?.retirementRequired === true) {
        denialAttempted = true; throw Error("retention-denial persistence failed");
      }
      const [updated] = await f.db.update(agentInstructionWorkingCopies).set(values)
        .where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
      return updated!;
    }) : f.copies;
    a.target.runner!.execute = async input => {
      const args = [...(input.args ?? [])];
      if (args[1]?.includes("Descriptor-relative refresh unavailable")) {
        const needle = "verify(); checkFile(e.name);";
        expect(args[1]).toContain(needle);
        args[1] = args[1].replace(needle, `if(e.name==="KEEP.md")fs.writeFileSync(root+"/KEEP.md","LATE OWNER EDIT\\n");` + needle);
        injected = true;
      }
      return execute({ ...input, args });
    };
    try {
      expect(await refresh.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId,
        target: a.target, canRefresh: async () => true })).toBe(false);
      expect(injected).toBe(true);
      expect(denialAttempted).toBe(denialWriteFails);
      expect(await f.copies.get(f.companyId, a.copy.runId)).toMatchObject({ state: "unavailable",
        errorCode: "AGENT_FILES_REFRESH_INCOMPLETE", receipt: { refreshCleanupBlocked: true } });
      expect(await f.copies.canReuseWarm(f.companyId, f.agentId, a.copy.runId)).toBe("other");
      const restarted = agentInstructionWorkingCopyService(f.db);
      for (let i = 0; i < 2; i++) await restarted.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      expect(await fs.readFile(path.join(a.copy.executionRoot, "KEEP.md"), "utf8")).toBe("LATE OWNER EDIT\n");
      expect(await fs.readFile(path.join(f.root, "KEEP.md"), "utf8")).toBe("checkpoint bytes\n");
      expect(await fs.readFile(path.join(f.root, "PEER.md"), "utf8")).toBe("peer work\n");
      console.log(JSON.stringify({ case: "late-edit-after-partial-write", denialWriteFails, denialAttempted, retained: true, published: false }));
    } finally { a.target.runner!.execute = execute; await f.cleanup(); }
  }, 90000);
});
