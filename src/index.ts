#!/usr/bin/env node
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { BridgeHub } from "./bridge-hub/ws-server.js";
import { getApiDump } from "./api-dump/fetch.js";
import { Session } from "./mcp/session.js";
import { buildServer } from "./mcp/server.js";

// Buffer + parse a JSON body for POST /mcp. The Streamable HTTP transport accepts a pre-parsed
// body (avoids re-reading the consumed stream); GET/DELETE carry no body.
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function isInitialize(body: unknown): boolean {
  const has = (m: unknown): boolean =>
    typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize";
  return Array.isArray(body) ? body.some(has) : has(body);
}

/**
 * Wire the MCP Streamable HTTP transport onto the hub's /mcp endpoint. One transport per MCP
 * session (created on `initialize`, keyed by the mcp-session-id header), all sharing the single
 * `Session` so the instance-ref cache survives reconnects. Stdio mode never calls this.
 */
function serveHttpMcp(hub: BridgeHub, session: Session): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  hub.setMcpHandler(async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = await readJsonBody(req);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (!isInitialize(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session; send an initialize request first." },
          id: null
        }));
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, transport!); }
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = buildServer(session);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, body);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const hub = new BridgeHub(config);
  const port = await hub.start();
  const dump = await getApiDump();
  const session = new Session(hub, config, dump);

  if (config.httpMode) {
    serveHttpMcp(hub, session);
    process.stderr.write(`[dex-mcp] remote mode: hub + bridge + MCP on 0.0.0.0:${port}\n`);
    process.stderr.write(`[dex-mcp]   bridge loader: GET /bridge?token=<token>\n`);
    process.stderr.write(`[dex-mcp]   MCP endpoint:  /mcp (Authorization: Bearer <token> or ?token=)\n`);
    process.stderr.write(`[dex-mcp]   API dump: ${dump ? "loaded" : "unavailable (bridge curated set)"}\n`);
    // The listening http server keeps the process alive — nothing else to await.
    return;
  }

  // Local mode: MCP over stdio, hub on loopback. IMPORTANT: stdout is the MCP channel — all
  // human-facing logging goes to stderr.
  process.stderr.write(`[dex-mcp] local mode: hub + bridge loader on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[dex-mcp] In your executor, run:\n`);
  process.stderr.write(`[dex-mcp]   loadstring(game:HttpGet("http://127.0.0.1:${port}/bridge"))()\n`);
  process.stderr.write(`[dex-mcp] (WebSocket auth token: ${config.token})\n`);
  process.stderr.write(`[dex-mcp] API dump: ${dump ? "loaded" : "unavailable (bridge curated set)"}\n`);

  const server = buildServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[dex-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
