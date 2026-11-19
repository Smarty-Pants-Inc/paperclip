import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { boardAccessRequired } from "../routes/authz.js";
import { buildOpenApiDocument } from "../routes/openapi.js";
import { AGENT_CHAT_DIRECTIVE } from "../services/agent-conversations.js";
import { EXECUTION_BLOCKER_PERSON_RETRY_ACTION } from "../services/execution-blocker.js";
import { buildRunnerApiCatalog } from "../services/native-runtime/runner-api-catalog.js";

// #21271 row W1: the agent-facing words say the current rule, and the old
// absolute claims are gone. Board-only actions keep board-only words.
describe("agent powers words (#21271)", () => {
  it("Retry: an agent may retry its own or a managed agent's non-chat task; the person-only claim is gone", () => {
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).not.toContain("Agents cannot retry it for them");
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toContain("so can the agent assigned to it or an agent that manages that agent");
    expect(EXECUTION_BLOCKER_PERSON_RETRY_ACTION).toContain("chat, whose Retry is its owner's");
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("its supported next step is the person's Retry on that task");
    expect(AGENT_CHAT_DIRECTIVE).toContain("You may press it yourself when the task is not a chat and is assigned to you or to an agent you manage");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Retry rechecks the task's current gates (budget, pause, holds)");
  });

  it("create org: the primary files one approval card; 'no agent credential can take' is gone", () => {
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("is a person's action that no agent credential can take");
    expect(AGENT_CHAT_DIRECTIVE).toContain("Only the person's selected primary agent may ask, and not on a Paperclip Cloud stack");
    expect(AGENT_CHAT_DIRECTIVE).toContain("when you are their primary, file one create_company approval");
    expect(AGENT_CHAT_DIRECTIVE).toContain("a new organization can't be deleted on hq");
  });

  it("board boundary and run cancel say the true rule", () => {
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("no agent credential, tool or other route can do it");
    expect(AGENT_CHAT_DIRECTIVE).toContain("that boundary is final for that operation");
    expect(AGENT_CHAT_DIRECTIVE).not.toContain("stops a queued or running one (board users only)");
    expect(AGENT_CHAT_DIRECTIVE).toContain("stops a queued or running one (a board user, or an agent that manages the run's agent)");
    // Board-only actions stay board-only in the words.
    expect(AGENT_CHAT_DIRECTIVE).toContain("Pausing, stopping or resuming a whole task tree (a parent task and all of its subtasks) is a person's control");
    const denial = boardAccessRequired({ actor: { type: "agent", agentId: "a" }, originalUrl: "/api/approvals/x/approve" } as unknown as Request);
    const remediation = String((denial as { details?: { remediation?: string } }).details?.remediation);
    expect(remediation).not.toContain("no agent credential, tool or other API route can do it");
    expect(remediation).toContain("This route is board-only and this denial is final for this action");
    expect(remediation).toContain("tell the person that a board user must do it");
  });

  it("catalog: Retry and budget policy writes admit agents; approve and incident resolution stay board-only", () => {
    const document = buildOpenApiDocument();
    expect(document.paths["/api/issues/{id}/retry"].post["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    expect(document.paths["/api/companies/{companyId}/budgets/policies"].post["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    expect(document.paths["/api/approvals/{id}/approve"].post["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(document.paths["/api/companies/{companyId}/budget-incidents/{incidentId}/resolve"].post["x-paperclip-authorization"]).toEqual({ actor: "board" });
    const retry = buildRunnerApiCatalog(document).find(operation => operation.operationId === "POST /api/issues/{id}/retry");
    expect(retry?.authorization).toEqual({ actor: "board_or_agent" });
    expect(retry?.description).toContain("An agent may retry a non-chat task assigned to itself or to an agent it manages");
  });
});
