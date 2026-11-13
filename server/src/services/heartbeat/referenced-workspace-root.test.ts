import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { projectWorkspaces } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAdditionalProjectWorkspace,
  resolveAdditionalRunWorkspaces,
  type ResolveAdditionalProjectWorkspaceDeps,
  type ResolveAdditionalRunWorkspacesOptions,
  type RunReferencedProject,
} from "./workspaces.js";

let root: string;
let runtime: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-referenced-root-"));
  runtime = path.join(root, "runtime");
  await fs.mkdir(runtime);
  vi.spyOn(os, "tmpdir").mockReturnValue(runtime);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const project = { projectId: "referenced", project: { id: "referenced" } } as RunReferencedProject;
function dependencies(cwd: string | null, repoUrl: string | null = null) {
  const deps = {
    loadProjectWorkspaceRows: vi.fn(async () => [{ id: "source", cwd, repoUrl, repoRef: null }] as typeof projectWorkspaces.$inferSelect[]),
    resolveConfiguredOrManagedProjectCwd: vi.fn(async () => ({ cwd: cwd ?? path.join(root, "managed"), warning: null })),
    ensureManagedProjectWorkspace: vi.fn(async () => ({ cwd: path.join(root, "managed"), warning: null })),
    directoryHasContents: vi.fn(async (_cwd: string) => true),
    realpath: (cwd: string) => fs.realpath(cwd),
  } satisfies ResolveAdditionalProjectWorkspaceDeps;
  return deps;
}
const input = { companyId: "company-one", project };

describe("referenced local workspace roots", () => {
  it.each(["runtime", "ancestor", "alias"])("refuses a configured %s before retaining or reading it", async (kind) => {
    const cwd = kind === "ancestor" ? root : kind === "alias" ? path.join(root, "alias") : runtime;
    if (kind === "alias") await fs.symlink(runtime, cwd);
    const deps = dependencies(cwd);
    await expect(resolveAdditionalProjectWorkspace(input, deps)).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: { workspaceValidation: { reason: "unsafe_workspace_root", cwd } },
    });
    expect(deps.resolveConfiguredOrManagedProjectCwd).not.toHaveBeenCalled();
    expect(deps.directoryHasContents).not.toHaveBeenCalled();
    expect(deps.ensureManagedProjectWorkspace).not.toHaveBeenCalled();
  });

  it.each(["child", "sibling"])("keeps a safe concrete %s workspace", async (kind) => {
    const cwd = kind === "child" ? path.join(runtime, "project") : `${runtime}-project`;
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "task.txt"), "real project content");
    const deps = dependencies(cwd);
    deps.directoryHasContents.mockImplementation(async () => (await fs.readdir(cwd)).length > 0);
    await expect(resolveAdditionalProjectWorkspace(input, deps)).resolves.toMatchObject({ cwd, projectId: project.projectId });
  });

  it.each(["configured", "managed"])("retains the physical %s source after its alias is retargeted", async (kind) => {
    const safe = path.join(root, "safe");
    const alias = path.join(root, "mutable-reference");
    await fs.mkdir(safe);
    await fs.writeFile(path.join(safe, "task.txt"), "authorized project");
    await fs.writeFile(path.join(runtime, "other-run.txt"), "unrelated run");
    await fs.symlink(safe, alias);
    const deps = dependencies(kind === "configured" ? alias : null, kind === "managed" ? "https://example.test/repo.git" : null);
    if (kind === "managed") {
      deps.directoryHasContents.mockResolvedValue(false);
      deps.ensureManagedProjectWorkspace.mockResolvedValue({ cwd: alias, warning: null });
    } else {
      deps.directoryHasContents.mockImplementation(async (cwd: string) => {
        expect(cwd).toBe(safe);
        return (await fs.readdir(cwd)).length > 0;
      });
    }
    const result = await resolveAdditionalProjectWorkspace(input, deps);
    expect(result.cwd).toBe(await fs.realpath(safe));
    await fs.unlink(alias);
    await fs.symlink(runtime, alias);
    expect(await fs.readFile(path.join(result.cwd, "task.txt"), "utf8")).toBe("authorized project");
    await expect(fs.readFile(path.join(result.cwd, "other-run.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never admits an unresolved source even when content inspection would succeed", async () => {
    const deps = dependencies(path.join(root, "missing"));
    await expect(resolveAdditionalProjectWorkspace(input, deps)).rejects.toThrow("has no workspace checkout");
    expect(deps.directoryHasContents).not.toHaveBeenCalled();
  });

  it("validates a resolved source before inspecting its contents", async () => {
    const deps = dependencies(path.join(root, "configured"));
    deps.resolveConfiguredOrManagedProjectCwd.mockResolvedValue({ cwd: runtime, warning: null });
    await expect(resolveAdditionalProjectWorkspace(input, deps)).rejects.toMatchObject({ code: "workspace_validation_failed" });
    expect(deps.directoryHasContents).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses a local repository root before materializing it (fallback=%s)", async (fallback) => {
    const deps = dependencies(fallback ? path.join(root, "missing") : null, `file://${runtime}`);
    deps.directoryHasContents.mockResolvedValue(false);
    await expect(resolveAdditionalProjectWorkspace(input, deps)).rejects.toMatchObject({ code: "workspace_validation_failed" });
    expect(deps.ensureManagedProjectWorkspace).not.toHaveBeenCalled();
    if (!fallback) expect(deps.resolveConfiguredOrManagedProjectCwd).not.toHaveBeenCalled();
  });

  it.each([false, true])("warns and drops only the unsafe reference (remote sandbox=%s)", async (executionTargetIsRemote) => {
    const safeCwd = path.join(runtime, "safe-project");
    await fs.mkdir(safeCwd);
    await fs.writeFile(path.join(safeCwd, "task.txt"), "safe project");
    const result = await resolveAdditionalRunWorkspaces("issue-one", "anchor-project", {
      enabled: true,
      executionTargetIsRemote,
      targetStagesConfined: true,
      remoteReferencedSyncEnabled: true,
      companyId: input.companyId,
      actor: { type: "agent", agentId: "agent-one", companyId: input.companyId, source: "agent_key" },
      issues: { findMentionedProjectIds: async () => ["unsafe-project", "safe-project"] },
      projects: { listByIds: async (_companyId, ids) => ids.map(id => ({ id })) as Awaited<ReturnType<ResolveAdditionalRunWorkspacesOptions["projects"]["listByIds"]>> },
      access: { decide: async () => ({ allowed: true, action: "project:read", reason: "allow_company_agent", explanation: "test allow" }) },
      resolveProjectWorkspace: (project) => resolveAdditionalProjectWorkspace(
        { companyId: input.companyId, project },
        dependencies(project.projectId === "unsafe-project" ? runtime : safeCwd),
      ),
    });
    expect(result.additionalWorkspaces).toEqual([expect.objectContaining({ cwd: safeCwd, projectId: "safe-project" })]);
    expect(result.failures).toEqual([{ projectId: "unsafe-project", reason: "resolution" }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Referenced project unsafe-project was skipped");
    expect(result.warnings[0]).toContain("runtime temporary staging");
  });

  it("validates a managed fallback before admitting it", async () => {
    const deps = dependencies(null, "https://example.test/repo.git");
    deps.directoryHasContents.mockResolvedValue(false);
    deps.ensureManagedProjectWorkspace.mockResolvedValue({ cwd: runtime, warning: null });
    await expect(resolveAdditionalProjectWorkspace(input, deps)).rejects.toMatchObject({ code: "workspace_validation_failed" });
  });
});
