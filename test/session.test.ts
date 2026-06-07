import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
import { Session } from "../src/mcp/session.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
let bridge: MockBridge | undefined;
afterEach(async () => { await bridge?.close(); await hub?.stop(); hub = bridge = undefined; });

async function setup() {
  hub = new BridgeHub(config);
  const port = await hub.start();
  bridge = new MockBridge(`ws://127.0.0.1:${port}?token=t`);
  await bridge.connect();
  return new Session(hub, config, undefined);
}

describe("Session", () => {
  it("caches className from returned nodes", async () => {
    const session = await setup();
    const root = (await session.callBridge("getRoot", {})) as any;
    session.cacheNodes([root.node, ...root.services]);
    expect(session.classNameFor(0)).toBe("DataModel");
  });

  it("surfaces a friendly error when the bridge is disconnected", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const session = new Session(hub, config, undefined);
    await expect(session.callBridge("status", {})).rejects.toThrow(/not connected/i);
  });
});
