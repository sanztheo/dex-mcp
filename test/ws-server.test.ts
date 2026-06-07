import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import type { DexConfig } from "../src/config.js";

const baseConfig: DexConfig = {
  port: 0, token: "secret", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
  });
}

describe("BridgeHub", () => {
  it("accepts a bridge with the correct token and round-trips a request", async () => {
    hub = new BridgeHub(baseConfig);
    const port = await hub.start();
    const ws = await connect(port, "secret");
    ws.on("message", (data) => {
      const req = JSON.parse(data.toString());
      ws.send(JSON.stringify({ id: req.id, ok: true, result: { gameName: "Echo" } }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.isConnected()).toBe(true);
    await expect(hub.request("status", {})).resolves.toEqual({ gameName: "Echo" });
  });

  it("rejects a connection with a bad token", async () => {
    hub = new BridgeHub(baseConfig);
    const port = await hub.start();
    await expect(connect(port, "wrong")).rejects.toThrow(/closed 1008/);
  });

  it("throws when requesting while no bridge is connected", async () => {
    hub = new BridgeHub(baseConfig);
    await hub.start();
    expect(() => hub!.request("status", {})).toThrow(/not connected/i);
  });
});
