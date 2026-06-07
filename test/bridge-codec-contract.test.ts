import { describe, it, expect } from "vitest";
import { RobloxValueSchema, TaggedValueSchema } from "../src/protocol.js";

// Canonical tagged values the Luau bridge produces (must match bridge/codec.luau encode()).
const CANONICAL: Record<string, unknown> = {
  number: 42,
  string: "hi",
  boolean: true,
  Vector3: { __t: "Vector3", x: 1, y: 2, z: 3 },
  Vector2: { __t: "Vector2", x: 1, y: 2 },
  CFrame: { __t: "CFrame", components: [0,0,0, 1,0,0, 0,1,0, 0,0,1] },
  Color3: { __t: "Color3", r: 1, g: 0, b: 0 },
  BrickColor: { __t: "BrickColor", name: "Bright red" },
  UDim: { __t: "UDim", scale: 0, offset: 100 },
  UDim2: { __t: "UDim2", x: { scale: 0, offset: 100 }, y: { scale: 0, offset: 50 } },
  EnumItem: { __t: "EnumItem", enum: "Material", name: "Plastic", value: 256 },
  Instance: { __t: "Instance", ref: 7, path: "game.Workspace.Part", class: "Part" },
  Unsupported: { __t: "Unsupported", repr: "Axes" },
};

describe("bridge codec wire contract", () => {
  for (const [name, value] of Object.entries(CANONICAL)) {
    it(`RobloxValueSchema accepts the bridge's ${name} shape`, () => {
      expect(() => RobloxValueSchema.parse(value)).not.toThrow();
    });
  }

  it("rejects an Instance shape using className instead of class", () => {
    // guards against the easy mistake — Node uses className, tagged Instance uses class
    expect(() => TaggedValueSchema.parse({ __t: "Instance", ref: 1, path: "x", className: "Part" })).toThrow();
  });

  it("rejects a CFrame with wrong component count", () => {
    expect(() => TaggedValueSchema.parse({ __t: "CFrame", components: [1, 2, 3] })).toThrow();
  });
});
