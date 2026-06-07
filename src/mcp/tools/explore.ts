import { z } from "zod";
import type { Session } from "../session.js";
import type { Node } from "../../protocol.js";
import { propertiesForClass } from "../../api-dump/properties.js";
import { guard, ok, type ToolDef } from "./types.js";

const DEFAULT_SEARCH_LIMIT = 100;

export function exploreTools(session: Session): ToolDef[] {
  return [
    {
      name: "get_root",
      description: "Get the root instance (game, ref 0) and its top-level services.",
      inputSchema: {},
      handler: guard(async () => {
        const result = (await session.callBridge("getRoot", {})) as { node: Node; services: Node[] };
        session.cacheNodes([result.node, ...result.services]);
        return ok(result);
      })
    },
    {
      name: "get_children",
      description: "List the direct children of an instance by ref. Optionally filter by className.",
      inputSchema: { ref: z.number().int(), classFilter: z.string().optional() },
      handler: guard(async ({ ref, classFilter }) => {
        const children = (await session.callBridge("getChildren", { ref, classFilter })) as Node[];
        session.cacheNodes(children);
        return ok({ children });
      })
    },
    {
      name: "get_properties",
      description: "Read the properties of an instance by ref. Property names come from the cached Roblox API dump when available.",
      inputSchema: { ref: z.number().int() },
      handler: guard(async ({ ref }) => {
        let className = session.classNameFor(ref);
        if (className === undefined || !session.dump) {
          const discovered = (await session.callBridge("getProperties", { ref })) as { className: string; properties: Record<string, unknown> };
          if (!session.dump) return ok(discovered);
          className = discovered.className;
        }
        const propertyNames = propertiesForClass(session.dump, className).map((p) => p.name);
        const result = await session.callBridge("getProperties", { ref, propertyNames });
        return ok(result);
      })
    },
    {
      name: "search",
      description: "Recursively search instances by name substring (and optional className), capped by limit. Defaults to 100 results.",
      inputSchema: {
        query: z.string(),
        root: z.number().int().optional(),
        classFilter: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        maxDepth: z.number().int().positive().optional()
      },
      handler: guard(async ({ query, root, classFilter, limit, maxDepth }) => {
        const results = (await session.callBridge("search", {
          rootRef: root ?? 0, query, classFilter, limit: limit ?? DEFAULT_SEARCH_LIMIT, maxDepth
        })) as Node[];
        session.cacheNodes(results);
        return ok({ results, limit: limit ?? DEFAULT_SEARCH_LIMIT, truncated: results.length >= (limit ?? DEFAULT_SEARCH_LIMIT) });
      })
    },
    {
      name: "get_source",
      description: "Read the Source of a Script/LocalScript/ModuleScript by ref, if readable.",
      inputSchema: { ref: z.number().int() },
      handler: guard(async ({ ref }) => ok(await session.callBridge("getSource", { ref })))
    },
    {
      name: "get_by_path",
      description: "Resolve a dotted instance path (e.g. game.Workspace.Part) to a node with a ref.",
      inputSchema: { path: z.string() },
      handler: guard(async ({ path }) => {
        const node = (await session.callBridge("getByPath", { path })) as Node;
        session.cacheNodes([node]);
        return ok(node);
      })
    }
  ];
}
