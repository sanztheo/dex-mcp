import { z } from "zod";
import type { Session } from "../session.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function luauTools(session: Session): ToolDef[] {
  return [
    {
      name: "run_luau",
      description: "Execute arbitrary Luau in the Roblox client and return captured output plus a best-effort serialized return value. Power tool.",
      inputSchema: { code: z.string() },
      handler: guard(async ({ code }) => {
        if (!session.config.enableRunLuau) return fail("run_luau is disabled (DEX_MCP_ENABLE_RUN_LUAU=false)");
        return ok(await session.callBridge("runLuau", { code }));
      })
    }
  ];
}
