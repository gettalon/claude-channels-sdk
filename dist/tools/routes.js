export const routesTool = {
    name: "routes",
    description: "Show chat routes (agent assignments)",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async (_args, ctx) => {
        if (ctx.hub.isClient()) {
            return "Routes are managed by the server. Use this command on the server instance.";
        }
        const routes = [...ctx.hub.chatRoutes.entries()].map(([chatId, agentId]) => ({
            chatId, agentId, agentName: ctx.hub.agents.get(agentId)?.name ?? "unknown"
        }));
        return JSON.stringify(routes.length ? routes : "No chat routes", null, 2);
    },
};
//# sourceMappingURL=routes.js.map