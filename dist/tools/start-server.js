export const startServerTool = {
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
        const hub = ctx.hub;
        const port = args.port ?? hub.defaultPort;
        // Register WS server entry in settings so autoSetup starts it on next boot
        const settings = await hub.loadSettings();
        const servers = settings.servers ?? [];
        const wsUrl = `ws://0.0.0.0:${port}`;
        if (!servers.some((s) => s.url === wsUrl)) {
            servers.push({ url: wsUrl, name: hub.name, port, type: "ws" });
            settings.servers = servers;
            await hub.saveSettings(settings);
        }
        // If unix already running, start HTTP+WS directly
        if (hub.servers?.has(`unix:${port}`) && !hub.servers?.has(`ws:${port}`)) {
            try {
                await hub.startHttpWs(port);
                return JSON.stringify({ port, ws: true });
            }
            catch (e) {
                return JSON.stringify({ error: e?.message ?? String(e) });
            }
        }
        const result = await hub.startServer(port, { http: true });
        return JSON.stringify(result, null, 2);
    },
};
//# sourceMappingURL=start-server.js.map