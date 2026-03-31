export const registerChannelTool = {
    name: "register_channel",
    description: "Register a new channel type",
    inputSchema: { type: "object", properties: { type: { type: "string" }, module: { type: "string" }, config: { type: "object" } }, required: ["type"] },
    handle: async (args, ctx) => {
        const type = args.type;
        const mod = args.module;
        const config = args.config ?? {};
        if (mod) {
            try {
                const m = await import(mod);
                const factory = m.default ?? m[`create${type.charAt(0).toUpperCase() + type.slice(1)}Channel`] ?? m.createChannel ?? m.createTransport;
                if (typeof factory === "function") {
                    const { registerChannel } = await import("../protocol.js");
                    registerChannel(type, factory);
                }
                else
                    return JSON.stringify({ error: `No factory in ${mod}` });
            }
            catch (e) {
                return JSON.stringify({ error: `Import failed: ${e}` });
            }
        }
        if (Object.keys(config).length) {
            const settings = await ctx.hub.loadSettings();
            settings.transports = settings.transports ?? {};
            settings.transports[type] = { ...(settings.transports[type] ?? {}), ...config };
            await ctx.hub.saveSettings(settings);
        }
        const { listChannels } = await import("../protocol.js");
        return JSON.stringify({ registered: type, available: listChannels() });
    },
};
//# sourceMappingURL=register-channel.js.map