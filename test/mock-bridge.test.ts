import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
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
  return { hub, bridge };
}

describe("MockBridge", () => {
  it("answers status with the fake game name", async () => {
    const { hub } = await setup();
    await expect(hub.request("status", {})).resolves.toMatchObject({ gameName: "MockGame" });
  });

  it("returns the root node with ref 0", async () => {
    const { hub } = await setup();
    const root = (await hub.request("getRoot", {})) as { node: { ref: number; className: string } };
    expect(root.node.ref).toBe(0);
    expect(root.node.className).toBe("DataModel");
  });
});
