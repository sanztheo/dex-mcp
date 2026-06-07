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
