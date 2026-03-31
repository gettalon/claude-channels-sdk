export const callToolTool = {
    name: "call_tool",
    description: "Call tool on remote agent",
    inputSchema: { type: "object", properties: { agent_id: { type: "string" }, tool_name: { type: "string" }, args: { type: "object" } }, required: ["agent_id", "tool_name"] },
    handle: async (args, ctx) => {
        const agentIdOrName = args.agent_id;
        const toolArgs = typeof args.args === "string" ? JSON.parse(args.args) : (args.args ?? {});
        // Try local agent first
        const agent = ctx.hub.findAgent(agentIdOrName);
        if (agent) {
            try {
                return JSON.stringify(await ctx.hub.callRemoteTool(agent.id, args.tool_name, toolArgs), null, 2);
            }
            catch (e) {
                return JSON.stringify({ error: String(e) });
            }
        }
        // Client mode: resolve agent via server's agent list, then proxy the call
        if (ctx.hub.isClient()) {
            try {
                const agents = await ctx.hub.listAgents();
                const match = agents.find(a => a.id === agentIdOrName || a.name === agentIdOrName);
                if (match) {
                    return JSON.stringify(await ctx.hub.callRemoteTool(match.id, args.tool_name, toolArgs), null, 2);
                }
            }
            catch (e) {
                return JSON.stringify({ error: String(e) });
            }
        }
        return JSON.stringify({ error: "Agent not found" });
    },
};
//# sourceMappingURL=call-tool.js.map