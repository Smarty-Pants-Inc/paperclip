import { AsyncResource } from "node:async_hooks";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// Real SDK dispatch/ALS, with a setup-owned async resource for timer-like calls.
runWorker(definePlugin({
  async setup(ctx) {
    const proactive = new AsyncResource("config-scope-refresh");
    const companyId = process.env.SCOPE_TEST_COMPANY_ID;
    const otherCompanyId = process.env.SCOPE_TEST_OTHER_COMPANY_ID;
    const issueId = process.env.SCOPE_TEST_ISSUE_ID;
    let result;
    const readConfig = () => ctx.config.get(companyId);
    const readIssue = () => ctx.issues.get(issueId, companyId);
    ctx.jobs.register("config", async () => { result = await readConfig(); });
    ctx.jobs.register("issue", async () => { result = await readIssue(); });
    ctx.jobs.register("other", async () => { result = await ctx.config.get(otherCompanyId); });
    ctx.jobs.register("wildcard", async () => { result = await ctx.state.get({ scopeKind: "company", stateKey: "wildcard" }); });
    ctx.jobs.register("missing", async () => { result = await ctx.config.get(); });
    ctx.data.register("result", async () => result);
    ctx.data.register("proactive-config", async () => proactive.runInAsyncScope(readConfig));
    ctx.data.register("proactive-issue", async () => proactive.runInAsyncScope(readIssue));
    ctx.actions.register("cross-company", async () => ctx.config.get(otherCompanyId));
  },
}), import.meta.url);
