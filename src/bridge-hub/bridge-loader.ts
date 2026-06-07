import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/bridge-hub -> repo root is two levels up; bridge/ ships alongside dist (see package.json "files")
const BRIDGE_DIR = join(HERE, "..", "..", "bridge");

function read(name: string): string {
  return readFileSync(join(BRIDGE_DIR, name), "utf8");
}

// Lua long-bracket-safe? We use a plain quoted string for the token; escape backslash and quote.
function luaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Assemble the single Luau payload the executor loads: codec+core inlined, port/token injected. */
export function assembleBridge(port: number, token: string): string {
  const codec = read("codec.luau");
  const core = read("core.luau");
  const glue = read("dex-bridge.luau");
  return glue
    // Strip the deployment-only comment block that documents the markers (contains their names).
    .replace(/^-- Markers \(replaced by[^\n]*\n(--[^\n]*\n)*/m, "")
    // Replace each standalone marker line with its assembled value.
    .replace(/^__DEX_MAKECODEC__$/m, `local makeCodec = (function()\n${codec}\nend)()`)
    .replace(/^__DEX_MAKECORE__$/m, `local makeCore = (function()\n${core}\nend)()`)
    .replace(/^local PORT = __DEX_PORT__$/m, `local PORT = ${String(port)}`)
    .replace('"__DEX_TOKEN__"', luaQuote(token));
}
