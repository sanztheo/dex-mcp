import { describe, it, expect } from "vitest";
import { assembleBridge } from "../src/bridge-hub/bridge-loader.js";

describe("assembleBridge", () => {
  it("inlines codec+core and substitutes port and token", () => {
    const out = assembleBridge(12345, "secret-token");
    // markers gone
    expect(out).not.toContain("__DEX_MAKECODEC__");
    expect(out).not.toContain("__DEX_MAKECORE__");
    expect(out).not.toContain("__DEX_PORT__");
    expect(out).not.toContain("__DEX_TOKEN__");
    // substitutions present
    expect(out).toContain("local PORT = 12345");
    expect(out).toContain('local TOKEN = "secret-token"');
    // factories inlined as IIFEs assigned to makeCodec/makeCore
    expect(out).toContain("local makeCodec = (function()");
    expect(out).toContain("local makeCore = (function()");
    // codec/core bodies are present (sentinel substrings)
    expect(out).toContain("Codec.encode");
    expect(out).toContain("Core.dispatch");
  });

  it("escapes a token containing a quote safely", () => {
    const out = assembleBridge(1, 'a"b');
    expect(out).toContain('local TOKEN = "a\\"b"');
  });
});
