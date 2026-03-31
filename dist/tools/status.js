export const statusTool = {
    name: "status",
    description: "Show hub status summary",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async (_args, ctx) => {
        const status = await Promise.resolve(ctx.hub.getStatus());
        return JSON.stringify(status, null, 2);
    },
};
//# sourceMappingURL=status.js.map