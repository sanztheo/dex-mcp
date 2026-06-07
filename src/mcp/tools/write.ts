import { z } from "zod";
import type { Session } from "../session.js";
import { RobloxValueSchema } from "../../protocol.js";
import { propertiesForClass } from "../../api-dump/properties.js";
import { fail, guard, ok, type ToolDef } from "./types.js";

export function writeTools(session: Session): ToolDef[] {
  return [
    {
      name: "set_property",
      description: "Set a property on an instance by ref. The value is coerced to the property's declared Roblox type when known.",
      inputSchema: { ref: z.number().int(), name: z.string(), value: RobloxValueSchema },
      handler: guard(async ({ ref, name, value }) => {
        if (!session.config.enableWrite) return fail("set_property is disabled (DEX_MCP_ENABLE_WRITE=false)");
        const className = session.classNameFor(ref);
        const valueType = session.dump && className
          ? propertiesForClass(session.dump, className).find((p) => p.name === name)?.valueType
          : undefined;
        return ok(await session.callBridge("setProperty", { ref, name, value, valueType }));
      })
    }
  ];
}
