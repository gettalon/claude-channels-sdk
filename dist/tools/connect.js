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
        // Wait for register_ack (approvalGranted/Denied/Pending) before reading remoteInfo.
        // hub.connect() resolves after the WS handshake but before register_ack arrives.
        let remoteInfo;
        const ackPromise = new Promise((resolve) => {
            const onGranted = (ev) => {
                if (ev.url === url || ev.url?.includes(url.match(/:(\d+)/)?.[1] ?? "\x00")) {
                    remoteInfo = ev.info;
                    ctx.hub.off("approvalGranted", onGranted);
                    ctx.hub.off("approvalPending", onPending);
                    ctx.hub.off("approvalDenied", onDenied);
                    resolve();
                }
            };
            const onPending = (ev) => { onGranted(ev); };
            const onDenied = (ev) => { onGranted(ev); };
            ctx.hub.on("approvalGranted", onGranted);
            ctx.hub.on("approvalPending", onPending);
            ctx.hub.on("approvalDenied", onDenied);
        });
        await ctx.hub.connect(url, name, config);
        // Wait up to 3s for register_ack
        await Promise.race([ackPromise, new Promise(r => setTimeout(r, 3000))]);
        // Fall back to settings.json if event didn't fire (e.g. already connected)
        if (!remoteInfo) {
            const settings = await ctx.hub.loadSettings();
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
            remoteInfo = conn?.remoteInfo;
        }
        const result = { status: "connected", url };
        if (remoteInfo)
            result.remote = remoteInfo;
        return JSON.stringify(result, null, 2);
    },
};
//# sourceMappingURL=connect.js.map