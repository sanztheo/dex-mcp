import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// User-scoped, hidden dir (à la ~/.ssh, ~/.aws). 0o700/0o600 keep the token
// readable only by the owner — defense-in-depth, even though /bridge already
// serves it in clear over localhost.
const DEFAULT_DIR = ".dex-mcp";
const TOKEN_FILE = "token";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function tokenFilePath(env: NodeJS.ProcessEnv): string {
  return env.DEX_MCP_TOKEN_FILE ?? join(homedir(), DEFAULT_DIR, TOKEN_FILE);
}

function readPersistedToken(file: string): string | undefined {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    // Missing/unreadable file is the normal first-run case — fall through to generate.
    return undefined;
  }
}

function persistToken(file: string, token: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
    writeFileSync(file, token, { encoding: "utf8", mode: FILE_MODE });
  } catch (err) {
    // DECISION: graceful degradation over hard-fail. If the disk is read-only or
    // permission-denied, the server still starts with this (ephemeral) token rather
    // than crashing. Cost: the next restart won't reuse it, so a long-lived bridge
    // would see a 401 again. Flip to `throw` if you'd rather fail loudly than risk
    // a silent stale-token recurrence.
    process.stderr.write(
      `[dex-mcp] could not persist auth token to ${file}: ${(err as Error).message}\n` +
        `[dex-mcp] using an ephemeral token; set DEX_MCP_TOKEN to keep it stable across restarts\n`
    );
  }
}

/**
 * Resolve the WebSocket auth token. Resolution order:
 *   1. DEX_MCP_TOKEN          — explicit override (never persisted)
 *   2. persisted token file   — survives MCP-host restarts (the whole point)
 *   3. fresh random token      — generated once, then persisted for next time
 *
 * WHY persistence exists: the MCP server is respawned by its host across sessions,
 * but the Roblox bridge holding the token lives across those restarts and reconnects
 * forever with its baked-in token. A fresh random token per start => the running
 * bridge sends a stale token => 401. A stable token keeps the bridge connected.
 */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DEX_MCP_TOKEN;
  if (explicit) return explicit;

  const file = tokenFilePath(env);
  const persisted = readPersistedToken(file);
  if (persisted) return persisted;

  const fresh = randomBytes(16).toString("hex");
  persistToken(file, fresh);
  return fresh;
}
