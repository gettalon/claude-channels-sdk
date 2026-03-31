import { discover } from "../protocol.js";
import type { ToolDefinition } from "./types.js";

export const discoverTool: ToolDefinition = {
  name: "discover",
  description: "Find servers on network",
  inputSchema: { type: "object", properties: { source: { type: "string" } }, required: [] },
  handle: async (args) => {
    const r = await discover({ source: args.source as any });
    return JSON.stringify(r.length ? r : "No servers found", null, 2);
  },
};
