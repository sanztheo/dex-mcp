import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { Session } from "../src/mcp/session.js";
import { allTools } from "../src/mcp/server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("allTools", () => {
  it("registers every documented tool exactly once", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const session = new Session(hub, config, undefined);
    const names = allTools(session).map((t) => t.name).sort();
    expect(names).toEqual([
      "dex_status", "fire_remote", "get_by_path", "get_children", "get_properties",
      "get_root", "get_source", "invoke_remote", "remote_spy_dump", "remote_spy_start",
      "remote_spy_stop", "run_luau", "search", "set_property"
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
