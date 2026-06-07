import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
import { Session } from "../src/mcp/session.js";
import { statusTools } from "../src/mcp/tools/status.js";
import { exploreTools } from "../src/mcp/tools/explore.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
let bridge: MockBridge | undefined;
afterEach(async () => { await bridge?.close(); await hub?.stop(); hub = bridge = undefined; });

async function setupSession() {
  hub = new BridgeHub(config);
  const port = await hub.start();
  bridge = new MockBridge(`ws://127.0.0.1:${port}?token=t`);
  await bridge.connect();
  return new Session(hub, config, undefined);
}

function findTool(tools: ReturnType<typeof exploreTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe("explore tools", () => {
  it("dex_status reports the connected game", async () => {
    const session = await setupSession();
    const result = await findTool(statusTools(session), "dex_status").handler({});
    expect(result.structuredContent).toMatchObject({ gameName: "MockGame" });
  });

  it("get_root returns the game node and caches classNames", async () => {
    const session = await setupSession();
    const result = await findTool(exploreTools(session), "get_root").handler({});
    expect((result.structuredContent as any).node.ref).toBe(0);
    expect(session.classNameFor(0)).toBe("DataModel");
  });

  it("get_children lists Workspace children", async () => {
    const session = await setupSession();
    const tools = exploreTools(session);
    const root = (await findTool(tools, "get_root").handler({})).structuredContent as any;
    const workspace = root.services.find((s: any) => s.className === "Workspace");
    const children = (await findTool(tools, "get_children").handler({ ref: workspace.ref })).structuredContent as any;
    expect(children.children[0].className).toBe("Part");
  });

  it("search respects the default limit and returns matches", async () => {
    const session = await setupSession();
    const result = (await findTool(exploreTools(session), "search").handler({ query: "Part" })).structuredContent as any;
    expect(result.results.some((n: any) => n.name === "Part")).toBe(true);
  });
});
