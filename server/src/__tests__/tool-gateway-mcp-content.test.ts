import express from "express";
import request from "supertest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import type { ToolGatewayService } from "../services/tool-gateway.js";

describe("governed MCP content on the protocol route", () => {
  it("forwards a plugin image from data.content through the shared MCP projection", async () => {
    const content = [
      { type: "text", text: "one frame" },
      { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
    ];
    const executeTool = vi.fn().mockResolvedValue({
      result: { content: "one frame", data: { transport: "paperclip_plugin", content } },
    });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes({ executeTool } as unknown as ToolGatewayService));
    const response = await request(app).post("/mcp/gateways/test-gateway")
      .set("Authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "capture:frame", arguments: {} } })
      .expect(200);
    expect(response.body.result.content).toEqual(content);
    expect(JSON.stringify(response.body.result.structuredContent)).not.toContain("cGl4ZWxz");
  });
  it("returns native content from executeTool, without a second image in structuredContent", async () => {
    const content = [
      { type: "text", text: "governed screenshot" },
      { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
    ];
    const executeTool = vi.fn().mockResolvedValue({
      result: {
        content: JSON.stringify(content),
        data: { transport: "mcp_http", content, structuredContent: { width: 1 } },
      },
    });
    const app = express();
    app.use(express.json());
    app.use(mcpGatewayProtocolRoutes({ executeTool } as unknown as ToolGatewayService));

    const response = await request(app)
      .post("/mcp/gateways/test-gateway")
      .set("Authorization", "Bearer test-token")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } })
      .expect(200);

    expect(CallToolResultSchema.parse(response.body.result).content).toEqual(content);
    expect(JSON.stringify(response.body.result.structuredContent)).not.toContain("cGl4ZWxz");
    expect(executeTool).toHaveBeenCalledWith(expect.objectContaining({
      gatewayPublicId: "test-gateway", sessionToken: "test-token", tool: "screenshot",
    }));
  });
});
