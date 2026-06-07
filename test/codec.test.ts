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
