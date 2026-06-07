import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "./session.js";
import type { ToolDef } from "./tools/types.js";
import { statusTools } from "./tools/status.js";
import { exploreTools } from "./tools/explore.js";
import { writeTools } from "./tools/write.js";
import { remoteTools } from "./tools/remotes.js";
import { luauTools } from "./tools/luau.js";

export function allTools(session: Session): ToolDef[] {
  return [
    ...statusTools(session),
    ...exploreTools(session),
    ...writeTools(session),
    ...remoteTools(session),
    ...luauTools(session)
  ];
}

export function buildServer(session: Session): McpServer {
  const server = new McpServer({ name: "dex-mcp", version: "0.1.0" });
  for (const tool of allTools(session)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler
    );
  }
  return server;
}
