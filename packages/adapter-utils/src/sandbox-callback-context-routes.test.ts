import { describe, expect, it } from "vitest";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
} from "./sandbox-callback-bridge.js";

const contextRequests = [
  { method: "GET", path: "/api/assets/screenshot-1/content" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1/files", query: "?path=references%2Fworkflow.md" },
  { method: "GET", path: "/api/issues/task-1/diagnostics/wakes" },
  { method: "POST", path: "/api/issues/task-1/monitor/check-now" },
];

const deniedRequests = [
  { method: "POST", path: "/api/assets/screenshot-1/content" },
  { method: "DELETE", path: "/api/assets/screenshot-1/content" },
  { method: "GET", path: "/api/assets/screenshot-1/content/extra" },
  { method: "PATCH", path: "/api/companies/company-1/skills/skill-1" },
  { method: "PATCH", path: "/api/companies/company-1/skills/skill-1/files" },
  { method: "DELETE", path: "/api/companies/company-1/skills/skill-1/files" },
  { method: "GET", path: "/api/companies/company-1/skills/skill-1/files/extra" },
  { method: "POST", path: "/api/issues/task-1/diagnostics/wakes" },
  { method: "GET", path: "/api/issues/task-1/diagnostics/wakes/extra" },
  { method: "GET", path: "/api/issues/task-1/monitor/check-now" },
  { method: "POST", path: "/api/issues/task-1/monitor/check-now/extra" },
  { method: "POST", path: "/api/issues/task-1/recovery-actions/resolve" },
];

const gatewayRequests = [
  { method: "POST", path: "/api/tool-gateway/sessions" },
  { method: "POST", path: "/api/tool-gateway/sessions/00000000-0000-4000-8000-000000000001/revoke" },
  { method: "GET", path: "/api/tool-gateway/tools" },
  { method: "POST", path: "/api/tool-gateway/tools/call" },
];

const deniedGatewayRequests = [
  { method: "GET", path: "/api/tool-gateway/sessions" },
  { method: "DELETE", path: "/api/tool-gateway/sessions/00000000-0000-4000-8000-000000000001/revoke" },
  { method: "POST", path: "/api/tool-gateway/tools" },
  { method: "GET", path: "/api/tool-gateway/tools/call" },
  { method: "POST", path: "/api/tool-gateway/sessions/" },
  { method: "POST", path: "/api/tool-gateway/sessions/00000000-0000-4000-8000-000000000001/revoke/extra" },
  { method: "POST", path: "/api/tool-gateway/sessions/00000000-0000-4000-8000-000000000001/extra/revoke" },
  { method: "GET", path: "/api/tool-gateway/tools/extra" },
  { method: "POST", path: "/api/tool-gateway/tools/call/extra" },
  { method: "POST", path: "/api/tool-gateway/admin" },
  { method: "POST", path: "/api/tool-gateway/approvals" },
  { method: "POST", path: "/api/tool-gateway/runtime" },
  { method: "POST", path: "/api/tool-gateway/mcp" },
];

describe.each([
  ["queue_v1", undefined],
  ["http2_v1", HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST],
] as const)("sandbox tool gateway over %s", (_transport, routes) => {
  it.each(gatewayRequests)("admits exact gateway request $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes)).toBeNull();
  });

  it.each(deniedGatewayRequests)("rejects unlisted gateway request $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes))
      .toBe(`Route not allowed: ${request.method} ${request.path}`);
  });
});

describe.each([
  ["queue", undefined],
  ["HTTP/2", HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST],
] as const)("sandbox task context over %s", (_transport, routes) => {
  it.each(contextRequests)("admits documented context request $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes)).toBeNull();
  });

  it.each(deniedRequests)("keeps unrelated operations denied: $method $path", request => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes(request, routes))
      .toBe(`Route not allowed: ${request.method} ${request.path}`);
  });
});
