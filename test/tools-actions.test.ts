import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
import { Session } from "../src/mcp/session.js";
import { writeTools } from "../src/mcp/tools/write.js";
import { remoteTools } from "../src/mcp/tools/remotes.js";
import { luauTools } from "../src/mcp/tools/luau.js";
import type { DexConfig } from "../src/config.js";

function baseConfig(overrides: Partial<DexConfig> = {}): DexConfig {
  return { port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000, ...overrides };
}

let hub: BridgeHub | undefined;
let bridge: MockBridge | undefined;
afterEach(async () => { await bridge?.close(); await hub?.stop(); hub = bridge = undefined; });

async function setupSession(config: DexConfig) {
  hub = new BridgeHub(config);
  const port = await hub.start();
  bridge = new MockBridge(`ws://127.0.0.1:${port}?token=t`);
  await bridge.connect();
  return new Session(hub, config, undefined);
}

const tool = (tools: { name: string; handler: (a: any) => Promise<any> }[], name: string) =>
  tools.find((t) => t.name === name)!;

describe("action tools", () => {
  it("set_property succeeds when write is enabled", async () => {
    const session = await setupSession(baseConfig());
    const result = await tool(writeTools(session), "set_property").handler({ ref: 0, name: "Name", value: "Renamed" });
    expect(result.structuredContent).toMatchObject({ ok: true });
  });

  it("set_property is blocked when write is disabled", async () => {
    const session = await setupSession(baseConfig({ enableWrite: false }));
    const result = await tool(writeTools(session), "set_property").handler({ ref: 0, name: "Name", value: "X" });
    expect(result.isError).toBe(true);
  });

  it("fire_remote is blocked when remotes are disabled", async () => {
    const session = await setupSession(baseConfig({ enableRemotes: false }));
    const result = await tool(remoteTools(session), "fire_remote").handler({ ref: 0, args: [] });
    expect(result.isError).toBe(true);
  });

  it("run_luau returns captured output when enabled", async () => {
    const session = await setupSession(baseConfig());
    const result = await tool(luauTools(session), "run_luau").handler({ code: "print('hello')" });
    expect(result.structuredContent).toMatchObject({ output: "hello\n" });
  });

  it("run_luau is blocked when disabled", async () => {
    const session = await setupSession(baseConfig({ enableRunLuau: false }));
    const result = await tool(luauTools(session), "run_luau").handler({ code: "print(1)" });
    expect(result.isError).toBe(true);
  });
});
