# DEX-MCP Server (TypeScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the TypeScript half of DEX-MCP — an MCP server that exposes Roblox instance inspection/debug tools to an AI agent and talks to a Luau bridge over a local WebSocket. End-to-end testable against a mock bridge, with no Roblox required.

**Architecture:** The server speaks MCP over stdio to the agent and runs a local WebSocket hub for the Luau bridge. Tool calls (req/resp) are correlated to async WS messages via an RPC client. Roblox values cross the wire as tagged JSON (shared codec). Property enumeration is server-driven from a cached Roblox API dump, with a curated fallback.

**Tech Stack:** TypeScript (NodeNext, ESM), Node ≥ 18, `@modelcontextprotocol/sdk`, `ws`, `zod`, `vitest`.

**Companion plan:** The Luau bridge is `docs/superpowers/plans/2026-06-07-dex-mcp-bridge.md` (written after this one). The frozen contract between them is §4 of `docs/superpowers/specs/2026-06-07-dex-mcp-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project config, scripts, ESM/NodeNext build |
| `src/protocol.ts` | Shared types & Zod schemas: `TaggedValue`, `RobloxValue`, `Node`, RPC method names |
| `src/config.ts` | `loadConfig()` — port, token, feature flags, timeout from env |
| `src/bridge-hub/codec.ts` | `summarize()` + value helpers over `TaggedValue` (TS side) |
| `src/bridge-hub/rpc.ts` | `RpcClient` — id→promise correlation, timeout, event routing |
| `src/bridge-hub/ws-server.ts` | `BridgeHub` — WS server, token auth, single-bridge connection |
| `src/api-dump/fetch.ts` | `getApiDump()` — download + disk cache with TTL |
| `src/api-dump/properties.ts` | `propertiesForClass()` — readable scriptable props per class |
| `src/mcp/session.ts` | `Session` — holds hub, dump, className cache; `callBridge()` helper |
| `src/mcp/tools/*.ts` | Tool definitions per group (status, explore, write, remotes, luau) |
| `src/mcp/server.ts` | `buildServer()` — register all tools on an `McpServer` |
| `src/index.ts` | Entry: load config, start hub, build server, connect stdio |
| `test/mock-bridge.ts` | Test double: WS client simulating the Luau bridge over a fake tree |
| `test/*.test.ts` | Unit + end-to-end tests |

---

## Task 0: Scaffold project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `README.md`, `GUIDELINES.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dex-mcp",
  "version": "0.1.0",
  "description": "Debug and inspection tooling for Roblox projects, exposed as an MCP server.",
  "type": "module",
  "bin": { "dex-mcp": "dist/index.js" },
  "files": ["dist", "bridge", "README.md", "GUIDELINES.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js"
  },
  "license": "MIT",
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.12",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

> **SDK version note:** `@modelcontextprotocol/sdk` tool registration has a version variance. This plan uses `registerTool(name, { description, inputSchema }, handler)` where `inputSchema` is a **Zod raw shape** (a plain object of Zod validators, e.g. `{ ref: z.number() }`). If `npm install` pulls an SDK that rejects a raw shape, wrap each `inputSchema` with `z.object(...)`. Verify against `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` after install.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
```

- [ ] **Step 4: Create `LICENSE` (MIT), `README.md`, `GUIDELINES.md` skeletons**

`LICENSE`: standard MIT text, copyright holder "972jesko", year 2026.

`README.md`:
```markdown
# dex-mcp

Debug and inspection tooling for Roblox projects, exposed as an MCP server so an AI agent can explore the instance tree, read/write properties, call remotes, and run Luau in a Roblox client driven by an executor.

Repository: https://github.com/972jesko/dex-mcp

> Intended use: debugging, inspecting, and learning from **your own** Roblox projects locally. See GUIDELINES.md.

## Status

Work in progress. See `docs/superpowers/specs/2026-06-07-dex-mcp-design.md`.
```

`GUIDELINES.md`:
```markdown
# Guidelines

dex-mcp is debug and inspection tooling for Roblox projects.

- Use it on projects you own or have permission to inspect.
- The project does not include — and will not accept PRs adding — anti-cheat evasion or anti-detection features.
```

- [ ] **Step 5: Install and verify the toolchain**

Run: `npm install`
Then: `npm run build`
Expected: build succeeds with no source files yet (empty `dist/`), exit code 0.
Then: `npx vitest run --passWithNoTests`
Expected: "No test files found" but exit code 0.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts LICENSE README.md GUIDELINES.md package-lock.json
git commit -m "chore: scaffold dex-mcp TypeScript project"
```

---

## Task 1: Shared protocol types & schemas

**Files:**
- Create: `src/protocol.ts`
- Test: `test/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { TaggedValueSchema, RobloxValueSchema, NodeSchema } from "../src/protocol.js";

describe("protocol schemas", () => {
  it("accepts a valid Vector3 tagged value", () => {
    const v = { __t: "Vector3", x: 1, y: 2, z: 3 };
    expect(TaggedValueSchema.parse(v)).toEqual(v);
  });

  it("accepts a CFrame with exactly 12 components", () => {
    const v = { __t: "CFrame", components: [0,0,0, 1,0,0, 0,1,0, 0,0,1] };
    expect(TaggedValueSchema.parse(v)).toEqual(v);
  });

  it("rejects a CFrame with the wrong number of components", () => {
    expect(() => TaggedValueSchema.parse({ __t: "CFrame", components: [1, 2, 3] })).toThrow();
  });

  it("RobloxValue accepts primitives and tagged values", () => {
    expect(RobloxValueSchema.parse(42)).toBe(42);
    expect(RobloxValueSchema.parse("hi")).toBe("hi");
    expect(RobloxValueSchema.parse({ __t: "Color3", r: 1, g: 0, b: 0 })).toBeTruthy();
  });

  it("Node requires ref, name, className, path, childCount", () => {
    const n = { ref: 0, name: "game", className: "DataModel", path: "game", childCount: 5 };
    expect(NodeSchema.parse(n)).toEqual(n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/protocol.test.ts`
Expected: FAIL — cannot find module `../src/protocol.js`.

- [ ] **Step 3: Write `src/protocol.ts`**

```ts
import { z } from "zod";

const Vector3 = z.object({ __t: z.literal("Vector3"), x: z.number(), y: z.number(), z: z.number() });
const Vector2 = z.object({ __t: z.literal("Vector2"), x: z.number(), y: z.number() });
const CFrame = z.object({ __t: z.literal("CFrame"), components: z.array(z.number()).length(12) });
const Color3 = z.object({ __t: z.literal("Color3"), r: z.number(), g: z.number(), b: z.number() });
const BrickColor = z.object({ __t: z.literal("BrickColor"), name: z.string() });
const UDim = z.object({ __t: z.literal("UDim"), scale: z.number(), offset: z.number() });
const UDim2 = z.object({
  __t: z.literal("UDim2"),
  x: z.object({ scale: z.number(), offset: z.number() }),
  y: z.object({ scale: z.number(), offset: z.number() })
});
const EnumItem = z.object({ __t: z.literal("EnumItem"), enum: z.string(), name: z.string(), value: z.number().optional() });
const InstanceRef = z.object({ __t: z.literal("Instance"), ref: z.number(), path: z.string(), class: z.string() });
const NumberSequence = z.object({ __t: z.literal("NumberSequence"), keypoints: z.array(z.any()) });
const ColorSequence = z.object({ __t: z.literal("ColorSequence"), keypoints: z.array(z.any()) });
const Unsupported = z.object({ __t: z.literal("Unsupported"), repr: z.string() });

export const TaggedValueSchema = z.discriminatedUnion("__t", [
  Vector3, Vector2, CFrame, Color3, BrickColor, UDim, UDim2,
  EnumItem, InstanceRef, NumberSequence, ColorSequence, Unsupported
]);
export type TaggedValue = z.infer<typeof TaggedValueSchema>;

export const RobloxValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null(), TaggedValueSchema]);
export type RobloxValue = z.infer<typeof RobloxValueSchema>;

export const NodeSchema = z.object({
  ref: z.number(),
  name: z.string(),
  className: z.string(),
  path: z.string(),
  childCount: z.number()
});
export type Node = z.infer<typeof NodeSchema>;

export interface RpcRequest { id: number; method: string; params: Record<string, unknown>; }
export interface RpcResponse { id: number; ok: boolean; result?: unknown; error?: string; }
export interface RpcEvent { event: string; data: unknown; }

export const RPC_METHODS = {
  status: "status",
  getRoot: "getRoot",
  getChildren: "getChildren",
  getProperties: "getProperties",
  setProperty: "setProperty",
  search: "search",
  getSource: "getSource",
  getByPath: "getByPath",
  fireRemote: "fireRemote",
  invokeRemote: "invokeRemote",
  remoteSpyStart: "remoteSpyStart",
  remoteSpyStop: "remoteSpyStop",
  remoteSpyDump: "remoteSpyDump",
  runLuau: "runLuau"
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/protocol.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts test/protocol.test.ts
git commit -m "feat: add shared protocol types and tagged-value schemas"
```

---

## Task 2: Configuration

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { randomBytes } from "node:crypto";

export interface DexConfig {
  port: number;
  token: string;
  enableWrite: boolean;
  enableRemotes: boolean;
  enableRunLuau: boolean;
  rpcTimeoutMs: number;
}

const DEFAULT_PORT = 8392;
const DEFAULT_TIMEOUT_MS = 15000;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== "false";
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DexConfig {
  return {
    port: parseInteger(env.DEX_MCP_PORT, DEFAULT_PORT),
    token: env.DEX_MCP_TOKEN ?? randomBytes(16).toString("hex"),
    enableWrite: parseBool(env.DEX_MCP_ENABLE_WRITE, true),
    enableRemotes: parseBool(env.DEX_MCP_ENABLE_REMOTES, true),
    enableRunLuau: parseBool(env.DEX_MCP_ENABLE_RUN_LUAU, true),
    rpcTimeoutMs: parseInteger(env.DEX_MCP_RPC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add configuration loader with feature flags"
```

---

## Task 3: Codec helper (`summarize`)

**Files:**
- Create: `src/bridge-hub/codec.ts`
- Test: `test/codec.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { summarize } from "../src/bridge-hub/codec.js";

describe("summarize", () => {
  it("renders primitives", () => {
    expect(summarize(42)).toBe("42");
    expect(summarize("hi")).toBe('"hi"');
    expect(summarize(true)).toBe("true");
    expect(summarize(null)).toBe("nil");
  });

  it("renders tagged values compactly", () => {
    expect(summarize({ __t: "Vector3", x: 1, y: 2, z: 3 })).toBe("Vector3(1, 2, 3)");
    expect(summarize({ __t: "EnumItem", enum: "Material", name: "Plastic" })).toBe("Enum.Material.Plastic");
    expect(summarize({ __t: "Instance", ref: 7, path: "game.Workspace.Part", class: "Part" })).toBe("Part (ref 7)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/codec.test.ts`
Expected: FAIL — cannot find module `../src/bridge-hub/codec.js`.

- [ ] **Step 3: Write `src/bridge-hub/codec.ts`**

```ts
import type { RobloxValue, TaggedValue } from "../protocol.js";

function summarizeTagged(v: TaggedValue): string {
  switch (v.__t) {
    case "Vector3": return `Vector3(${v.x}, ${v.y}, ${v.z})`;
    case "Vector2": return `Vector2(${v.x}, ${v.y})`;
    case "CFrame": return `CFrame(${v.components.slice(0, 3).join(", ")}, ...)`;
    case "Color3": return `Color3(${v.r}, ${v.g}, ${v.b})`;
    case "BrickColor": return `BrickColor(${v.name})`;
    case "UDim": return `UDim(${v.scale}, ${v.offset})`;
    case "UDim2": return `UDim2(${v.x.scale}, ${v.x.offset}, ${v.y.scale}, ${v.y.offset})`;
    case "EnumItem": return `Enum.${v.enum}.${v.name}`;
    case "Instance": return `${v.class} (ref ${v.ref})`;
    case "NumberSequence": return `NumberSequence(${v.keypoints.length} keypoints)`;
    case "ColorSequence": return `ColorSequence(${v.keypoints.length} keypoints)`;
    case "Unsupported": return v.repr;
  }
}

export function summarize(value: RobloxValue): string {
  if (value === null) return "nil";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return summarizeTagged(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/codec.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bridge-hub/codec.ts test/codec.test.ts
git commit -m "feat: add tagged-value summarize helper"
```

---

## Task 4: RPC correlation client

**Files:**
- Create: `src/bridge-hub/rpc.ts`
- Test: `test/rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { RpcClient } from "../src/bridge-hub/rpc.js";

function makeClient(timeoutMs = 15000) {
  const sent: string[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const client = new RpcClient((msg) => sent.push(msg), {
    timeoutMs,
    onEvent: (event, data) => events.push({ event, data })
  });
  return { client, sent, events };
}

describe("RpcClient", () => {
  it("resolves a request when a matching response arrives", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("status", {});
    const { id } = JSON.parse(sent[0]);
    client.handleMessage(JSON.stringify({ id, ok: true, result: { gameName: "Test" } }));
    await expect(promise).resolves.toEqual({ gameName: "Test" });
  });

  it("rejects on an error response", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("getRoot", {});
    const { id } = JSON.parse(sent[0]);
    client.handleMessage(JSON.stringify({ id, ok: false, error: "boom" }));
    await expect(promise).rejects.toThrow("boom");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const { client } = makeClient(1000);
    const promise = client.request("status", {});
    const assertion = expect(promise).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it("routes unsolicited events and ignores unknown ids", () => {
    const { client, events } = makeClient();
    expect(() => client.handleMessage(JSON.stringify({ id: 999, ok: true, result: 1 }))).not.toThrow();
    client.handleMessage(JSON.stringify({ event: "remoteSpy", data: { name: "Buy" } }));
    expect(events).toEqual([{ event: "remoteSpy", data: { name: "Buy" } }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rpc.test.ts`
Expected: FAIL — cannot find module `../src/bridge-hub/rpc.js`.

- [ ] **Step 3: Write `src/bridge-hub/rpc.ts`**

```ts
import type { RpcEvent, RpcResponse } from "../protocol.js";

export type Sender = (message: string) => void;

export interface RpcOptions {
  timeoutMs: number;
  onEvent?: (event: string, data: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly send: Sender, private readonly opts: RpcOptions) {}

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for "${method}"`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as RpcResponse | RpcEvent;
    if ("event" in parsed) {
      this.opts.onEvent?.(parsed.event, parsed.data);
      return;
    }
    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(parsed.id);
    if (parsed.ok) entry.resolve(parsed.result);
    else entry.reject(new Error(parsed.error ?? "unknown bridge error"));
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rpc.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bridge-hub/rpc.ts test/rpc.test.ts
git commit -m "feat: add RPC correlation client with timeout and events"
```

---

## Task 5: WebSocket hub with token auth

**Files:**
- Create: `src/bridge-hub/ws-server.ts`
- Test: `test/ws-server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import type { DexConfig } from "../src/config.js";

const baseConfig: DexConfig = {
  port: 0, token: "secret", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

function connect(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    ws.on("close", (code) => reject(new Error(`closed ${code}`)));
  });
}

describe("BridgeHub", () => {
  it("accepts a bridge with the correct token and round-trips a request", async () => {
    hub = new BridgeHub(baseConfig);
    const port = await hub.start();
    const ws = await connect(port, "secret");
    ws.on("message", (data) => {
      const req = JSON.parse(data.toString());
      ws.send(JSON.stringify({ id: req.id, ok: true, result: { gameName: "Echo" } }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.isConnected()).toBe(true);
    await expect(hub.request("status", {})).resolves.toEqual({ gameName: "Echo" });
  });

  it("rejects a connection with a bad token", async () => {
    hub = new BridgeHub(baseConfig);
    const port = await hub.start();
    // Bad token is rejected at the HTTP handshake (verifyClient → 401), so the
    // client never opens; it errors. (Accept-then-close races `open` before `close`.)
    await expect(connect(port, "wrong")).rejects.toThrow(/401|unexpected server response/i);
  });

  it("throws when requesting while no bridge is connected", async () => {
    hub = new BridgeHub(baseConfig);
    await hub.start();
    expect(() => hub!.request("status", {})).toThrow(/not connected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ws-server.test.ts`
Expected: FAIL — cannot find module `../src/bridge-hub/ws-server.js`.

- [ ] **Step 3: Write `src/bridge-hub/ws-server.ts`**

```ts
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { AddressInfo } from "node:net";
import type { DexConfig } from "../config.js";
import { RpcClient } from "./rpc.js";

export class BridgeHub {
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private rpc?: RpcClient;

  constructor(
    private readonly config: DexConfig,
    private readonly onEvent?: (event: string, data: unknown) => void
  ) {}

  start(): Promise<number> {
    return new Promise((resolve) => {
      // Reject bad tokens at the HTTP handshake (401) — before the WS upgrade — so a
      // rejected client never fires `open`. (Accept-then-close races `open` before `close`.)
      this.wss = new WebSocketServer({
        host: "127.0.0.1",
        port: this.config.port,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? "", "ws://127.0.0.1");
          if (url.searchParams.get("token") === this.config.token) cb(true);
          else cb(false, 401, "invalid token");
        }
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.wss.on("listening", () => {
        const address = this.wss!.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  private handleConnection(ws: WebSocket): void {
    // Token already verified at handshake. v1 single-bridge: a new connection replaces the old one.
    this.socket?.close();
    this.socket = ws;
    this.rpc = new RpcClient((msg) => ws.send(msg), {
      timeoutMs: this.config.rpcTimeoutMs,
      onEvent: this.onEvent
    });
    ws.on("message", (data: RawData) => this.rpc?.handleMessage(data.toString()));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.rpc?.rejectAll("bridge disconnected");
        this.socket = undefined;
        this.rpc = undefined;
      }
    });
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.rpc || !this.isConnected()) throw new Error("bridge not connected");
    return this.rpc.request(method, params);
  }

  async stop(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ws-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bridge-hub/ws-server.ts test/ws-server.test.ts
git commit -m "feat: add WebSocket hub with token auth and single-bridge connection"
```

---

## Task 6: Mock bridge (test double)

**Files:**
- Create: `test/mock-bridge.ts`
- Test: `test/mock-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
let bridge: MockBridge | undefined;
afterEach(async () => { await bridge?.close(); await hub?.stop(); hub = bridge = undefined; });

async function setup() {
  hub = new BridgeHub(config);
  const port = await hub.start();
  bridge = new MockBridge(`ws://127.0.0.1:${port}?token=t`);
  await bridge.connect();
  return { hub, bridge };
}

describe("MockBridge", () => {
  it("answers status with the fake game name", async () => {
    const { hub } = await setup();
    await expect(hub.request("status", {})).resolves.toMatchObject({ gameName: "MockGame" });
  });

  it("returns the root node with ref 0", async () => {
    const { hub } = await setup();
    const root = (await hub.request("getRoot", {})) as { node: { ref: number; className: string } };
    expect(root.node.ref).toBe(0);
    expect(root.node.className).toBe("DataModel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mock-bridge.test.ts`
Expected: FAIL — cannot find module `./mock-bridge.js`.

- [ ] **Step 3: Write `test/mock-bridge.ts`**

```ts
import WebSocket from "ws";
import type { RobloxValue } from "../src/protocol.js";

interface FakeInstance {
  name: string;
  className: string;
  properties: Record<string, RobloxValue>;
  source?: string;
  children: FakeInstance[];
}

// Minimal fake DataModel used by all tool tests.
function fakeTree(): FakeInstance {
  const part: FakeInstance = {
    name: "Part", className: "Part",
    properties: { Name: "Part", Anchored: false, Position: { __t: "Vector3", x: 0, y: 5, z: 0 } },
    children: []
  };
  const buyRemote: FakeInstance = {
    name: "Buy", className: "RemoteEvent", properties: { Name: "Buy" }, children: []
  };
  const moduleScript: FakeInstance = {
    name: "Logic", className: "ModuleScript",
    properties: { Name: "Logic" }, source: "return {}", children: []
  };
  const workspace: FakeInstance = {
    name: "Workspace", className: "Workspace", properties: { Name: "Workspace" }, children: [part]
  };
  const replicatedStorage: FakeInstance = {
    name: "ReplicatedStorage", className: "ReplicatedStorage",
    properties: { Name: "ReplicatedStorage" }, children: [buyRemote, moduleScript]
  };
  return {
    name: "game", className: "DataModel", properties: { Name: "Game" },
    children: [workspace, replicatedStorage]
  };
}

export class MockBridge {
  private ws?: WebSocket;
  private readonly root = fakeTree();
  private readonly refs = new Map<number, FakeInstance>();
  private readonly byInstance = new Map<FakeInstance, number>();
  private nextRef = 0;

  constructor(private readonly url: string) {
    this.assignRef(this.root); // game = ref 0
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (data) => this.dispatch(data.toString()));
    });
  }

  async close(): Promise<void> { this.ws?.close(); }

  private assignRef(inst: FakeInstance): number {
    const existing = this.byInstance.get(inst);
    if (existing !== undefined) return existing;
    const ref = this.nextRef++;
    this.refs.set(ref, inst);
    this.byInstance.set(inst, ref);
    return ref;
  }

  private pathOf(inst: FakeInstance): string {
    const find = (cur: FakeInstance, target: FakeInstance, trail: string[]): string[] | undefined => {
      const next = [...trail, cur.name];
      if (cur === target) return next;
      for (const child of cur.children) {
        const found = find(child, target, next);
        if (found) return found;
      }
      return undefined;
    };
    return (find(this.root, inst, []) ?? [inst.name]).join(".");
  }

  private node(inst: FakeInstance) {
    return {
      ref: this.assignRef(inst), name: inst.name, className: inst.className,
      path: this.pathOf(inst), childCount: inst.children.length
    };
  }

  private dispatch(raw: string): void {
    const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: any };
    try {
      this.reply(id, this.handle(method, params ?? {}));
    } catch (err) {
      this.ws?.send(JSON.stringify({ id, ok: false, error: (err as Error).message }));
    }
  }

  private reply(id: number, result: unknown): void {
    this.ws?.send(JSON.stringify({ id, ok: true, result }));
  }

  private require(ref: number): FakeInstance {
    const inst = this.refs.get(ref);
    if (!inst) throw new Error(`stale ref ${ref}`);
    return inst;
  }

  private handle(method: string, params: any): unknown {
    switch (method) {
      case "status":
        return { gameName: "MockGame", placeId: 123, clientVersion: "mock", capabilities: { hookmetamethod: true } };
      case "getRoot":
        return { node: this.node(this.root), services: this.root.children.map((c) => this.node(c)) };
      case "getChildren": {
        const inst = this.require(params.ref);
        const children = inst.children.filter((c) => !params.classFilter || c.className === params.classFilter);
        return children.map((c) => this.node(c));
      }
      case "getProperties": {
        const inst = this.require(params.ref);
        const names: string[] | undefined = params.propertyNames;
        const properties: Record<string, RobloxValue> = {};
        const keys = names ?? Object.keys(inst.properties);
        for (const key of keys) if (key in inst.properties) properties[key] = inst.properties[key];
        return { className: inst.className, properties };
      }
      case "setProperty": {
        const inst = this.require(params.ref);
        inst.properties[params.name] = params.value;
        return { ok: true };
      }
      case "search": {
        const limit = params.limit ?? 100;
        const results: ReturnType<MockBridge["node"]>[] = [];
        const walk = (inst: FakeInstance) => {
          if (results.length >= limit) return;
          const matchesName = inst.name.toLowerCase().includes(String(params.query).toLowerCase());
          const matchesClass = !params.classFilter || inst.className === params.classFilter;
          if (matchesName && matchesClass) results.push(this.node(inst));
          inst.children.forEach(walk);
        };
        this.root.children.forEach(walk);
        return results;
      }
      case "getSource": {
        const inst = this.require(params.ref);
        if (inst.source === undefined) throw new Error("instance has no readable source");
        return { source: inst.source };
      }
      case "getByPath": {
        const target = params.path.split(".").slice(1); // drop "game"
        let cur = this.root;
        for (const segment of target) {
          const next = cur.children.find((c) => c.name === segment);
          if (!next) throw new Error(`path not found: ${params.path}`);
          cur = next;
        }
        return this.node(cur);
      }
      case "fireRemote": return { ok: true };
      case "invokeRemote": return { result: { __t: "Instance", ref: 0, path: "game", class: "DataModel" } };
      case "remoteSpyStart": return { ok: true };
      case "remoteSpyStop": return { ok: true };
      case "remoteSpyDump": return { entries: [{ remote: "Buy", args: [1] }] };
      case "runLuau": return { output: "hello\n", returned: 42 };
      default: throw new Error(`unknown method ${method}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mock-bridge.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/mock-bridge.ts test/mock-bridge.test.ts
git commit -m "test: add mock bridge double over a fake DataModel"
```

---

## Task 7: API dump fetch + property derivation

**Files:**
- Create: `src/api-dump/fetch.ts`, `src/api-dump/properties.ts`
- Test: `test/properties.test.ts`, `test/fetch.test.ts`

- [ ] **Step 1: Write the failing test for property derivation**

```ts
import { describe, it, expect } from "vitest";
import { propertiesForClass, type ApiDump } from "../src/api-dump/properties.js";

const dump: ApiDump = {
  Classes: [
    {
      Name: "Instance", Superclass: "<<<ROOT>>>",
      Members: [{ MemberType: "Property", Name: "Name", ValueType: { Name: "string" }, Tags: [] }]
    },
    {
      Name: "BasePart", Superclass: "Instance",
      Members: [
        { MemberType: "Property", Name: "Anchored", ValueType: { Name: "bool" }, Tags: [] },
        { MemberType: "Property", Name: "BrickColor", ValueType: { Name: "BrickColor" }, Tags: ["Deprecated"] },
        { MemberType: "Function", Name: "GetMass", ValueType: { Name: "float" }, Tags: [] }
      ]
    },
    { Name: "Part", Superclass: "BasePart", Members: [] }
  ]
};

describe("propertiesForClass", () => {
  it("collects scriptable properties up the superclass chain", () => {
    const props = propertiesForClass(dump, "Part").map((p) => p.name).sort();
    expect(props).toEqual(["Anchored", "Name"]);
  });

  it("skips deprecated properties and non-property members", () => {
    const props = propertiesForClass(dump, "BasePart").map((p) => p.name);
    expect(props).not.toContain("BrickColor");
    expect(props).not.toContain("GetMass");
  });

  it("returns an empty list for unknown classes", () => {
    expect(propertiesForClass(dump, "Nonexistent")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/properties.test.ts`
Expected: FAIL — cannot find module `../src/api-dump/properties.js`.

- [ ] **Step 3: Write `src/api-dump/properties.ts`**

```ts
export interface ApiMember {
  MemberType: string;
  Name: string;
  ValueType?: { Name: string };
  Tags?: string[];
}
export interface ApiClass { Name: string; Superclass: string; Members: ApiMember[]; }
export interface ApiDump { Classes: ApiClass[]; }

export interface PropInfo { name: string; valueType: string; }

const SKIP_TAGS = new Set(["Deprecated", "ReadOnly", "NotScriptable", "Hidden"]);

export function propertiesForClass(dump: ApiDump, className: string): PropInfo[] {
  const byName = new Map(dump.Classes.map((c) => [c.Name, c]));
  const props = new Map<string, PropInfo>();
  let current = byName.get(className);
  while (current) {
    for (const member of current.Members) {
      if (member.MemberType !== "Property") continue;
      if ((member.Tags ?? []).some((tag) => SKIP_TAGS.has(tag))) continue;
      if (!props.has(member.Name)) {
        props.set(member.Name, { name: member.Name, valueType: member.ValueType?.Name ?? "unknown" });
      }
    }
    current = current.Superclass === "<<<ROOT>>>" ? undefined : byName.get(current.Superclass);
  }
  return [...props.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/properties.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the dump fetcher**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getApiDump } from "../src/api-dump/fetch.js";

const cacheDir = join(tmpdir(), "dex-mcp-test-cache");

beforeEach(async () => { await rm(cacheDir, { recursive: true, force: true }); await mkdir(cacheDir, { recursive: true }); });

describe("getApiDump", () => {
  it("fetches and caches the dump when no cache exists", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return { ok: true, json: async () => ({ Classes: [] }) }; }) as unknown as typeof fetch;
    const dump = await getApiDump({ fetchImpl, cacheDir, now: () => 1000, ttlMs: 10000 });
    expect(dump).toEqual({ Classes: [] });
    expect(calls).toBe(1);
    const cached = JSON.parse(await readFile(join(cacheDir, "api-dump.json"), "utf8"));
    expect(cached.dump).toEqual({ Classes: [] });
  });

  it("returns undefined and does not throw when the fetch fails", async () => {
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const dump = await getApiDump({ fetchImpl, cacheDir, now: () => 1000, ttlMs: 10000 });
    expect(dump).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/fetch.test.ts`
Expected: FAIL — cannot find module `../src/api-dump/fetch.js`.

- [ ] **Step 7: Write `src/api-dump/fetch.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiDump } from "./properties.js";

const DUMP_URL = "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  now?: () => number;
  ttlMs?: number;
}

interface CacheFile { fetchedAt: number; dump: ApiDump; }

function defaultCacheDir(): string {
  return join(homedir(), ".cache", "dex-mcp");
}

async function readCache(path: string, now: number, ttlMs: number): Promise<ApiDump | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CacheFile;
    if (now - parsed.fetchedAt < ttlMs) return parsed.dump;
  } catch {
    // missing or corrupt cache — fall through to network
  }
  return undefined;
}

export async function getApiDump(deps: FetchDeps = {}): Promise<ApiDump | undefined> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  const now = (deps.now ?? Date.now)();
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = join(cacheDir, "api-dump.json");

  const cached = await readCache(cachePath, now, ttlMs);
  if (cached) return cached;

  try {
    const response = await fetchImpl(DUMP_URL);
    if (!response.ok) return undefined;
    const dump = (await response.json()) as ApiDump;
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify({ fetchedAt: now, dump } satisfies CacheFile), "utf8");
    return dump;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/fetch.test.ts test/properties.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 9: Commit**

```bash
git add src/api-dump test/properties.test.ts test/fetch.test.ts
git commit -m "feat: add API dump fetcher and property derivation"
```

---

## Task 8: Session + callBridge helper

**Files:**
- Create: `src/mcp/session.ts`
- Test: `test/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { MockBridge } from "./mock-bridge.js";
import { Session } from "../src/mcp/session.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
let bridge: MockBridge | undefined;
afterEach(async () => { await bridge?.close(); await hub?.stop(); hub = bridge = undefined; });

async function setup() {
  hub = new BridgeHub(config);
  const port = await hub.start();
  bridge = new MockBridge(`ws://127.0.0.1:${port}?token=t`);
  await bridge.connect();
  return new Session(hub, config, undefined);
}

describe("Session", () => {
  it("caches className from returned nodes", async () => {
    const session = await setup();
    const root = (await session.callBridge("getRoot", {})) as any;
    session.cacheNodes([root.node, ...root.services]);
    expect(session.classNameFor(0)).toBe("DataModel");
  });

  it("surfaces a friendly error when the bridge is disconnected", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const session = new Session(hub, config, undefined);
    await expect(session.callBridge("status", {})).rejects.toThrow(/not connected/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — cannot find module `../src/mcp/session.js`.

- [ ] **Step 3: Write `src/mcp/session.ts`**

```ts
import type { BridgeHub } from "../bridge-hub/ws-server.js";
import type { DexConfig } from "../config.js";
import type { ApiDump } from "../api-dump/properties.js";
import type { Node } from "../protocol.js";

export class Session {
  private readonly classNames = new Map<number, string>();

  constructor(
    private readonly hub: BridgeHub,
    readonly config: DexConfig,
    readonly dump: ApiDump | undefined
  ) {}

  // async so a synchronous "bridge not connected" throw from hub.request surfaces as a rejected promise
  async callBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.hub.request(method, params);
  }

  cacheNodes(nodes: Node[]): void {
    for (const node of nodes) this.classNames.set(node.ref, node.className);
  }

  classNameFor(ref: number): string | undefined {
    return this.classNames.get(ref);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/session.ts test/session.test.ts
git commit -m "feat: add Session with className cache and bridge helper"
```

---

## Task 9: Tool definitions — status & explore

**Files:**
- Create: `src/mcp/tools/types.ts`, `src/mcp/tools/status.ts`, `src/mcp/tools/explore.ts`
- Test: `test/tools-explore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools-explore.test.ts`
Expected: FAIL — cannot find module `../src/mcp/tools/status.js`.

- [ ] **Step 3: Write `src/mcp/tools/types.ts`**

```ts
import type { z } from "zod";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // The SDK's CallToolResult is a "loose" Zod schema with an index signature;
  // match it so our handlers are assignable to registerTool's callback type.
  [x: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<ToolResult>;
}

export function ok(structured: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured as Record<string, unknown> };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wraps a handler so bridge/transport errors become tool errors instead of throwing.
export function guard(fn: (args: any) => Promise<ToolResult>): (args: any) => Promise<ToolResult> {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}
```

- [ ] **Step 4: Write `src/mcp/tools/status.ts`**

```ts
import type { Session } from "../session.js";
import { guard, ok, type ToolDef } from "./types.js";

export function statusTools(session: Session): ToolDef[] {
  return [
    {
      name: "dex_status",
      description: "Report whether the Roblox bridge is connected and basic game info (name, placeId, client version, capabilities).",
      inputSchema: {},
      handler: guard(async () => ok(await session.callBridge("status", {})))
    }
  ];
}
```

- [ ] **Step 5: Write `src/mcp/tools/explore.ts`**

```ts
import { z } from "zod";
import type { Session } from "../session.js";
import type { Node } from "../../protocol.js";
import { propertiesForClass } from "../../api-dump/properties.js";
import { guard, ok, type ToolDef } from "./types.js";

const DEFAULT_SEARCH_LIMIT = 100;

export function exploreTools(session: Session): ToolDef[] {
  return [
    {
      name: "get_root",
      description: "Get the root instance (game, ref 0) and its top-level services.",
      inputSchema: {},
      handler: guard(async () => {
        const result = (await session.callBridge("getRoot", {})) as { node: Node; services: Node[] };
        session.cacheNodes([result.node, ...result.services]);
        return ok(result);
      })
    },
    {
      name: "get_children",
      description: "List the direct children of an instance by ref. Optionally filter by className.",
      inputSchema: { ref: z.number().int(), classFilter: z.string().optional() },
      handler: guard(async ({ ref, classFilter }) => {
        const children = (await session.callBridge("getChildren", { ref, classFilter })) as Node[];
        session.cacheNodes(children);
        return ok({ children });
      })
    },
    {
      name: "get_properties",
      description: "Read the properties of an instance by ref. Property names come from the cached Roblox API dump when available.",
      inputSchema: { ref: z.number().int() },
      handler: guard(async ({ ref }) => {
        let className = session.classNameFor(ref);
        if (className === undefined || !session.dump) {
          const discovered = (await session.callBridge("getProperties", { ref })) as { className: string; properties: Record<string, unknown> };
          if (!session.dump) return ok(discovered);
          className = discovered.className;
        }
        const propertyNames = propertiesForClass(session.dump, className).map((p) => p.name);
        const result = await session.callBridge("getProperties", { ref, propertyNames });
        return ok(result);
      })
    },
    {
      name: "search",
      description: "Recursively search instances by name substring (and optional className), capped by limit. Defaults to 100 results.",
      inputSchema: {
        query: z.string(),
        root: z.number().int().optional(),
        classFilter: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        maxDepth: z.number().int().positive().optional()
      },
      handler: guard(async ({ query, root, classFilter, limit, maxDepth }) => {
        const results = (await session.callBridge("search", {
          rootRef: root ?? 0, query, classFilter, limit: limit ?? DEFAULT_SEARCH_LIMIT, maxDepth
        })) as Node[];
        session.cacheNodes(results);
        return ok({ results, limit: limit ?? DEFAULT_SEARCH_LIMIT, truncated: results.length >= (limit ?? DEFAULT_SEARCH_LIMIT) });
      })
    },
    {
      name: "get_source",
      description: "Read the Source of a Script/LocalScript/ModuleScript by ref, if readable.",
      inputSchema: { ref: z.number().int() },
      handler: guard(async ({ ref }) => ok(await session.callBridge("getSource", { ref })))
    },
    {
      name: "get_by_path",
      description: "Resolve a dotted instance path (e.g. game.Workspace.Part) to a node with a ref.",
      inputSchema: { path: z.string() },
      handler: guard(async ({ path }) => {
        const node = (await session.callBridge("getByPath", { path })) as Node;
        session.cacheNodes([node]);
        return ok(node);
      })
    }
  ];
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/tools-explore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/types.ts src/mcp/tools/status.ts src/mcp/tools/explore.ts test/tools-explore.test.ts
git commit -m "feat: add status and explore MCP tools"
```

---

## Task 10: Tool definitions — write, remotes, luau

**Files:**
- Create: `src/mcp/tools/write.ts`, `src/mcp/tools/remotes.ts`, `src/mcp/tools/luau.ts`
- Test: `test/tools-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools-actions.test.ts`
Expected: FAIL — cannot find module `../src/mcp/tools/write.js`.

- [ ] **Step 3: Write `src/mcp/tools/write.ts`**

```ts
import { z } from "zod";
import type { Session } from "../session.js";
import { RobloxValueSchema } from "../../protocol.js";
import { propertiesForClass } from "../../api-dump/properties.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function writeTools(session: Session): ToolDef[] {
  return [
    {
      name: "set_property",
      description: "Set a property on an instance by ref. The value is coerced to the property's declared Roblox type when known.",
      inputSchema: { ref: z.number().int(), name: z.string(), value: RobloxValueSchema },
      handler: guard(async ({ ref, name, value }) => {
        if (!session.config.enableWrite) return fail("set_property is disabled (DEX_MCP_ENABLE_WRITE=false)");
        const className = session.classNameFor(ref);
        const valueType = session.dump && className
          ? propertiesForClass(session.dump, className).find((p) => p.name === name)?.valueType
          : undefined;
        return ok(await session.callBridge("setProperty", { ref, name, value, valueType }));
      })
    }
  ];
}
```

- [ ] **Step 4: Write `src/mcp/tools/remotes.ts`**

```ts
import { z } from "zod";
import type { Session } from "../session.js";
import { RobloxValueSchema } from "../../protocol.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function remoteTools(session: Session): ToolDef[] {
  const requireRemotes = () =>
    session.config.enableRemotes ? undefined : fail("remotes are disabled (DEX_MCP_ENABLE_REMOTES=false)");

  return [
    {
      name: "fire_remote",
      description: "Fire a RemoteEvent (FireServer) with the given arguments.",
      inputSchema: { ref: z.number().int(), args: z.array(RobloxValueSchema) },
      handler: guard(async ({ ref, args }) =>
        requireRemotes() ?? ok(await session.callBridge("fireRemote", { ref, args })))
    },
    {
      name: "invoke_remote",
      description: "Invoke a RemoteFunction (InvokeServer) with the given arguments and return its result.",
      inputSchema: { ref: z.number().int(), args: z.array(RobloxValueSchema) },
      handler: guard(async ({ ref, args }) =>
        requireRemotes() ?? ok(await session.callBridge("invokeRemote", { ref, args })))
    },
    {
      name: "remote_spy_start",
      description: "Start logging outgoing remote traffic. Returns an error if the executor lacks the required hooks.",
      inputSchema: { filter: z.string().optional() },
      handler: guard(async ({ filter }) =>
        requireRemotes() ?? ok(await session.callBridge("remoteSpyStart", { filter })))
    },
    {
      name: "remote_spy_stop",
      description: "Stop logging remote traffic.",
      inputSchema: {},
      handler: guard(async () => requireRemotes() ?? ok(await session.callBridge("remoteSpyStop", {})))
    },
    {
      name: "remote_spy_dump",
      description: "Return the remote traffic captured since the spy started.",
      inputSchema: {},
      handler: guard(async () => requireRemotes() ?? ok(await session.callBridge("remoteSpyDump", {})))
    }
  ];
}
```

- [ ] **Step 5: Write `src/mcp/tools/luau.ts`**

```ts
import { z } from "zod";
import type { Session } from "../session.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function luauTools(session: Session): ToolDef[] {
  return [
    {
      name: "run_luau",
      description: "Execute arbitrary Luau in the Roblox client and return captured output plus a best-effort serialized return value. Power tool.",
      inputSchema: { code: z.string() },
      handler: guard(async ({ code }) => {
        if (!session.config.enableRunLuau) return fail("run_luau is disabled (DEX_MCP_ENABLE_RUN_LUAU=false)");
        return ok(await session.callBridge("runLuau", { code }));
      })
    }
  ];
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/tools-actions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/write.ts src/mcp/tools/remotes.ts src/mcp/tools/luau.ts test/tools-actions.test.ts
git commit -m "feat: add write, remotes, and luau MCP tools"
```

---

## Task 11: Build the MCP server (register all tools)

**Files:**
- Create: `src/mcp/server.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { Session } from "../src/mcp/session.js";
import { allTools } from "../src/mcp/server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("allTools", () => {
  it("registers every documented tool exactly once", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const session = new Session(hub, config, undefined);
    const names = allTools(session).map((t) => t.name).sort();
    expect(names).toEqual([
      "dex_status", "fire_remote", "get_by_path", "get_children", "get_properties",
      "get_root", "get_source", "invoke_remote", "remote_spy_dump", "remote_spy_start",
      "remote_spy_stop", "run_luau", "search", "set_property"
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — cannot find module `../src/mcp/server.js`.

- [ ] **Step 3: Write `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "./session.js";
import type { ToolDef } from "./tools/types.js";
import { statusTools } from "./tools/status.js";
import { exploreTools } from "./tools/explore.js";
import { writeTools } from "./tools/write.js";
import { remoteTools } from "./tools/remotes.js";
import { luauTools } from "./tools/luau.js";

export function allTools(session: Session): ToolDef[] {
  return [
    ...statusTools(session),
    ...exploreTools(session),
    ...writeTools(session),
    ...remoteTools(session),
    ...luauTools(session)
  ];
}

export function buildServer(session: Session): McpServer {
  const server = new McpServer({ name: "dex-mcp", version: "0.1.0" });
  for (const tool of allTools(session)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      tool.handler
    );
  }
  return server;
}
```

> If the installed SDK rejects the raw-shape `inputSchema`, change `inputSchema: tool.inputSchema` here to `inputSchema: z.object(tool.inputSchema)` (import `z`) — this is the only place registration happens.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/server.test.ts
git commit -m "feat: assemble MCP server and register all tools"
```

---

## Task 12: Entry point wiring

**Files:**
- Create: `src/index.ts`
- Test: `test/index-smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import { Session } from "../src/mcp/session.js";
import { buildServer } from "../src/mcp/server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "t", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("buildServer", () => {
  it("constructs an McpServer without throwing", async () => {
    hub = new BridgeHub(config);
    await hub.start();
    const server = buildServer(new Session(hub, config, undefined));
    expect(server).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/index-smoke.test.ts`
Expected: PASS (buildServer already exists from Task 11). This test guards against regressions in server construction.

- [ ] **Step 3: Write `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { BridgeHub } from "./bridge-hub/ws-server.js";
import { getApiDump } from "./api-dump/fetch.js";
import { Session } from "./mcp/session.js";
import { buildServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const hub = new BridgeHub(config);
  const port = await hub.start();
  const dump = await getApiDump();

  // IMPORTANT: stdout is the MCP channel — all human-facing logging goes to stderr.
  const bridgeUrl = `ws://127.0.0.1:${port}?token=${config.token}`;
  process.stderr.write(`[dex-mcp] WebSocket hub on ${bridgeUrl}\n`);
  process.stderr.write(`[dex-mcp] Paste the bridge script into your executor and point it at this URL.\n`);
  process.stderr.write(`[dex-mcp] API dump: ${dump ? "loaded" : "unavailable (using curated fallback)"}\n`);

  const session = new Session(hub, config, dump);
  const server = buildServer(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[dex-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Build and run the smoke check manually**

Run: `npm run build`
Then: `node dist/index.js` (no agent attached)
Expected: stderr prints the three `[dex-mcp]` banner lines; the process stays alive waiting on stdio. Press Ctrl+C to exit. Confirm nothing is written to stdout.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (protocol, config, codec, rpc, ws-server, mock-bridge, properties, fetch, session, tools-explore, tools-actions, server, index-smoke).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index-smoke.test.ts
git commit -m "feat: wire entry point — stdio MCP server over WebSocket hub"
```

---

## Task 13: Finalize server README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Expand `README.md` with install and MCP client config**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document server install, config, and bridge handoff"
```

---

## Self-Review

**1. Spec coverage** (against `2026-06-07-dex-mcp-design.md`):
- §2 architecture (stdio + WS hub, correlation): Tasks 4, 5, 12 ✓
- §3 components table: every TS unit has a task ✓
- §4 RPC protocol + methods: `protocol.ts` constants (Task 1), exercised by mock bridge (Task 6) and tools (Tasks 9–10). `getByPath` included ✓
- §5 ref handles: server passes refs through; weak tables are bridge-side (Plan 2) — noted ✓
- §6 codec / tagged values: `protocol.ts` schemas + `codec.ts` (Tasks 1, 3) ✓
- §7 API dump hybrid: Tasks 7, 9 (`get_properties` cache-hit/miss flow) ✓
- §8 tool surface + scale guards: Tasks 9–11; `search` limit + `truncated` flag ✓
- §9 security (127.0.0.1 + token): Task 5 ✓
- §10 config flags: Task 2; enforced in Tasks 10 ✓
- §11 layout + mock-bridge testing: matches ✓
- Bridge-side items (§3 bridge row, §5 weak tables, §6 Luau codec) are **out of scope for this plan** — they belong to Plan 2 (Luau bridge). Noted in header.

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases" left; every code step contains complete code.

**3. Type consistency:** `Session.callBridge`, `cacheNodes`, `classNameFor` used consistently across Tasks 8–11. `ToolDef`/`ToolResult`/`ok`/`fail`/`guard` defined in Task 9 and reused in Task 10. RPC method strings match `RPC_METHODS` and the mock bridge's `handle` switch.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-07-dex-mcp-server.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks and fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints.

After this plan is green, the **Luau bridge plan** (`2026-06-07-dex-mcp-bridge.md`) implements the executor side against the same protocol.
