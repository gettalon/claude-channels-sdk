export const listChannelsTool = {
    name: "list_channels",
    description: "List available channels",
    inputSchema: { type: "object", properties: {}, required: [] },
    handle: async () => {
        const { listChannels } = await import("../protocol.js");
        return JSON.stringify(listChannels(), null, 2);
    },
};
//# sourceMappingURL=list-channels.js.map