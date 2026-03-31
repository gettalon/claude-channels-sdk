/**
 * status tool — Show hub status.
 */
import type { ToolDefinition } from "./types.js";

export const statusTool: ToolDefinition = {
  name: "status",
  description: "Show hub status summary",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async (_args, ctx) => {
    const status = await Promise.resolve(ctx.hub.getStatus());
    return JSON.stringify(status, null, 2);
  },
};
