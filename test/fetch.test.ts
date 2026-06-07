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
