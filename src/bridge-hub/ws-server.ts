import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DexConfig } from "../config.js";
import { RpcClient } from "./rpc.js";
import { assembleBridge } from "./bridge-loader.js";

// In remote/HTTP mode the same http.Server also serves the MCP transport at /mcp; index.ts
// registers the handler. Kept optional so local (stdio) mode needs no handler at all.
type McpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export class BridgeHub {
  private wss?: WebSocketServer;
  private http?: Server;
  private port = 0;
  private boundHost = "127.0.0.1";
  private socket?: WebSocket;
  private rpc?: RpcClient;
  private mcpHandler?: McpHandler;

  constructor(
    private readonly config: DexConfig,
    private readonly onEvent?: (event: string, data: unknown) => void
  ) {}

  setMcpHandler(handler: McpHandler): void {
    this.mcpHandler = handler;
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.http = createServer((req, res) => {
        // handleHttp is async (MCP requests await the transport); surface failures as 500
        // instead of an unhandled rejection that would crash the process.
        void Promise.resolve(this.handleHttp(req, res)).catch((err) => {
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end(`internal error: ${(err as Error).message}`);
        });
      });
      // Reject bad tokens at the HTTP handshake (401) — before the WS upgrade — so a
      // rejected client never fires `open`. (Accept-then-close races `open` before `close`.)
      this.wss = new WebSocketServer({
        server: this.http,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? "", "ws://127.0.0.1");
          if (url.searchParams.get("token") === this.config.token) cb(true);
          else cb(false, 401, "invalid token");
        }
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      // DEX_MCP_HOST wins; else remote mode binds 0.0.0.0 (platform router must reach it) and local
      // mode stays on loopback. An always-on LOCAL httpMode server sets DEX_MCP_HOST=127.0.0.1 to
      // get HTTP MCP without exposing the hub beyond the machine.
      const host = this.config.host ?? (this.config.httpMode ? "0.0.0.0" : "127.0.0.1");
      this.boundHost = host;
      this.http.listen(this.config.port, host, () => {
        this.port = (this.http!.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  private livePort(): number {
    // address() is set once listening; handles the ephemeral port:0 case used by tests.
    return (this.http?.address() as AddressInfo | null)?.port ?? this.port;
  }

  private isLoopbackBind(): boolean {
    return this.boundHost === "127.0.0.1" || this.boundHost === "localhost" || this.boundHost === "::1";
  }

  // The WebSocket origin the served bridge should dial back to. Use wss only when a TLS proxy
  // terminated upstream (Railway sets x-forwarded-proto=https); a direct/loopback bind is plain ws.
  private wsBase(req: IncomingMessage): string {
    if (!this.config.httpMode) return `ws://127.0.0.1:${this.livePort()}`;
    const host = req.headers.host ?? `127.0.0.1:${this.livePort()}`;
    const forwarded = (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0].trim();
    const scheme = forwarded === "https" || forwarded === "wss" ? "wss" : "ws";
    return `${scheme}://${host}`;
  }

  // Token may arrive as ?token=... (loader URL / bridge) or Authorization: Bearer <token> (MCP).
  private tokenOk(url: URL, req: IncomingMessage): boolean {
    if (url.searchParams.get("token") === this.config.token) return true;
    const auth = req.headers.authorization;
    return auth?.startsWith("Bearer ") ? auth.slice(7) === this.config.token : false;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "", "http://localhost");

    // Liveness for the platform healthcheck (and a friendly root instead of a bare 404).
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("dex-mcp ok");
      return;
    }

    // GET /bridge -> assembled Luau loader. Open on a loopback bind (safe bootstrap); token-gated
    // on a public bind because the payload embeds the shared token — a public /bridge would leak it.
    if (req.method === "GET" && url.pathname === "/bridge") {
      if (!this.isLoopbackBind() && !this.tokenOk(url, req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("invalid token");
        return;
      }
      const body = assembleBridge(this.wsBase(req), this.config.token);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }

    // /mcp -> MCP Streamable HTTP transport (remote mode only). Token-gated: this endpoint runs
    // arbitrary Luau in the game client.
    if (url.pathname === "/mcp") {
      if (!this.mcpHandler) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("mcp endpoint disabled (local stdio mode)");
        return;
      }
      if (!this.tokenOk(url, req)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("invalid token");
        return;
      }
      await this.mcpHandler(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private handleConnection(ws: WebSocket): void {
    // Token already verified at handshake. v1 single-bridge: a new connection replaces the old one.
    this.socket?.close();
    this.socket = ws;
    this.rpc = new RpcClient((msg) => ws.send(msg), {
      timeoutMs: this.config.rpcTimeoutMs,
      onEvent: this.onEvent
    });
    ws.on("message", (data: RawData) => this.rpc?.handleMessage(data.toString()));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.rpc?.rejectAll("bridge disconnected");
        this.socket = undefined;
        this.rpc = undefined;
      }
    });
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.rpc || !this.isConnected()) throw new Error("bridge not connected");
    return this.rpc.request(method, params);
  }

  async stop(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
  }
}
