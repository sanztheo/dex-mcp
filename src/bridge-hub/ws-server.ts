import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { AddressInfo } from "node:net";
import type { DexConfig } from "../config.js";
import { RpcClient } from "./rpc.js";

export class BridgeHub {
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private rpc?: RpcClient;

  constructor(
    private readonly config: DexConfig,
    private readonly onEvent?: (event: string, data: unknown) => void
  ) {}

  start(): Promise<number> {
    return new Promise((resolve) => {
      // Reject bad tokens at the HTTP handshake (401) — before the WS upgrade — so a
      // rejected client never fires `open`. (Accept-then-close races `open` before `close`.)
      this.wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.config.port,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? "", "ws://127.0.0.1");
          if (url.searchParams.get("token") === this.config.token) cb(true);
          else cb(false, 401, "invalid token");
        }
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.wss.on("listening", () => {
        const address = this.wss!.address() as AddressInfo;
        resolve(address.port);
      });
    });
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
  }
}
