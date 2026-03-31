export const sendMessageTool = {
    name: "send_message",
    description: "Send message to a connected agent via hub WebSocket (agent-to-agent)",
    inputSchema: { type: "object", properties: {
            agent_id: { type: "string" },
            content: { type: "string" },
            format: { type: "string", enum: ["text", "markdown", "html"] },
            files: { type: "array", items: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, data: { type: "string" }, url: { type: "string" }, mime: { type: "string" } }, required: ["name"] } },
            buttons: { type: "array", items: { type: "object", properties: { text: { type: "string" }, action: { type: "string" }, url: { type: "string" } }, required: ["text"] } },
            reply_to: { type: "string" },
        }, required: ["content"] },
    handle: async (args, ctx) => {
        const rich = {};
        if (args.format)
            rich.format = args.format;
        if (args.files)
            rich.files = args.files;
        if (args.buttons)
            rich.buttons = args.buttons;
        if (args.reply_to)
            rich.reply_to = args.reply_to;
        if (args.tts)
            rich.meta = { ...rich.meta, tts: "true", tts_voice: args.tts_voice };
        const r = ctx.hub.sendMessage(args.agent_id, args.content, Object.keys(rich).length ? rich : undefined);
        return JSON.stringify(r.ok ? "sent" : r, null, 2);
    },
};
//# sourceMappingURL=send-message.js.map