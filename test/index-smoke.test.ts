import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { Session } from "../src/mcp/session.js";
import { buildServer } from "../src/mcp/server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("buildServer", () => {
  it("constructs an McpServer without throwing", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const server = buildServer(new Session(hub, config, undefined));
    expect(server).toBeDefined();
  });
});
