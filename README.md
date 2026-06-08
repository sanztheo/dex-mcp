# dex-mcp

Debug and inspection tooling for Roblox projects, exposed as an MCP server so an AI agent can explore the instance tree, read/write properties, call remotes, and run Luau in a Roblox client driven by an executor.

Repository: https://github.com/972jesko/dex-mcp

> Intended use: debugging, inspecting, and learning from **your own** Roblox projects locally. See [GUIDELINES.md](./GUIDELINES.md).

## Install

```bash
npm install
npm run build
```

## Run

```bash
node dist/index.js
```

On startup the server prints (to stderr) the local WebSocket URL and a shared token. The Luau bridge connects to that URL. Configure your MCP client to launch `node /absolute/path/to/dist/index.js` over stdio.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DEX_MCP_PORT` | `8392` | WebSocket hub port |
| `DEX_MCP_TOKEN` | auto-generated, persisted | Shared token required by the bridge. Generated once and saved (see `DEX_MCP_TOKEN_FILE`) so it stays stable across server restarts; set explicitly to pin it. |
| `DEX_MCP_TOKEN_FILE` | `~/.dex-mcp/token` | Where the auto-generated token is persisted. |
| `DEX_MCP_ENABLE_WRITE` | `true` | Enable `set_property` |
| `DEX_MCP_ENABLE_REMOTES` | `true` | Enable remote calling/spying |
| `DEX_MCP_ENABLE_RUN_LUAU` | `true` | Enable `run_luau` |
| `DEX_MCP_RPC_TIMEOUT_MS` | `15000` | Per-request timeout |

> **401 Unauthorized from the bridge?** The bridge baked in a token from an earlier
> server start. With a persisted token this no longer happens on restart; if you still
> see it, the bridge chunk is stale — stop it in your executor and re-run the loader
> one-liner so it fetches the current token.

## The bridge (Roblox side)

The Luau bridge runs inside a script executor and connects back to this server.

1. Start the server: `node dist/index.js`. It prints a loader line.
2. In your executor (in a game you own / are allowed to inspect), run:
   ```lua
   loadstring(game:HttpGet("http://127.0.0.1:<port>/bridge"))()
   ```
   The server injects the per-run auth token into the served script automatically.
3. The bridge connects over WebSocket and answers the MCP tools. It auto-reconnects if the server restarts.

The bridge is assembled on the fly from `bridge/codec.luau`, `bridge/core.luau`, and `bridge/dex-bridge.luau`. The codec and core are unit-tested with [lune](https://lune-ui.dev): `npm run test:bridge`.

### Executor requirements
- `WebSocket.connect` (UNC/sUNC standard). 
- `loadstring` for `run_luau`.
- `hookmetamethod`/`getrawmetatable`/`getnamecallmethod`/`newcclosure` for the remote spy (capability-gated — the bridge degrades gracefully without them).
