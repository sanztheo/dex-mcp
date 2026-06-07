import { z } from "zod";
import type { Session } from "../session.js";
import { RobloxValueSchema } from "../../protocol.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function remoteTools(session: Session): ToolDef[] {
  const requireRemotes = () =>
    session.config.enableRemotes ? undefined : fail("remotes are disabled (DEX_MCP_ENABLE_REMOTES=false)");

  return [
    {
      name: "fire_remote",
      description: "Fire a RemoteEvent (FireServer) with the given arguments.",
      inputSchema: { ref: z.number().int(), args: z.array(RobloxValueSchema) },
      handler: guard(async ({ ref, args }) =>
        requireRemotes() ?? ok(await session.callBridge("fireRemote", { ref, args })))
    },
    {
      name: "invoke_remote",
      description: "Invoke a RemoteFunction (InvokeServer) with the given arguments and return its result.",
      inputSchema: { ref: z.number().int(), args: z.array(RobloxValueSchema) },
      handler: guard(async ({ ref, args }) =>
        requireRemotes() ?? ok(await session.callBridge("invokeRemote", { ref, args })))
    },
    {
      name: "remote_spy_start",
      description: "Start logging outgoing remote traffic. Returns an error if the executor lacks the required hooks.",
      inputSchema: { filter: z.string().optional() },
      handler: guard(async ({ filter }) =>
        requireRemotes() ?? ok(await session.callBridge("remoteSpyStart", { filter })))
    },
    {
      name: "remote_spy_stop",
      description: "Stop logging remote traffic.",
      inputSchema: {},
      handler: guard(async () => requireRemotes() ?? ok(await session.callBridge("remoteSpyStop", {})))
    },
    {
      name: "remote_spy_dump",
      description: "Return the remote traffic captured since the spy started.",
      inputSchema: {},
      handler: guard(async () => requireRemotes() ?? ok(await session.callBridge("remoteSpyDump", {})))
    }
  ];
}
