import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8392);
    expect(c.enableWrite).toBe(true);
    expect(c.enableRemotes).toBe(true);
    expect(c.enableRunLuau).toBe(true);
    expect(c.rpcTimeoutMs).toBe(15000);
    expect(c.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("honours env overrides", () => {
    const c = loadConfig({ DEX_MCP_PORT: "9000", DEX_MCP_TOKEN: "abc", DEX_MCP_ENABLE_WRITE: "false" });
    expect(c.port).toBe(9000);
    expect(c.token).toBe("abc");
    expect(c.enableWrite).toBe(false);
  });
});
