export const reloadTool = {
    name: "reload",
    description: "Reload and verify config",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async (_args, ctx) => {
        const r = await ctx.hub.reload();
        try {
            await ctx.mcp.notification({ method: "notifications/tools/list_changed" });
        }
        catch { }
        return JSON.stringify(r, null, 2);
    },
};
//# sourceMappingURL=reload.js.map