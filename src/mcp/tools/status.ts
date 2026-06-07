import type { Session } from "../session.js";
import { guard, ok, type ToolDef } from "./types.js";

export function statusTools(session: Session): ToolDef[] {
  return [
    {
      name: "dex_status",
      description: "Report whether the Roblox bridge is connected and basic game info (name, placeId, client version, capabilities).",
      inputSchema: {},
      handler: guard(async () => ok(await session.callBridge("status", {})))
    }
  ];
}
