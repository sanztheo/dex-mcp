import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  // Redirect token persistence to a throwaway dir so the suite never touches ~/.dex-mcp.
  let tokenDir: string;
  let tokenFile: string;

  beforeEach(() => {
    tokenDir = mkdtempSync(join(tmpdir(), "dex-mcp-test-"));
    tokenFile = join(tokenDir, "token");
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  it("applies defaults when env is empty", () => {
    const c = loadConfig({ DEX_MCP_TOKEN_FILE: tokenFile });
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

  it("reuses the same persisted token across restarts", () => {
    const first = loadConfig({ DEX_MCP_TOKEN_FILE: tokenFile }).token;
    const second = loadConfig({ DEX_MCP_TOKEN_FILE: tokenFile }).token;
    expect(second).toBe(first);
  });

  it("prefers DEX_MCP_TOKEN over a persisted token", () => {
    loadConfig({ DEX_MCP_TOKEN_FILE: tokenFile }); // seed the file
    const c = loadConfig({ DEX_MCP_TOKEN_FILE: tokenFile, DEX_MCP_TOKEN: "explicit" });
    expect(c.token).toBe("explicit");
  });
});
