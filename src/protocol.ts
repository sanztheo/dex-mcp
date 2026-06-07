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
