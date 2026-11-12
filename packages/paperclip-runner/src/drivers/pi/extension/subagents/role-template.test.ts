import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateRoleTemplate } from "./role-template.js";
import { validateChildSelection } from "./selection.js";

const plain = "---\nname: reviewer\ndescription: Review changes\ntools: read, grep\n---\nReview the real change.\n";
describe("F084 role-only reusable templates (trust boundary)", () => {
  it("rejects runtime identity in reusable role frontmatter", () => {
    for (const field of ["model", "provider", "thinking", "effort", "runtime", "grantVersion", "runId"]) {
      expect(() => validateRoleTemplate(plain.replace("name: reviewer", `${field}: high`))).toThrow(field);
    }
    expect(() => validateRoleTemplate("---\nname: reviewer\nconfig: { thinking: high }\n---\nRole\n")).toThrow(/thinking/);
    expect(validateRoleTemplate(plain)).toMatchObject({ text: plain });
    expect(validateRoleTemplate("Plain role text without frontmatter").text).toBe("Plain role text without frontmatter");
    expect(validateRoleTemplate("---\n---\nRole only").text).toBe("---\n---\nRole only");
    expect(() => validateRoleTemplate("---\nname: a\nname: b\n---\nrole")).toThrow(/frontmatter/i);
    expect(() => validateRoleTemplate("---\nmodel: [\n---\nrole")).toThrow(/frontmatter/i);
    expect(() => validateRoleTemplate("---\nthinking: high")).toThrow(/frontmatter/i);
  });

  it("reuses one role with two independent explicit selections", () => {
    const role = validateRoleTemplate(plain);
    const base = { roleId: "reviewer", roleDigest: role.digest, paretoChoice: "frontier", paretoRevision: "r1", complexity: "small", rationale: "lookup", budget: 1 };
    const catalog = (model: string) => ({ provider: "n", id: model.slice(2), family: "other" as const, thinkingLevels: ["high", "max"] as const });
    const first = validateChildSelection({ ...base, selectionId: "a", model: "n/one:high" }, catalog);
    const second = validateChildSelection({ ...base, selectionId: "b", model: "n/two:max" }, catalog);
    expect(first.roleDigest).toBe(second.roleDigest);
    expect(first.selectionId).not.toBe(second.selectionId);
    expect(first.model).not.toBe(second.model);
    expect(validateRoleTemplate(plain)).toEqual(role);
  });

  it("does not count stock pi-subagents worker thinking high as compliant", () => {
    // Exact package/agents/worker.md from https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.88.0.tgz
    // Tarball sha256: 906cc26f263e3f50c078b4cc32a338d87ecdd0c0a1a7279ca2f427297f5c67db
    // Fixture sha256: 2c3dcbebd084e744c70515ddad0a87d8d4795f477967e5fe9fdefbcb3de7f26a
    const stock = readFileSync(new URL("./fixtures/pi-subagents-0.88.0-worker.md", import.meta.url), "utf8");
    expect(createHash("sha256").update(stock).digest("hex")).toBe("2c3dcbebd084e744c70515ddad0a87d8d4795f477967e5fe9fdefbcb3de7f26a");
    expect(stock).toMatch(/thinking: high/);
    expect(() => validateRoleTemplate(stock)).toThrow(/thinking/);
  });
});
