import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Artifact gates, not product acceptance. Ordinary unit runs opt out; the
// Stage-0 qualification command explicitly supplies the transported packet.
const packet = process.env.PROJECT_CONNECTION_EVIDENCE_DIR;
describe.skipIf(!packet)("project connection transported and real-work evidence", () => {
  it("E01: every packaged relative target exists and pinned source bytes match", () => {
    const root = resolve(packet!);
    const checked: string[] = [];
    for (const name of ["design.md", "test-checklist.md", "evidence/round2/design.md", "evidence/round3/design.md", "evidence/round3/test-checklist.md"]) {
      const file = join(root, name);
      expect(existsSync(file), `transported document: ${name}`).toBe(true);
      const text = readFileSync(file, "utf8");
      const targets = [...text.matchAll(/\]\(([^\n)]+)\)|^\[[^\]]+\]:\s+(\S+)/gm)].map(match => (match[1] ?? match[2]!).replace(/^<|>$/g, ""));
      for (const target of targets) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
        const relative = decodeURIComponent(target.split("#")[0]!);
        const resolved = resolve(dirname(file), relative);
        expect(existsSync(resolved), `${name} → ${target}`).toBe(true);
        checked.push(`${name} → ${target}`);
      }
    }
    expect(checked.length).toBeGreaterThan(20);
    const manifest = JSON.parse(readFileSync(join(root, "evidence/source-manifest-r4.json"), "utf8")) as { pin: string; files: Array<{ path: string; sha256: string; pinned_blob_oid: string }> };
    expect(manifest.pin).toBe("5b0145ab4c477106d1758a960e0fff69c84ec23e");
    for (const entry of manifest.files) {
      const bytes = readFileSync(join(root, "evidence/source", entry.path));
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), entry.path).toBe(entry.pinned_blob_oid);
    }
  });

  it("A13: actual recipient list and daily-work receipts are required; synthetic fixtures are not rollout proof", () => {
    const receiptPath = process.env.PROJECT_CONNECTION_REAL_WORK_RECEIPT;
    expect(receiptPath, "A13 BLOCKED: authorized lead must supply real company/recipient/human-install/build/activity/provider evidence; do not substitute a test organization").toBeTruthy();
    const receipt = JSON.parse(readFileSync(receiptPath!, "utf8")) as {
      companyId: string; synthetic: boolean; buildSha: string; recipients: unknown[];
      tokenRepositoryNames: string[]; evidence: Record<string, string>;
    };
    expect(receipt.synthetic).toBe(false);
    expect(receipt.companyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.buildSha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.recipients.length).toBeGreaterThan(0);
    expect(receipt.tokenRepositoryNames).toEqual(["smarty-poc-work"]);
    for (const name of ["humanInstall", "managerCustody", "freshTokenFree", "makeBeforeBreak", "failedSecondOperation", "sharedLeadA", "sharedLeadB", "newHirePush", "wrongProjectRefusal", "retireReceipt", "nextPushDenied"]) {
      expect(receipt.evidence[name], name).toMatch(/^https:\/\//);
    }
  });
});
