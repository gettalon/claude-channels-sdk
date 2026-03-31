/**
 * Application-Level Channel Adapters as Transport Wrappers
 *
 * Wraps each application-level channel adapter (Discord, Slack, WhatsApp, etc.)
 * as a TransportAdapter so the edge agent can use them via:
 *   connect discord://<channel_id>
 *   connect slack://<channel_id>
 *   connect whatsapp://<jid>
 *   etc.
 *
 * Each wrapper:
 * - Uses the channel's ChannelServer for receiving messages (pushMessage -> onMessage)
 * - Sends messages via the channel's reply mechanism (send -> onReply)
 * - Registers as a channel type in the transport registry
 */
// ── Generic Transport wrapping a ChannelServer ──────────────────────────────
/**
 * A Transport that bridges ChannelServer bidirectional messaging
 * to the edge agent protocol.
 */
class AppChannelTransport {
    channelServer;
    chatId;
    type;
    _connected = true;
    onMessage;
    constructor(type, channelServer, chatId, onMessage) {
        this.channelServer = channelServer;
        this.chatId = chatId;
        this.type = type;
        this.onMessage = onMessage;
    }
    get connected() {
        return this._connected;
    }
    /** Feed a raw protocol message into this transport (from ChannelServer) */
    handleIncoming(msg) {
        this.onMessage?.(msg);
    }
    /** Send a protocol message out through the ChannelServer */
    async send(message) {
        if (!this._connected)
            throw new Error("Not connected");
        const msg = message;
        // Silent protocol messages — don't relay to the chat platform
        const silentTypes = [
            "heartbeat",
            "heartbeat_ack",
            "ack",
            "register",
            "register_ack",
        ];
        if (silentTypes.includes(msg.type))
            return;
        // Chat/reply messages: push text through the ChannelServer's reply path
        if (msg.type === "chat" || msg.type === "reply") {
            const text = msg.content ?? msg.text ?? "";
            const from = msg.from ? `[${msg.from}] ` : "";
            // Emit as a reply through the ChannelServer (triggers onReply handlers)
            this.channelServer.emit("reply", this.chatId, `${from}${text}`);
            return;
        }
        // Other protocol messages: serialize as JSON and send as text
        this.channelServer.emit("reply", this.chatId, JSON.stringify(message));
    }
    async close() {
        this._connected = false;
    }
}
/**
 * Generic TransportAdapter that wraps any application-level channel.
 *
 * - listen(): starts the channel, routes incoming messages to new transports
 * - connect(): starts the channel, creates a transport bound to a specific chat
 * - close(): cleans up the channel
 */
