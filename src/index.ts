#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { BridgeHub } from "./bridge-hub/ws-server.js";
import { getApiDump } from "./api-dump/fetch.js";
import { Session } from "./mcp/session.js";
import { buildServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const hub = new BridgeHub(config);
  const port = await hub.start();
  const dump = await getApiDump();

  // IMPORTANT: stdout is the MCP channel — all human-facing logging goes to stderr.
  const bridgeUrl = `ws://127.0.0.1:${port}?token=${config.token}`;
  process.stderr.write(`[dex-mcp] WebSocket hub + bridge loader on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[dex-mcp] In your executor, run:\n`);
  process.stderr.write(`[dex-mcp]   loadstring(game:HttpGet("http://127.0.0.1:${port}/bridge"))()\n`);
  process.stderr.write(`[dex-mcp] (WebSocket auth token: ${config.token})\n`);
  process.stderr.write(`[dex-mcp] API dump: ${dump ? "loaded" : "unavailable (bridge returns its curated property set)"}\n`);
  void bridgeUrl;

  const session = new Session(hub, config, dump);
  const server = buildServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[dex-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
