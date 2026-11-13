import type { PluginDefinition } from "@paperclipai/plugin-sdk";
import { parseConfig, type G12Config } from "./config.js";
import { runTick } from "./backstop.js";

export function createG12Definition(): PluginDefinition {
  let companyId: string | null = null;
  let config: G12Config | null = null;
  let running = false;
  return {
    async setup(ctx) {
      ctx.jobs.register("g12-backstop", async () => {
        if (running) throw new Error("G12_JOB_ALREADY_RUNNING");
        running = true;
        try {
          if (!companyId) {
            ctx.logger.info("G12 tick counts", { configured: 0, wakes: 0 });
            return;
          }
          // Always re-read the explicit company: rejected/stale config delivery
          // must not leave a worker scanning with an older, enabled config.
          const current = parseConfig(await ctx.config.get(companyId));
          if (!config || current.companyId !== companyId) throw new Error("G12_COMPANY_BINDING_MISMATCH");
          await runTick(ctx, current);
        } catch (error) {
          const message = error instanceof Error && /^G12_[A-Z0-9_]+$/.test(error.message) ? error.message : "G12_JOB_FAILED";
          throw new Error(message);
        } finally { running = false; }
      });
    },
    async onConfigChanged(raw, context) {
      config = null; // Fail closed even if parsing / company validation fails.
      const next = parseConfig(raw);
      if (!context?.companyId || next.companyId !== context.companyId ||
          (companyId !== null && companyId !== context.companyId)) {
        throw new Error("G12_COMPANY_BINDING_MISMATCH");
      }
      companyId = context.companyId;
      config = next;
    },
    async onValidateConfig(raw) {
      try { parseConfig(raw); return { ok: true }; }
      catch { return { ok: false, errors: ["Invalid G12 configuration; use the documented company-scoped reference and owner mapping."] }; }
    },
  };
}
