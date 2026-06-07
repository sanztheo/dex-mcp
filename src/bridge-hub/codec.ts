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
