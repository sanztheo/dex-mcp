import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "tok", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("GET /bridge", () => {
  it("serves an assembled Luau payload with the token injected", async () => {
    hub = new BridgeHub(config);
    const port = await hub.start();
    const res = await fetch(`http://127.0.0.1:${port}/bridge`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('local TOKEN = "tok"');
    expect(body).toContain(`local PORT = ${port}`); // the LIVE ephemeral port, not 0
    expect(body).toContain("Core.dispatch");
    expect(body).not.toContain("__DEX_TOKEN__");
  });

  it("404s an unknown path", async () => {
    hub = new BridgeHub(config);
    const port = await hub.start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
