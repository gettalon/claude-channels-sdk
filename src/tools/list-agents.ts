import type { ToolDefinition } from "./types.js";

export const listAgentsTool: ToolDefinition = {
  name: "list_agents",
  description: "List connected agents (WebSocket)",
  inputSchema: { type: "object", properties: {}, required: [] },
  handle: async (_args, ctx) => {
    const l = await Promise.resolve(ctx.hub.listAgents());
    return JSON.stringify(l.length ? l : "No agents", null, 2);
  },
};
