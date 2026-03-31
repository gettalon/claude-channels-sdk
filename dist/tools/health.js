export const healthTool = {
    name: "health",
    description: "Show health status of servers and clients",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async (_args, ctx) => {
        return JSON.stringify(await ctx.hub.getHealth(), null, 2);
    },
};
//# sourceMappingURL=health.js.map