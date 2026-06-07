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
| `DEX_MCP_TOKEN` | auto-generated | Shared token required by the bridge |
| `DEX_MCP_ENABLE_WRITE` | `true` | Enable `set_property` |
| `DEX_MCP_ENABLE_REMOTES` | `true` | Enable remote calling/spying |
| `DEX_MCP_ENABLE_RUN_LUAU` | `true` | Enable `run_luau` |
| `DEX_MCP_RPC_TIMEOUT_MS` | `15000` | Per-request timeout |

## The bridge

The Luau bridge that runs inside the executor is documented in its own plan/spec. It connects to the printed WebSocket URL and answers the RPC protocol in `docs/superpowers/specs/2026-06-07-dex-mcp-design.md` §4.
