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
