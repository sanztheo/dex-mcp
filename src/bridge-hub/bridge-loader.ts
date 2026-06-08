import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/bridge-hub -> repo root is two levels up; bridge/ ships alongside dist (see package.json "files")
const BRIDGE_DIR = join(HERE, "..", "..", "bridge");

function read(name: string): string {
  return readFileSync(join(BRIDGE_DIR, name), "utf8");
}

// Lua long-bracket-safe? We use a plain quoted string for the token; escape backslash, quote,
// and control chars (defense-in-depth: tokens shouldn't contain these, but harden anyway).
function luaQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Assemble the single Luau payload the executor loads: codec+core inlined, WS origin + token
 * injected. `wsBase` is the full WebSocket origin the bridge dials — `ws://127.0.0.1:<port>`
 * locally, `wss://<host>` behind a TLS proxy (Railway). The token is appended as a query param
 * by the glue.
 */
export function assembleBridge(wsBase: string, token: string): string {
  const codec = read("codec.luau");
  const core = read("core.luau");
  const glue = read("dex-bridge.luau");
  return glue
    // Strip the deployment-only comment block that documents the markers (contains their names).
    .replace(/^-- Markers \(replaced by[^\n]*\n(--[^\n]*\n)*/m, "")
    // Replace each standalone marker line with its assembled value.
    .replace(/^__DEX_MAKECODEC__$/m, `local makeCodec = (function()\n${codec}\nend)()`)
    .replace(/^__DEX_MAKECORE__$/m, `local makeCore = (function()\n${core}\nend)()`)
    .replace('"__DEX_WS_BASE__"', luaQuote(wsBase))
    .replace('"__DEX_TOKEN__"', luaQuote(token));
}
