import type { z } from "zod";

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<ToolResult>;
}

export function ok(structured: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured as Record<string, unknown>
  };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Wraps a handler so bridge/transport errors become tool errors instead of throwing.
export function guard(fn: (args: any) => Promise<ToolResult>): (args: any) => Promise<ToolResult> {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}
