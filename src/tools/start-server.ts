/**
 * start_server tool — Start HTTP+WS server.
 */
import type { ToolDefinition } from "./types.js";

export const startServerTool: ToolDefinition = {
  name: "start_server",
  description: "Start HTTP+WS server",
  inputSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "Port to listen on (default: hub's defaultPort)" },
    },
    required: [],
  },
  handle: async (args, ctx) => {
    const port = args.port as number | undefined;
    const result = await ctx.hub.startServer(port);
    return JSON.stringify(result, null, 2);
  },
};
