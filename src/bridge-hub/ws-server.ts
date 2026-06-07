import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { DexConfig } from "../config.js";
import { RpcClient } from "./rpc.js";

const BAD_TOKEN_CLOSE_CODE = 1008;

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
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.config.port });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
      this.wss.on("listening", () => {
        const address = this.wss!.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "", "ws://127.0.0.1");
    if (url.searchParams.get("token") !== this.config.token) {
      ws.close(BAD_TOKEN_CLOSE_CODE, "invalid token");
      return;
    }
    // v1 single-bridge: a new connection replaces the old one.
    this.socket?.close();
    this.socket = ws;
    this.rpc = new RpcClient((msg) => ws.send(msg), {
      timeoutMs: this.config.rpcTimeoutMs,
      onEvent: this.onEvent,
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
