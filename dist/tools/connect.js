export const connectTool = {
    name: "connect",
    description: "Connect via ws://, unix://, telegram://, or auto:// (auto-selects best transport for local connections)",
    inputSchema: {
        type: "object",
        properties: {
            url: { type: "string", description: "Connection URL" },
            name: { type: "string", description: "Optional connection name" },
            channel: { type: "string", description: "Channel type hint" },
            config: { type: "object", description: "Per-connection config (e.g. {botToken: '...'} for Telegram)" },
        },
        required: ["url"],
    },
    handle: async (args, ctx) => {
        const url = args.url;
        const name = args.name;
        const config = args.config;
        await ctx.hub.connect(url, name, config);
        // Return cached remote info if available (may be set by the connect handler)
        const settings = await ctx.hub.loadSettings();
        // The connect() method resolves URLs (e.g. auto:// -> unix://), so match
        // by port extracted from the original URL against stored connections
        const port = url.match(/:(\d+)/)?.[1];
        const conn = (settings.connections ?? []).find((c) => {
            if (c.url === url)
                return true;
            if (port && c.url?.includes(port))
                return true;
            if (name && c.name === name)
                return true;
            return false;
        });
        const result = { status: "connected", url };
        if (conn?.remoteInfo)
            result.remote = conn.remoteInfo;
        return JSON.stringify(result, null, 2);
    },
};
//# sourceMappingURL=connect.js.map