class AppChannelAdapter {
    factory;
    config;
    type;
    setup = null;
    transports = new Map();
    connectionHandler = null;
    constructor(type, factory, config) {
        this.factory = factory;
        this.config = config;
        this.type = type;
    }
    async ensureChannel() {
        if (!this.setup) {
            this.setup = await this.factory(this.config);
            // Wire up the ChannelServer's pushMessage notifications.
            // When the channel receives an inbound message, the ChannelServer emits
            // a "hookEvent" or pushes a notification. We listen for the internal
            // message events to route them to the appropriate transport.
            const cs = this.setup.channel;
            // The ChannelServer's onReply is used for outbound. For inbound, the
            // channel adapters call cs.pushMessage(content, meta) which sends MCP
            // notifications. We intercept by listening to the 'reply' event that
            // our AppChannelTransport emits through the ChannelServer.
            // But for receiving messages FROM the platform INTO the transport, we
            // need to hook into the channel's message flow.
            // Override pushMessage to also route to our transports
            const originalPushMessage = cs.pushMessage.bind(cs);
            cs.pushMessage = async (content, meta, sessionId) => {
                // Still push to MCP sessions
                await originalPushMessage(content, meta, sessionId);
                // Also route to our edge agent transports
                const chatId = meta?.chat_id ?? "default";
                const from = meta?.user ?? "unknown";
                const protocolMsg = {
                    type: "chat",
                    chat_id: chatId,
                    content,
                    from,
                    meta,
                };
                // Route to existing transport or create new one (server mode)
                let transport = this.transports.get(chatId);
                if (!transport && this.connectionHandler) {
                    // Server mode: new chat -> new transport
                    transport = new AppChannelTransport(this.type, cs, chatId);
                    this.transports.set(chatId, transport);
                    this.connectionHandler(transport);
                }
                if (transport) {
                    transport.handleIncoming(protocolMsg);
                }
            };
            // Wire the reply event so AppChannelTransport.send() triggers the
            // channel's registered onReply handler
            // (The channel adapters already call channel.onReply() to set up
            //  their outbound path, so we just need the event to flow through.)
        }
        return this.setup;
    }
    /** Server mode: start channel, route incoming messages to transports */
    async listen(_port, handler) {
        this.connectionHandler = handler;
        await this.ensureChannel();
    }
    /** Client mode: connect to a specific chat via the channel */
    async connect(url, handler) {
        const setup = await this.ensureChannel();
        // Parse URL: "discord://<chat_id>" or just "<chat_id>"
        const prefix = `${this.type}://`;
        const chatId = url.startsWith(prefix) ? url.slice(prefix.length) : url;
        const transport = new AppChannelTransport(this.type, setup.channel, chatId, handler);
        this.transports.set(chatId, transport);
        return transport;
    }
    async close() {
        for (const t of this.transports.values()) {
            await t.close().catch(() => { });
        }
        this.transports.clear();
        if (this.setup) {
            this.setup.cleanup();
            this.setup = null;
        }
    }
}
// ── Channel-specific adapter factories ──────────────────────────────────────
export function createDiscordTransport(config = {}) {
    return new AppChannelAdapter("discord", async (cfg) => {
        const { createDiscordChannel } = await import("../channels/discord.js");
        return createDiscordChannel(cfg);
    }, config);
}
export function createSlackTransport(config = {}) {
    return new AppChannelAdapter("slack", async (cfg) => {
        const { createSlackChannel } = await import("../channels/slack.js");
        return createSlackChannel(cfg);
    }, config);
}
export function createWhatsAppTransport(config = {}) {
    return new AppChannelAdapter("whatsapp", async (cfg) => {
        const { createWhatsAppChannel } = await import("../channels/whatsapp.js");
        return createWhatsAppChannel(cfg);
    }, config);
}
export function createMatrixTransport(config = {}) {
    return new AppChannelAdapter("matrix", async (cfg) => {
        const { createMatrixChannel } = await import("../channels/matrix.js");
        return createMatrixChannel(cfg);
    }, config);
}
export function createSignalTransport(config = {}) {
    return new AppChannelAdapter("signal", async (cfg) => {
        const { createSignalChannel } = await import("../channels/signal.js");
        return createSignalChannel(cfg);
    }, config);
}
export function createIrcTransport(config = {}) {
    return new AppChannelAdapter("irc", async (cfg) => {
        const { createIrcChannel } = await import("../channels/irc.js");
        return createIrcChannel(cfg);
    }, config);
}
export function createLineTransport(config = {}) {
    return new AppChannelAdapter("line", async (cfg) => {
        const { createLineChannel } = await import("../channels/line.js");
        return createLineChannel(cfg);
    }, config);
}
export function createFeishuTransport(config = {}) {
    return new AppChannelAdapter("feishu", async (cfg) => {
        const { createFeishuChannel } = await import("../channels/feishu.js");
        return createFeishuChannel(cfg);
    }, config);
}
export function createMsTeamsTransport(config = {}) {
    return new AppChannelAdapter("msteams", async (cfg) => {
        const { createTeamsChannel } = await import("../channels/msteams.js");
        return createTeamsChannel(cfg);
    }, config);
}
export function createIMessageTransport(config = {}) {
    return new AppChannelAdapter("imessage", async (cfg) => {
        const { createIMessageChannel } = await import("../channels/imessage.js");
        return createIMessageChannel(cfg);
    }, config);
}
//# sourceMappingURL=app-channels.js.map