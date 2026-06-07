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
