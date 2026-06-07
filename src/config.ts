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
    rpcTimeoutMs: parseInteger(env.DEX_MCP_RPC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}
