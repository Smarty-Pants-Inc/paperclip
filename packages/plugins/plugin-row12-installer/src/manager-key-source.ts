import type { PluginContext } from "@paperclipai/plugin-sdk";
import { SafeFailure } from "./errors.js";

const MANAGER_KEY_SECRET_NAME = "manager_private_key";
const MANAGER_KEY_ANCHOR_NAME = "github-manager-key";

export interface ManagerKeySource {
  read(companyId: string, anchorProjectId: string): Promise<string>;
}

/** The sole production source: this plugin's project-scoped native instance secret. */
export class PluginInstanceSecretManagerKeySource implements ManagerKeySource {
  constructor(private readonly ctx: PluginContext) {}

  async read(companyId: string, anchorProjectId: string): Promise<string> {
    try {
      const project = await this.ctx.projects.get(anchorProjectId, companyId);
      if (!project || project.name !== MANAGER_KEY_ANCHOR_NAME || project.archivedAt !== null || project.leadAgentId !== null) {
        throw new Error("anchor project missing or invalid");
      }
      const tasks = await this.ctx.issues.list({ companyId, projectId: anchorProjectId, limit: 1, offset: 0 });
      if (tasks.length > 0) throw new Error("anchor project contains tasks");
    } catch {
      throw new SafeFailure("manager_key_anchor_unavailable: the dedicated, active, empty github-manager-key project is missing or invalid; no GitHub request was made.");
    }

    let values: Record<string, string>;
    try {
      values = await this.ctx.projects.getInstanceSecrets(anchorProjectId, companyId);
    } catch {
      throw new SafeFailure("Manager key unavailable; GitHub request was not made.");
    }
    const value = values[MANAGER_KEY_SECRET_NAME];
    if (typeof value !== "string" || value.length === 0) {
      throw new SafeFailure("Manager key unavailable; GitHub request was not made.");
    }
    return value;
  }
}
